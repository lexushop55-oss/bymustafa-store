-- =============================================================================
-- DentaLine CRM · multi-tenant слой.
-- Компания = public.tenants (существующая таблица, не дублируем). Каждая сущность
-- CRM несёт company_id → tenants.id. Доступ решает только RLS:
--   участник компании видит строки своей компании, суперадмин — все.
-- Регистрация: supabase.auth.signUp(..., data:{ full_name, company_name })
--   → триггер on_auth_user_created создаёт компанию и делает пользователя Owner.
-- Идемпотентно.
-- =============================================================================

-- 1. Роли и статус участника ---------------------------------------------------
alter table public.tenant_members add column if not exists is_active boolean not null default true;
alter table public.tenant_members add column if not exists full_name text;
alter table public.tenant_members add column if not exists email text;
alter table public.tenant_members drop constraint if exists tenant_members_role_check;
alter table public.tenant_members add constraint tenant_members_role_check
  check (role in ('Owner','Admin','Manager','Employee'));
alter table public.tenants add column if not exists business_type text not null default 'Стоматология';
-- Один пользователь — одна компания (кабинет открывается без выбора).
create unique index if not exists tenant_members_one_company on public.tenant_members (user_id);

-- 2. Хелперы для политик (SECURITY DEFINER: читают tenant_members в обход его RLS) --
create or replace function public.current_company_id()
returns uuid language sql stable security definer set search_path = public as $$
  select m.tenant_id from public.tenant_members m
   join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.is_active and t.status not in ('Suspended','Inactive')
  limit 1;
$$;

create or replace function public.is_company_member(p_company uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or p_company = public.current_company_id();
$$;

create or replace function public.has_company_role(p_company uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1 from public.tenant_members m
     where m.tenant_id = p_company and m.user_id = auth.uid() and m.is_active
       and m.role = any(p_roles)
       and p_company = public.current_company_id());
$$;

revoke all on function public.current_company_id() from public;
revoke all on function public.is_company_member(uuid) from public;
revoke all on function public.has_company_role(uuid, text[]) from public;
grant execute on function public.current_company_id() to authenticated;
grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.has_company_role(uuid, text[]) to authenticated;

-- 3. Профиль текущего пользователя: одна точка для фронта после входа -----------
--    Возвращает компанию, роль и статус. Статус проверяется здесь, а не в JS:
--    неактивная компания/участник → access = 'inactive'.
create or replace function public.my_workspace()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object(
        'company_id', t.id, 'company_name', t.name, 'business_type', t.business_type,
        'plan', t.plan, 'company_status', t.status,
        'role', m.role, 'full_name', m.full_name,
        'access', case when not m.is_active or t.status in ('Suspended','Inactive') then 'inactive' else 'ok' end,
        'superadmin', public.is_superadmin())
       from public.tenant_members m join public.tenants t on t.id = m.tenant_id
      where m.user_id = auth.uid() limit 1),
    jsonb_build_object('access', case when public.is_superadmin() then 'superadmin' else 'no_company' end,
                       'superadmin', public.is_superadmin()));
$$;
revoke all on function public.my_workspace() from public;
grant execute on function public.my_workspace() to authenticated;

-- 4. Регистрация: компания + владелец в одной транзакции с созданием auth-пользователя.
--    Если пользователя создаёт суперадмин (Edge Function /tenants), он передаёт
--    app_metadata.company_id — тогда новая компания не создаётся.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_company uuid;
  v_name    text := nullif(trim(new.raw_user_meta_data->>'company_name'), '');
  v_full    text := nullif(trim(new.raw_user_meta_data->>'full_name'), '');
begin
  if (new.raw_app_meta_data ? 'company_id') or v_name is null then
    return new;
  end if;
  insert into public.tenants (name, status, plan, owner_id)
  values (left(v_name, 120), 'Trial', 'Starter', new.id)
  returning id into v_company;
  insert into public.tenant_members (tenant_id, user_id, role, full_name, email)
  values (v_company, new.id, 'Owner', left(v_full, 120), new.email);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Участник видит коллег своей компании; управляет составом только Owner/Admin.
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'tenant_members_company_select') then
    create policy tenant_members_company_select on public.tenant_members
      for select to authenticated using (public.is_company_member(tenant_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'tenant_members_owner_write') then
    create policy tenant_members_owner_write on public.tenant_members
      for update to authenticated
      using (public.has_company_role(tenant_id, array['Owner','Admin']) and role <> 'Owner')
      with check (public.has_company_role(tenant_id, array['Owner','Admin']) and role <> 'Owner');
  end if;
end $$;

-- 5. Сущности CRM. Все — company_id not null + индекс + RLS ----------------------
create table if not exists public.doctors (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null, specialty text, color text, is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  name text not null, category text, price numeric(12,2) not null default 0, duration_min int not null default 30,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  full_name text not null, phone text, email text, birth_date date, notes text, source text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  patient_id uuid references public.patients(id) on delete set null,
  doctor_id uuid references public.doctors(id) on delete set null,
  service_id uuid references public.services(id) on delete set null,
  starts_at timestamptz not null, duration_min int not null default 30,
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','arrived','in_chair','done','cancelled','no_show')),
  price numeric(12,2), comment text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  patient_id uuid references public.patients(id) on delete set null,
  amount numeric(12,2) not null, refunded numeric(12,2) not null default 0, method text,
  paid_at timestamptz not null default now(), created_at timestamptz not null default now());

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  title text not null, assignee_id uuid references auth.users(id) on delete set null,
  due_at timestamptz, done boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());

create table if not exists public.lead_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  name text, phone text, channel text, status text not null default 'new', risk text, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());

create table if not exists public.ai_settings (
  company_id uuid primary key references public.tenants(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

create table if not exists public.activity_logs (
  id bigserial primary key,
  company_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now());

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.tenants(id) on delete cascade,
  plan text not null, price numeric(12,2) not null default 0, status text not null default 'Trial',
  period text not null default 'Monthly', next_payment date,
  created_at timestamptz not null default now());

-- Снимок рабочего пространства: текущая версия CRM хранит состояние одним
-- документом; таблица изолирована тем же RLS, что и нормализованные сущности.
create table if not exists public.workspace_state (
  company_id uuid primary key references public.tenants(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now());

-- Индексы по company_id и единые политики для всех таблиц.
-- Чтение — любой активный участник; запись — Owner/Admin/Manager (Employee только читает);
-- справочники (doctors, services, ai_settings) меняют Owner/Admin;
-- subscriptions — только суперадмин (через service_role / политику tenants_superadmin_all-подобную).
do $$
declare
  t text;
  write_roles text;
begin
  foreach t in array array['doctors','services','patients','appointments','payments','tasks',
                           'lead_requests','ai_settings','activity_logs','subscriptions','workspace_state']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create index if not exists %I on public.%I (company_id)', t || '_company_idx', t);

    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_company_member(company_id))',
                   t || '_select', t);

    write_roles := case
      when t in ('doctors','services','ai_settings') then 'array[''Owner'',''Admin'']'
      when t = 'subscriptions' then null
      when t = 'activity_logs' then 'array[''Owner'',''Admin'',''Manager'',''Employee'']'
      else 'array[''Owner'',''Admin'',''Manager'']' end;

    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    if write_roles is null then
      execute format('create policy %I on public.%I for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin())',
                     t || '_write', t);
    elsif t = 'activity_logs' then
      -- Журнал append-only: только insert своей компании.
      execute format('create policy %I on public.%I for insert to authenticated with check (public.has_company_role(company_id, %s))',
                     t || '_write', t, write_roles);
    else
      execute format('create policy %I on public.%I for all to authenticated using (public.has_company_role(company_id, %s)) with check (public.has_company_role(company_id, %s))',
                     t || '_write', t, write_roles, write_roles);
    end if;

    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- company_id нельзя «перевести» в чужую компанию апдейтом: with check выше
-- требует членства в новой company_id, а current_company_id() у пользователя одна.

-- 6. Проверка изоляции (выполнить вручную после деплоя) ------------------------
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<uuid пользователя A>"}';
--   select count(*) from public.patients where company_id = '<uuid компании B>';  -- ожидаем 0
--   insert into public.patients (company_id, full_name) values ('<uuid B>', 'x'); -- ожидаем ошибку RLS
