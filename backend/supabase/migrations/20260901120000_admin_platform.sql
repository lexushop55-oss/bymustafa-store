-- =============================================================================
-- DentaLine Platform · суперадмин-слой: роли, аудит, интеграции, очереди.
-- Идемпотентная миграция: безопасно применять на существующей базе.
-- Применение:  supabase db push   (или psql -f этот файл)
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- 1. Тенанты (клиники). Создаётся только если таблицы ещё нет —
--    на живой базе блок пропускается и используется существующая схема.
-- -----------------------------------------------------------------------------
create table if not exists public.tenants (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique,
  plan         text not null default 'Starter',
  status       text not null default 'Trial'
                 check (status in ('Active','Trial','Pending','Suspended','Inactive')),
  owner_id     uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.tenant_members (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'Manager' check (role in ('Owner','Admin','Manager')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

-- -----------------------------------------------------------------------------
-- 2. Роли платформы. Суперадмин — ТОЛЬКО запись в этой таблице,
--    никогда не поле в JWT, которое можно подделать на клиенте.
-- -----------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'superadmin' check (role in ('superadmin','support')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Хелпер для RLS и middleware. SECURITY DEFINER, чтобы политика могла читать
-- platform_admins, не открывая таблицу наружу. search_path зафиксирован.
create or replace function public.is_superadmin(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins pa
    where pa.user_id = uid and pa.is_active and pa.role = 'superadmin'
  );
$$;

revoke all on function public.is_superadmin(uuid) from public;
grant execute on function public.is_superadmin(uuid) to authenticated, service_role;

-- Пинг БД для health-check: дешёвый round-trip без чтения данных.
create or replace function public.db_ping()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('ok', true, 'server_time', now());
$$;

grant execute on function public.db_ping() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Интеграции тенанта (WhatsApp Cloud API / Telegram Bot API).
--    Сами токены НЕ храним в таблице — только ссылку на секрет в Vault.
-- -----------------------------------------------------------------------------
create table if not exists public.tenant_integrations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  type            text not null check (type in ('whatsapp','telegram')),
  status          text not null default 'not_configured'
                    check (status in ('ok','degraded','down','not_configured')),
  external_id     text,                      -- WhatsApp phone_number_id / Telegram bot id
  webhook_url     text,
  secret_ref      text,                      -- имя секрета в vault.secrets
  last_check_at   timestamptz,
  last_latency_ms integer,
  last_error      text,
  verified_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, type)
);

create index if not exists tenant_integrations_status_idx
  on public.tenant_integrations (status) where status <> 'ok';

-- -----------------------------------------------------------------------------
-- 4. Журнал действий суперадмина. Append-only: update/delete запрещены
--    политиками, писать может только service_role (Edge Function).
-- -----------------------------------------------------------------------------
create table if not exists public.admin_audit_logs (
  id               bigserial primary key,
  actor_id         uuid references auth.users(id) on delete set null,
  actor_email      text,
  action           text not null,             -- 'impersonate' | 'reconnect_integration' | 'change_plan' | ...
  target_tenant_id uuid references public.tenants(id) on delete set null,
  payload          jsonb not null default '{}'::jsonb,
  result           text not null default 'ok' check (result in ('ok','error')),
  ip               inet,
  user_agent       text,
  created_at       timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);
create index if not exists admin_audit_logs_tenant_idx  on public.admin_audit_logs (target_tenant_id, created_at desc);
create index if not exists admin_audit_logs_action_idx  on public.admin_audit_logs (action, created_at desc);

-- -----------------------------------------------------------------------------
-- 5. Очереди фоновых задач (исходящие сообщения, AI-ответы, напоминания).
-- -----------------------------------------------------------------------------
create table if not exists public.integration_jobs (
  id            bigserial primary key,
  tenant_id     uuid references public.tenants(id) on delete cascade,
  queue         text not null,               -- 'wa_out' | 'ai_replies' | 'reminders'
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'pending'
                  check (status in ('pending','processing','done','failed','dead')),
  attempts      smallint not null default 0,
  max_attempts  smallint not null default 5,
  last_error    text,
  scheduled_at  timestamptz not null default now(),
  locked_at     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists integration_jobs_pending_idx
  on public.integration_jobs (queue, scheduled_at) where status = 'pending';
create index if not exists integration_jobs_failed_idx
  on public.integration_jobs (queue) where status in ('failed','dead');

-- Агрегат для виджета «Очереди»: pending, failed и лаг старейшего задания.
create or replace view public.queue_stats as
select
  queue,
  count(*) filter (where status = 'pending')                  as pending,
  count(*) filter (where status in ('failed','dead'))         as failed,
  coalesce(
    extract(epoch from (now() - min(scheduled_at) filter (where status = 'pending')))::int,
    0)                                                        as oldest_sec
from public.integration_jobs
group by queue;

-- История health-check: нужна для графиков доступности и разбора инцидентов.
create table if not exists public.health_probe_log (
  id          bigserial primary key,
  component   text not null,                 -- 'db' | 'edge' | 'whatsapp' | 'telegram'
  tenant_id   uuid references public.tenants(id) on delete set null,
  status      text not null check (status in ('ok','degraded','down')),
  latency_ms  integer,
  detail      text,
  created_at  timestamptz not null default now()
);

create index if not exists health_probe_log_created_idx on public.health_probe_log (created_at desc);

-- -----------------------------------------------------------------------------
-- 6. RLS. Включаем везде; по умолчанию — запрет, доступ выдаётся политиками.
--    service_role обходит RLS, поэтому Edge Functions работают всегда,
--    а браузерный anon/authenticated-ключ — только в рамках политик.
-- -----------------------------------------------------------------------------
alter table public.tenants             enable row level security;
alter table public.tenant_members      enable row level security;
alter table public.platform_admins     enable row level security;
alter table public.tenant_integrations enable row level security;
alter table public.admin_audit_logs    enable row level security;
alter table public.integration_jobs    enable row level security;
alter table public.health_probe_log    enable row level security;

do $$
begin
  -- Тенанты: суперадмин видит все, участник — свою клинику.
  if not exists (select 1 from pg_policies where policyname = 'tenants_superadmin_all') then
    create policy tenants_superadmin_all on public.tenants
      for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenants_member_select') then
    create policy tenants_member_select on public.tenants
      for select to authenticated using (
        exists (select 1 from public.tenant_members m
                where m.tenant_id = tenants.id and m.user_id = auth.uid()));
  end if;

  -- Тариф и статус тенанта не меняются клиентом: UPDATE для участников не выдаётся
  -- вообще, только суперадмин через политику выше + серверная валидация в функции.

  if not exists (select 1 from pg_policies where policyname = 'tenant_members_superadmin_all') then
    create policy tenant_members_superadmin_all on public.tenant_members
      for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_members_self_select') then
    create policy tenant_members_self_select on public.tenant_members
      for select to authenticated using (user_id = auth.uid());
  end if;

  -- Список админов платформы читает только суперадмин; писать — service_role.
  if not exists (select 1 from pg_policies where policyname = 'platform_admins_superadmin_select') then
    create policy platform_admins_superadmin_select on public.platform_admins
      for select to authenticated using (public.is_superadmin());
  end if;

  -- Интеграции: суперадмин — всё; клиника — только чтение статуса своей записи.
  if not exists (select 1 from pg_policies where policyname = 'integrations_superadmin_all') then
    create policy integrations_superadmin_all on public.tenant_integrations
      for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
  end if;
  if not exists (select 1 from pg_policies where policyname = 'integrations_member_select') then
    create policy integrations_member_select on public.tenant_integrations
      for select to authenticated using (
        exists (select 1 from public.tenant_members m
                where m.tenant_id = tenant_integrations.tenant_id and m.user_id = auth.uid()));
  end if;

  -- Аудит: read-only для суперадмина, запись только service_role (append-only).
  if not exists (select 1 from pg_policies where policyname = 'audit_superadmin_select') then
    create policy audit_superadmin_select on public.admin_audit_logs
      for select to authenticated using (public.is_superadmin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'jobs_superadmin_select') then
    create policy jobs_superadmin_select on public.integration_jobs
      for select to authenticated using (public.is_superadmin());
  end if;

  if not exists (select 1 from pg_policies where policyname = 'health_superadmin_select') then
    create policy health_superadmin_select on public.health_probe_log
      for select to authenticated using (public.is_superadmin());
  end if;
end $$;

-- Никакого прямого UPDATE тарифа/статуса из браузера: отзываем права у клиентских ролей.
revoke insert, update, delete on public.tenants             from authenticated, anon;
revoke insert, update, delete on public.tenant_integrations from authenticated, anon;
revoke insert, update, delete on public.admin_audit_logs    from authenticated, anon;
revoke insert, update, delete on public.integration_jobs    from authenticated, anon;
grant  select on public.queue_stats to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Смена тарифа — только через SECURITY DEFINER функцию с проверкой роли.
--    Edge Function вызывает её от service_role, передавая реального актора.
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_tenant_plan(
  p_tenant_id uuid,
  p_plan      text,
  p_actor     uuid
) returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.tenants;
begin
  if not public.is_superadmin(p_actor) then
    raise exception 'forbidden: actor is not a superadmin' using errcode = '42501';
  end if;
  if p_plan is null or length(trim(p_plan)) = 0 then
    raise exception 'plan is required' using errcode = '22023';
  end if;
  -- Белый список тарифов: опечатка в теле запроса не должна оказаться в tenants.plan.
  if p_plan not in ('Starter','Business','Professional','Enterprise') then
    raise exception 'invalid_plan: %', p_plan using errcode = '22023';
  end if;

  update public.tenants
     set plan = p_plan, updated_at = now()
   where id = p_tenant_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'tenant % not found', p_tenant_id using errcode = 'P0002';
  end if;

  -- Колонка payload (не details / не metadata) — см. определение таблицы выше.
  insert into public.admin_audit_logs (actor_id, action, target_tenant_id, payload)
  values (p_actor, 'change_plan', p_tenant_id, jsonb_build_object('plan', p_plan));

  return v_row;
end $$;

revoke all on function public.admin_set_tenant_plan(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_set_tenant_plan(uuid, text, uuid) to service_role;
