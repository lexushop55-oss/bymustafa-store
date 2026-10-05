-- =============================================================================
-- DentaLine CRM · таблицы patients / appointments / doctors / services —
-- единственный источник данных для интерфейса CRM и для робота WhatsApp.
--
-- До этой миграции CRM в режиме supabase хранила эти коллекции внутри документа
-- workspace_state.data, а робот (tools.ts) работал с таблицами — данные расходились.
-- Теперь CRM читает и пишет таблицы напрямую (crm-data.js), под теми же RLS.
--
--  * crm_ref — ключ, которым пользуется интерфейс ('c1', 's1', 'd1', номер записи 1032).
--    Уникален в пределах компании. Строкам без ключа (их создаёт робот через
--    crm_find_or_create_patient / crm_book_slot) триггер выдаёт ключ сам:
--    пациентам/врачам/услугам — id::text, записям — следующий номер компании.
--  * crm jsonb — поля интерфейса без собственной колонки (план лечения, заметки,
--    оплаты, кресло, история изменений). Это часть той же строки, не вторая копия.
--  * Realtime: изменения от робота сразу приходят в открытую CRM.
-- Идемпотентно. Существующие conversations / messages / ai_actions не затрагиваются.
-- =============================================================================

do $$
declare t text;
begin
  foreach t in array array['patients','appointments','doctors','services'] loop
    execute format('alter table public.%I add column if not exists crm_ref text', t);
    execute format('alter table public.%I add column if not exists crm jsonb not null default ''{}''::jsonb', t);
  end loop;
end $$;

-- 1. Ключи для уже существующих строк ---------------------------------------------
update public.patients set crm_ref = id::text where crm_ref is null;
update public.doctors  set crm_ref = id::text where crm_ref is null;
update public.services set crm_ref = id::text where crm_ref is null;
with numbered as (
  select a.id, 1000 + row_number() over (partition by a.company_id order by a.created_at, a.id)
         + coalesce((select max(x.crm_ref::bigint) from public.appointments x
                      where x.company_id = a.company_id and x.crm_ref ~ '^\d{1,15}$'), 0) as n
    from public.appointments a where a.crm_ref is null)
update public.appointments a set crm_ref = numbered.n::text from numbered where numbered.id = a.id;

-- 2. Триггер: выдать ключ строке без него; для записей — номер без гонок --------------
-- Блокировка по компании берётся на КАЖДУЮ вставку записи (и из CRM, и от робота),
-- поэтому параллельные вставки не получают один номер: вторая ждёт коммита первой.
-- Если номер, выбранный CRM, уже занят (робот успел раньше), выдаётся следующий;
-- CRM получит новый номер через Realtime.
create or replace function public.crm_assign_ref()
returns trigger language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if tg_table_name = 'appointments' then
    perform pg_advisory_xact_lock(hashtextextended('crm_appt_ref:' || new.company_id::text, 0));
    if new.crm_ref is null or exists (select 1 from public.appointments x
         where x.company_id = new.company_id and x.crm_ref = new.crm_ref and x.id <> new.id) then
      select coalesce(max(x.crm_ref::bigint), 1000) + 1 into n
        from public.appointments x where x.company_id = new.company_id and x.crm_ref ~ '^\d{1,15}$';
      new.crm_ref := n::text;
    end if;
  elsif new.crm_ref is null then
    new.crm_ref := new.id::text;
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['patients','appointments','doctors','services'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_crm_ref', t);
    execute format('create trigger %I before insert on public.%I for each row execute function public.crm_assign_ref()', t || '_crm_ref', t);
    execute format('alter table public.%I alter column crm_ref set not null', t);
    execute format('create unique index if not exists %I on public.%I (company_id, crm_ref)', t || '_company_ref_uq', t);
    -- DELETE-события Realtime с фильтром по company_id требуют полной строки.
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

-- 3. Realtime: CRM подписана на изменения своей компании (RLS действует и на подписки)
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['patients','appointments','doctors','services'] loop
      begin execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null; end;
    end loop;
  end if;
end $$;

-- 4. Проверка (вручную после деплоя) --------------------------------------------
--   insert into public.appointments (company_id, starts_at) values ('<A>', now()) returning crm_ref;  -- следующий номер
--   select count(*) from public.workspace_state where data ? 'clients' or data ? 'appointments';     -- после первого входа: 0
