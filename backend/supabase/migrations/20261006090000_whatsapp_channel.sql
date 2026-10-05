-- =============================================================================
-- DentaLine CRM · канал WhatsApp + робот-администратор через инструменты CRM.
--
-- Переиспользуем:  tenants (компания), tenant_integrations (= подключение канала),
--                  patients, appointments, services, doctors, tasks, ai_settings,
--                  activity_logs, integration_jobs (очередь wa_out).
-- Добавляем:       conversations, messages, ai_actions, webhook_events,
--                  patient_notes, appointment_events.
--
-- Правила:
--  * каждая новая строка несёт company_id (→ tenants.id) и закрыта RLS;
--  * пользователи компании только ЧИТАЮТ переписку; любые записи в канал идут
--    через Edge Function `whatsapp` (service_role после проверки членства),
--    чтобы каждое действие попадало в журнал и не обходило отправку;
--  * компания входящего вебхука определяется ТОЛЬКО по подключению
--    (webhook_key в URL + phone_number_id в теле), никогда по номеру пациента.
-- Идемпотентно.
-- =============================================================================

create extension if not exists pgcrypto;

-- 0. Часовой пояс компании: слоты считаются в местном времени клиники ----------
alter table public.tenants add column if not exists timezone text not null default 'Europe/Moscow';

-- 1. Подключение WhatsApp = строка tenant_integrations (type = 'whatsapp') -------
alter table public.tenant_integrations add column if not exists provider        text not null default 'meta_cloud';
alter table public.tenant_integrations add column if not exists display_name    text;
alter table public.tenant_integrations add column if not exists phone_e164      text;
alter table public.tenant_integrations add column if not exists account_id      text;      -- WABA id / аккаунт у провайдера
alter table public.tenant_integrations add column if not exists webhook_key     text;      -- случайный ключ в URL вебхука
alter table public.tenant_integrations add column if not exists webhook_status  text not null default 'unknown';
alter table public.tenant_integrations add column if not exists verify_token_ref text;     -- имя секрета в Vault
alter table public.tenant_integrations add column if not exists app_secret_ref  text;      -- имя секрета в Vault (подпись вебхука)
alter table public.tenant_integrations add column if not exists is_active       boolean not null default false;
alter table public.tenant_integrations add column if not exists connected_at    timestamptz;
alter table public.tenant_integrations add column if not exists disconnected_at timestamptz;
alter table public.tenant_integrations add column if not exists last_inbound_at timestamptz;
alter table public.tenant_integrations add column if not exists last_outbound_at timestamptz;
alter table public.tenant_integrations add column if not exists last_webhook_at timestamptz;

alter table public.tenant_integrations drop constraint if exists tenant_integrations_provider_check;
alter table public.tenant_integrations add constraint tenant_integrations_provider_check
  check (provider in ('meta_cloud','mock'));
alter table public.tenant_integrations drop constraint if exists tenant_integrations_webhook_status_check;
alter table public.tenant_integrations add constraint tenant_integrations_webhook_status_check
  check (webhook_status in ('unknown','waiting','verified','failing'));

create unique index if not exists tenant_integrations_webhook_key_uq
  on public.tenant_integrations (webhook_key) where webhook_key is not null;
-- Один номер провайдера не может принадлежать двум компаниям одновременно.
create unique index if not exists tenant_integrations_provider_external_uq
  on public.tenant_integrations (provider, external_id) where is_active and external_id is not null;

-- 2. Пациенты: телефон в цифрах для поиска по WhatsApp ------------------------
alter table public.patients add column if not exists phone_digits text
  generated always as (nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')) stored;
create index if not exists patients_company_phone_idx on public.patients (company_id, phone_digits);

-- Атомарно: найти пациента компании по телефону или создать. Advisory lock
-- по (компания, номер) не даёт двум параллельным вебхукам создать дубль.
create or replace function public.crm_find_or_create_patient(
  p_company uuid, p_phone text, p_name text, p_source text default 'whatsapp')
returns table (patient_id uuid, created boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_digits text := nullif(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), '');
  v_id uuid;
begin
  if v_digits is null then raise exception 'phone_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || ':' || v_digits, 0));
  select p.id into v_id from public.patients p
   where p.company_id = p_company and p.phone_digits = v_digits
   order by p.created_at limit 1;
  if v_id is not null then
    return query select v_id, false; return;
  end if;
  insert into public.patients (company_id, full_name, phone, source)
  values (p_company, coalesce(nullif(trim(p_name), ''), '+' || v_digits), '+' || v_digits, p_source)
  returning id into v_id;
  return query select v_id, true;
end $$;

-- 3. Справочники для слотов ------------------------------------------------------
alter table public.doctors  add column if not exists work_open  time not null default '09:00';
alter table public.doctors  add column if not exists work_close time not null default '20:00';
alter table public.services add column if not exists doctor_ids uuid[] not null default '{}';   -- пусто = любой врач
alter table public.services add column if not exists ai_bookable boolean not null default true;  -- робот может записывать сам

-- 4. Записи: источник и связь с диалогом + история изменений -------------------
alter table public.appointments add column if not exists source text not null default 'admin';
alter table public.appointments add column if not exists conversation_id uuid;
create index if not exists appointments_doctor_time_idx on public.appointments (company_id, doctor_id, starts_at);

create table if not exists public.appointment_events (
  id             bigserial primary key,
  company_id     uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  action         text not null check (action in ('created','rescheduled','cancelled','updated')),
  before         jsonb,
  after          jsonb,
  actor_type     text not null check (actor_type in ('ai','employee','system','customer')),
  actor_id       uuid,
  conversation_id uuid,
  created_at     timestamptz not null default now());
create index if not exists appointment_events_appt_idx on public.appointment_events (appointment_id, created_at);

-- Бронирование слота одной транзакцией: блокировка врача на день + проверка
-- пересечения. Вызывается только из Edge Function (service_role).
create or replace function public.crm_book_slot(
  p_company uuid, p_patient uuid, p_doctor uuid, p_service uuid,
  p_starts timestamptz, p_duration int, p_source text, p_conversation uuid,
  p_actor_type text, p_actor uuid, p_comment text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_price numeric;
begin
  if not exists (select 1 from public.patients where id = p_patient and company_id = p_company) then raise exception 'patient_not_in_company'; end if;
  if not exists (select 1 from public.doctors  where id = p_doctor  and company_id = p_company and is_active) then raise exception 'doctor_not_in_company'; end if;
  select price into v_price from public.services where id = p_service and company_id = p_company and is_active;
  if not found then raise exception 'service_not_in_company'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_doctor::text || ':' || (p_starts at time zone 'UTC')::date::text, 0));
  if exists (
    select 1 from public.appointments a
     where a.company_id = p_company and a.doctor_id = p_doctor
       and a.status not in ('cancelled','no_show')
       and tstzrange(a.starts_at, a.starts_at + make_interval(mins => a.duration_min)) &&
           tstzrange(p_starts, p_starts + make_interval(mins => p_duration))) then
    raise exception 'slot_taken';
  end if;

  insert into public.appointments (company_id, patient_id, doctor_id, service_id, starts_at, duration_min, status, price, comment, source, conversation_id)
  values (p_company, p_patient, p_doctor, p_service, p_starts, p_duration, 'scheduled', v_price, p_comment, p_source, p_conversation)
  returning id into v_id;

  insert into public.appointment_events (company_id, appointment_id, action, after, actor_type, actor_id, conversation_id)
  values (p_company, v_id, 'created', jsonb_build_object('starts_at', p_starts, 'doctor_id', p_doctor, 'service_id', p_service), p_actor_type, p_actor, p_conversation);
  return v_id;
end $$;

create or replace function public.crm_move_appointment(
  p_company uuid, p_appointment uuid, p_starts timestamptz, p_doctor uuid,
  p_actor_type text, p_actor uuid, p_conversation uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.appointments; v_doctor uuid;
begin
  select * into a from public.appointments where id = p_appointment and company_id = p_company for update;
  if not found then raise exception 'appointment_not_found'; end if;
  if a.status in ('cancelled','no_show','done') then raise exception 'appointment_closed'; end if;
  v_doctor := coalesce(p_doctor, a.doctor_id);
  perform pg_advisory_xact_lock(hashtextextended(v_doctor::text || ':' || (p_starts at time zone 'UTC')::date::text, 0));
  if exists (
    select 1 from public.appointments x
     where x.company_id = p_company and x.doctor_id = v_doctor and x.id <> a.id
       and x.status not in ('cancelled','no_show')
       and tstzrange(x.starts_at, x.starts_at + make_interval(mins => x.duration_min)) &&
           tstzrange(p_starts, p_starts + make_interval(mins => a.duration_min))) then
    raise exception 'slot_taken';
  end if;
  update public.appointments set starts_at = p_starts, doctor_id = v_doctor, updated_at = now() where id = a.id;
  insert into public.appointment_events (company_id, appointment_id, action, before, after, actor_type, actor_id, conversation_id)
  values (p_company, a.id, 'rescheduled',
          jsonb_build_object('starts_at', a.starts_at, 'doctor_id', a.doctor_id),
          jsonb_build_object('starts_at', p_starts, 'doctor_id', v_doctor), p_actor_type, p_actor, p_conversation);
end $$;

revoke all on function public.crm_find_or_create_patient(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.crm_book_slot(uuid, uuid, uuid, uuid, timestamptz, int, text, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.crm_move_appointment(uuid, uuid, timestamptz, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.crm_find_or_create_patient(uuid, text, text, text) to service_role;
grant execute on function public.crm_book_slot(uuid, uuid, uuid, uuid, timestamptz, int, text, uuid, text, uuid, text) to service_role;
grant execute on function public.crm_move_appointment(uuid, uuid, timestamptz, uuid, text, uuid, uuid) to service_role;

-- 5. Задачи и заметки, созданные из диалога ----------------------------------
alter table public.tasks add column if not exists description text;
alter table public.tasks add column if not exists patient_id uuid references public.patients(id) on delete set null;
alter table public.tasks add column if not exists conversation_id uuid;
alter table public.tasks add column if not exists source text not null default 'employee';

create table if not exists public.patient_notes (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.tenants(id) on delete cascade,
  patient_id      uuid not null references public.patients(id) on delete cascade,
  conversation_id uuid,
  text            text not null,
  kind            text not null default 'note' check (kind in ('note','complaint','preference','medical')),
  source          text not null default 'employee' check (source in ('ai','employee','system')),
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now());

-- 6. Настройки робота — у каждой компании своя строка ai_settings -------------
alter table public.ai_settings add column if not exists ai_enabled           boolean not null default false;
alter table public.ai_settings add column if not exists system_prompt        text;
alter table public.ai_settings add column if not exists business_name        text;
alter table public.ai_settings add column if not exists business_description text;
alter table public.ai_settings add column if not exists working_hours        jsonb not null default '{}'::jsonb;  -- {"mon":{"open":"09:00","close":"20:00","break":["13:00","14:00"],"off":false},…}
alter table public.ai_settings add column if not exists booking_rules        text;
alter table public.ai_settings add column if not exists language             text not null default 'ru';
alter table public.ai_settings add column if not exists tone                 text not null default 'friendly';
alter table public.ai_settings add column if not exists human_handoff_rules  jsonb not null default '{"keywords":["оператор","администратор","человек"],"on_ai_error":true,"medical_complaints":true}'::jsonb;
alter table public.ai_settings add column if not exists slot_step_min        int not null default 30;
alter table public.ai_settings add column if not exists booking_horizon_days int not null default 14;

-- 7. Диалоги ------------------------------------------------------------------
create table if not exists public.conversations (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.tenants(id) on delete cascade,
  integration_id      uuid references public.tenant_integrations(id) on delete set null,
  patient_id          uuid references public.patients(id) on delete set null,
  channel             text not null default 'whatsapp' check (channel in ('whatsapp','telegram')),
  external_contact_id text not null,                     -- для WhatsApp: номер в формате wa_id (цифры)
  contact_name        text,
  status              text not null default 'open' check (status in ('open','needs_operator','closed')),
  assigned_to         uuid references auth.users(id) on delete set null,
  ai_enabled          boolean not null default true,
  handoff_reason      text,
  unread_count        int not null default 0,
  last_message_preview text,
  last_message_at     timestamptz,
  agent_state         jsonb not null default '{}'::jsonb, -- короткая память робота (предложенные слоты и т.п.)
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (company_id, channel, external_contact_id));
create index if not exists conversations_company_last_idx on public.conversations (company_id, last_message_at desc);

-- 8. Сообщения ------------------------------------------------------------------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.tenants(id) on delete cascade,
  conversation_id     uuid not null references public.conversations(id) on delete cascade,
  patient_id          uuid references public.patients(id) on delete set null,
  integration_id      uuid references public.tenant_integrations(id) on delete set null,
  external_message_id text,
  client_ref          text,                               -- идемпотентность ручных ответов из CRM
  direction           text not null check (direction in ('incoming','outgoing')),
  sender_type         text not null check (sender_type in ('customer','ai','employee','system')),
  sender_id           uuid references auth.users(id) on delete set null,
  message_type        text not null default 'text' check (message_type in ('text','image','audio','video','document','location','interactive','template','event','unsupported')),
  text                text,
  media_url           text,
  payload             jsonb not null default '{}'::jsonb,
  ai_generated        boolean not null default false,
  status              text not null default 'received' check (status in ('received','pending','sent','delivered','read','failed')),
  error               text,
  attempts            smallint not null default 0,
  sent_at             timestamptz,
  created_at          timestamptz not null default now());
-- Повторная доставка вебхука не создаёт второе сообщение.
create unique index if not exists messages_integration_external_uq
  on public.messages (integration_id, external_message_id) where external_message_id is not null;
create unique index if not exists messages_client_ref_uq
  on public.messages (company_id, client_ref) where client_ref is not null;
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

-- Сводка диалога обновляется триггером: список Inbox не пересчитывает её на клиенте.
create or replace function public.messages_touch_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sender_type = 'system' and new.message_type = 'event' then return new; end if;
  update public.conversations c set
    last_message_at = new.created_at,
    last_message_preview = left(coalesce(new.text, '[' || new.message_type || ']'), 160),
    unread_count = case when new.direction = 'incoming' then c.unread_count + 1 else c.unread_count end,
    updated_at = now()
  where c.id = new.conversation_id;
  return new;
end $$;
drop trigger if exists messages_touch_conversation on public.messages;
create trigger messages_touch_conversation after insert on public.messages
  for each row execute function public.messages_touch_conversation();

-- 9. Журнал действий робота -------------------------------------------------------
create table if not exists public.ai_actions (
  id              bigserial primary key,
  company_id      uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  trigger_message_id uuid references public.messages(id) on delete set null,
  tool            text not null,
  args            jsonb not null default '{}'::jsonb,
  result          jsonb not null default '{}'::jsonb,
  status          text not null check (status in ('ok','error')),
  entity_type     text,                                  -- patient | appointment | task | note | message
  entity_id       text,
  duration_ms     int,
  created_at      timestamptz not null default now());
create index if not exists ai_actions_conversation_idx on public.ai_actions (conversation_id, created_at);

-- 10. Сырые вебхуки: приём → подтверждение 200 → обработка. Повтор = тот же dedupe_key.
create table if not exists public.webhook_events (
  id             bigserial primary key,
  integration_id uuid references public.tenant_integrations(id) on delete set null,
  company_id     uuid references public.tenants(id) on delete cascade,
  provider       text not null,
  dedupe_key     text not null,
  payload        jsonb not null,
  signature_ok   boolean not null,
  status         text not null default 'received' check (status in ('received','processed','failed','ignored')),
  error          text,
  attempts       smallint not null default 0,
  created_at     timestamptz not null default now(),
  processed_at   timestamptz,
  unique (integration_id, dedupe_key));

-- 11. RLS --------------------------------------------------------------------------
-- Чтение — участники своей компании; запись — только service_role (Edge Functions).
-- Исключение: заметки о пациенте сотрудники пишут напрямую (как прочие данные CRM).
do $$
declare t text;
begin
  foreach t in array array['conversations','messages','ai_actions','patient_notes','appointment_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I (company_id)', t || '_company_idx', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_company_member(company_id))', t || '_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

drop policy if exists patient_notes_write on public.patient_notes;
create policy patient_notes_write on public.patient_notes for insert to authenticated
  with check (public.has_company_role(company_id, array['Owner','Admin','Manager']) and source = 'employee' and created_by = auth.uid());
grant insert on public.patient_notes to authenticated;

alter table public.webhook_events enable row level security;
drop policy if exists webhook_events_superadmin on public.webhook_events;
create policy webhook_events_superadmin on public.webhook_events for select to authenticated using (public.is_superadmin());
revoke all on public.webhook_events from anon, authenticated;
grant select on public.webhook_events to authenticated;

-- Участник видит подключение своей компании (секретов в строке нет — только имена в Vault),
-- но не меняет его напрямую: только через Edge Function `whatsapp`.
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'integrations_company_select') then
    create policy integrations_company_select on public.tenant_integrations
      for select to authenticated using (public.is_company_member(tenant_id));
  end if;
end $$;

-- 12. Секреты в Vault: запись только из Edge Function ------------------------
create or replace function public.wa_put_secret(p_name text, p_secret text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then perform vault.create_secret(p_secret, p_name, 'whatsapp channel');
  else perform vault.update_secret(v_id, p_secret, p_name); end if;
end $$;
create or replace function public.wa_drop_secret(p_name text)
returns void language sql security definer set search_path = public, vault as $$
  delete from vault.secrets where name = p_name;
$$;
revoke all on function public.wa_put_secret(text, text) from public, anon, authenticated;
revoke all on function public.wa_drop_secret(text) from public, anon, authenticated;
grant execute on function public.wa_put_secret(text, text) to service_role;
grant execute on function public.wa_drop_secret(text) to service_role;

-- 13. Очередь повторной отправки: забрать задания без гонок между воркерами ----
create or replace function public.wa_claim_jobs(p_limit int default 20)
returns setof public.integration_jobs language sql security definer set search_path = public as $$
  update public.integration_jobs j set status = 'processing', locked_at = now(), attempts = j.attempts + 1, updated_at = now()
   where j.id in (select id from public.integration_jobs
                   where queue = 'wa_out' and status = 'pending' and scheduled_at <= now()
                   order by scheduled_at limit p_limit for update skip locked)
  returning j.*;
$$;
revoke all on function public.wa_claim_jobs(int) from public, anon, authenticated;
grant execute on function public.wa_claim_jobs(int) to service_role;

-- 14. Realtime для Inbox (RLS применяется и к подпискам) -----------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.conversations'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.messages'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.ai_actions'; exception when duplicate_object then null; end;
  end if;
end $$;

-- 15. Проверка изоляции (вручную, после деплоя) -------------------------------
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid пользователя компании A>"}';
--   select count(*) from public.conversations where company_id = '<uuid B>';   -- 0
--   select count(*) from public.messages      where company_id = '<uuid B>';   -- 0
--   insert into public.messages (company_id, conversation_id, direction, sender_type, text)
--     values ('<uuid A>', '<conv A>', 'outgoing', 'employee', 'x');            -- ошибка: нет прав на insert
