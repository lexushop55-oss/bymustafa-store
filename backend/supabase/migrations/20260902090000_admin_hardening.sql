-- =============================================================================
-- DentaLine Platform · hardening суперадмин-слоя:
--   1) серверный счётчик rate limit для impersonate / reconnect;
--   2) архивация и retention append-only аудита (90 дней hot / 18 мес archive);
--   3) расписание pg_cron для обслуживания.
-- Идемпотентно: безопасно применять повторно.
-- Применение:  supabase db push
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rate limiting. Один счётчик на все изоляты Edge Functions.
--    Пишет только service_role через SECURITY DEFINER функцию.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_rate_limits (
  key           text primary key,
  window_start  timestamptz not null default now(),
  hits          integer     not null default 0,
  last_hit_at   timestamptz not null default now()
);

create index if not exists admin_rate_limits_window_idx
  on public.admin_rate_limits (window_start);

alter table public.admin_rate_limits enable row level security;
revoke all on public.admin_rate_limits from anon, authenticated;

/*
 * Атомарный «взять слот»: проверка + инкремент в одной транзакции под row-lock,
 * иначе два параллельных вызова из разных изолятов пройдут оба.
 * Возвращает { allowed, retry_after, hits, max }.
 */
create or replace function public.admin_rate_limit_hit(
  p_key                    text,
  p_max                    integer,
  p_window_seconds         integer,
  p_min_interval_seconds   integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window   interval := make_interval(secs => greatest(p_window_seconds, 1));
  v_min_gap  interval := make_interval(secs => greatest(coalesce(p_min_interval_seconds, 0), 0));
  v_row      public.admin_rate_limits;
  v_retry    integer;
begin
  if p_key is null or length(trim(p_key)) = 0 then
    raise exception 'rate limit key is required' using errcode = '22023';
  end if;

  -- upsert + FOR UPDATE: строка гарантированно существует и заблокирована.
  insert into public.admin_rate_limits (key, window_start, hits, last_hit_at)
  values (p_key, now(), 0, now() - v_window)
  on conflict (key) do nothing;

  select * into v_row from public.admin_rate_limits where key = p_key for update;

  -- Окно истекло — начинаем новое.
  if now() - v_row.window_start >= v_window then
    v_row.window_start := now();
    v_row.hits := 0;
  end if;

  -- Минимальный интервал между вызовами (антидребезг/антиспам кнопки).
  if v_min_gap > interval '0' and now() - v_row.last_hit_at < v_min_gap then
    v_retry := greatest(1, ceil(extract(epoch from (v_row.last_hit_at + v_min_gap - now())))::int);
    return jsonb_build_object('allowed', false, 'retry_after', v_retry, 'reason', 'min_interval',
                              'hits', v_row.hits, 'max', p_max);
  end if;

  -- Лимит на окно.
  if v_row.hits >= p_max then
    v_retry := greatest(1, ceil(extract(epoch from (v_row.window_start + v_window - now())))::int);
    return jsonb_build_object('allowed', false, 'retry_after', v_retry, 'reason', 'window_limit',
                              'hits', v_row.hits, 'max', p_max);
  end if;

  update public.admin_rate_limits
     set window_start = v_row.window_start,
         hits         = v_row.hits + 1,
         last_hit_at  = now()
   where key = p_key;

  return jsonb_build_object('allowed', true, 'retry_after', 0,
                            'hits', v_row.hits + 1, 'max', p_max);
end $$;

revoke all on function public.admin_rate_limit_hit(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_rate_limit_hit(text, integer, integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 2. Retention аудита.
--    admin_audit_logs остаётся append-only и «горячим» (90 дней по умолчанию).
--    Старше — переезжает в admin_audit_logs_archive (та же структура, без FK,
--    чтобы удаление клиники не рушило историю), оттуда удаляется через 540 дней.
-- -----------------------------------------------------------------------------
create table if not exists public.admin_audit_logs_archive (
  id               bigint primary key,
  actor_id         uuid,
  actor_email      text,
  action           text not null,
  target_tenant_id uuid,
  payload          jsonb not null default '{}'::jsonb,
  result           text  not null default 'ok',
  ip               text,
  user_agent       text,
  created_at       timestamptz not null,
  archived_at      timestamptz not null default now()
);

create index if not exists admin_audit_archive_created_idx
  on public.admin_audit_logs_archive (created_at desc);
create index if not exists admin_audit_archive_tenant_idx
  on public.admin_audit_logs_archive (target_tenant_id, created_at desc);

alter table public.admin_audit_logs_archive enable row level security;
revoke all on public.admin_audit_logs_archive from anon, authenticated;

-- Суперадмин может читать архив (для расследований), писать — только функция.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'admin_audit_logs_archive'
       and policyname = 'audit_archive_superadmin_read'
  ) then
    create policy audit_archive_superadmin_read on public.admin_audit_logs_archive
      for select to authenticated using (public.is_superadmin());
  end if;
end $$;

/*
 * Обслуживание журналов. Батчами, чтобы не держать длинную транзакцию
 * и не пухнуть WAL на больших объёмах.
 *   p_hot_days     — сколько дней аудит живёт в основной таблице (90 / 180);
 *   p_archive_days — сколько дней хранится архив, затем удаляется (0 = не удалять);
 *   p_probe_days   — retention для health_probe_log (метрики, не аудит);
 *   p_batch        — размер батча.
 * Возвращает { archived, purged, probes_deleted, limits_deleted }.
 */
create or replace function public.admin_audit_prune(
  p_hot_days     integer default 90,
  p_archive_days integer default 540,
  p_probe_days   integer default 30,
  p_batch        integer default 20000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff   timestamptz := now() - make_interval(days => greatest(p_hot_days, 1));
  v_archived bigint := 0;
  v_purged   bigint := 0;
  v_probes   bigint := 0;
  v_limits   bigint := 0;
  v_moved    bigint;
begin
  -- 2.1 Перенос горячих логов в архив батчами.
  loop
    with victims as (
      select id from public.admin_audit_logs
       where created_at < v_cutoff
       order by id
       limit greatest(p_batch, 1)
       for update skip locked
    ), moved as (
      delete from public.admin_audit_logs a
       using victims v
       where a.id = v.id
      returning a.*
    )
    insert into public.admin_audit_logs_archive
      (id, actor_id, actor_email, action, target_tenant_id, payload, result, ip, user_agent, created_at)
    select id, actor_id, actor_email, action, target_tenant_id, payload, result, ip, user_agent, created_at
      from moved
    on conflict (id) do nothing;

    get diagnostics v_moved = row_count;
    v_archived := v_archived + v_moved;
    exit when v_moved = 0;
  end loop;

  -- 2.2 Удаление из архива по сроку хранения.
  if coalesce(p_archive_days, 0) > 0 then
    delete from public.admin_audit_logs_archive
     where created_at < now() - make_interval(days => p_archive_days);
    get diagnostics v_purged = row_count;
  end if;

  -- 2.3 История health-проб: чистые метрики, хранить долго смысла нет.
  if coalesce(p_probe_days, 0) > 0 then
    delete from public.health_probe_log
     where created_at < now() - make_interval(days => p_probe_days);
    get diagnostics v_probes = row_count;
  end if;

  -- 2.4 Мусор счётчиков rate limit.
  delete from public.admin_rate_limits
   where window_start < now() - interval '1 day';
  get diagnostics v_limits = row_count;

  return jsonb_build_object(
    'archived', v_archived,
    'purged', v_purged,
    'probes_deleted', v_probes,
    'limits_deleted', v_limits,
    'hot_days', p_hot_days,
    'archive_days', p_archive_days,
    'ran_at', now()
  );
end $$;

revoke all on function public.admin_audit_prune(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_audit_prune(integer, integer, integer, integer) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Расписание. pg_cron есть в Supabase, но включён не всегда —
--    поэтому блок мягкий: без расширения миграция не падает.
--    Ручной запуск:  select public.admin_audit_prune(90, 540);
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension pg_cron;
    exception when others then
      raise notice 'pg_cron недоступен (%). Планировщик не создан — вызывайте admin_audit_prune() из внешнего cron.', sqlerrm;
    end;
  end if;

  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Пересоздаём задание идемпотентно.
    perform cron.unschedule(jobid) from cron.job where jobname = 'admin_audit_prune_nightly';
    perform cron.schedule(
      'admin_audit_prune_nightly',
      '25 3 * * *',                                   -- каждую ночь 03:25 UTC
      $cron$select public.admin_audit_prune(90, 540, 30);$cron$
    );
  end if;
end $$;

comment on function public.admin_audit_prune(integer, integer, integer, integer) is
  'Архивация admin_audit_logs старше N дней + retention архива/метрик. Запускается pg_cron: admin_audit_prune_nightly.';
comment on function public.admin_rate_limit_hit(text, integer, integer, integer) is
  'Атомарный счётчик rate limit для admin-эндпоинтов (impersonate, reconnect).';
