-- MVP: запись через WhatsApp только после явного подтверждения пациента.
--  * conversations.agent_lock_until — один запуск робота на диалог одновременно
--    (два вебхука подряд не запускают робота дважды и не создают две записи).
--  * pending_booking хранится в conversations.agent_state (jsonb, колонка уже есть) —
--    create_appointment проверяет его на сервере.
--  * Индексы под проверки подтверждения и «последнее входящее».

alter table public.conversations add column if not exists agent_lock_until timestamptz;

create index if not exists messages_conv_dir_time_idx
  on public.messages (conversation_id, direction, created_at desc);

-- Realtime для календаря CRM (на случай, если 20261007090000 применялась до создания публикации).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['patients','appointments'] loop
      begin execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null; end;
    end loop;
  end if;
end $$;

-- Проверка после деплоя:
--   select column_name from information_schema.columns where table_name='conversations' and column_name='agent_lock_until';
--   select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename in ('appointments','patients');
