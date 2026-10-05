-- Подключение WhatsApp по QR-коду (шлюз whatsapp-gateway на Baileys).
-- external_id = id сессии в шлюзе; номер появляется в phone_e164 после сканирования.
alter table public.tenant_integrations drop constraint if exists tenant_integrations_provider_check;
alter table public.tenant_integrations add constraint tenant_integrations_provider_check
  check (provider in ('meta_cloud','mock','baileys'));

-- Один и тот же номер не может быть активен у двух компаний (для любого провайдера).
create unique index if not exists tenant_integrations_active_phone_uq
  on public.tenant_integrations (phone_e164) where is_active and type = 'whatsapp' and phone_e164 is not null;
