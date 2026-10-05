# WhatsApp ↔ CRM ↔ робот-администратор

```
WhatsApp → провайдер (Meta Cloud API) → whatsapp-webhook → processInbound
  → пациент (найти/создать) → диалог → messages (сохранено)
  → ваш агент (AI_AGENT_URL) ⇄ инструменты CRM (tools.ts) → таблицы CRM
  → ответ → sendOutgoing → провайдер → WhatsApp
```

CRM — источник данных, WhatsApp — канал, агент — обработчик. Агент не пишет в базу
сам: он возвращает вызовы инструментов, CRM их выполняет с `company_id` компании.

## Подключение по QR-коду (без Meta)

Провайдер `baileys`: шлюз `whatsapp-gateway/` (Node.js + Baileys) держит сессию WhatsApp Web
для каждой клиники. В CRM: WhatsApp → Подключение → «По QR-коду» → «Показать QR-код» → скан телефоном.
Функция `whatsapp` создаёт сессию в шлюзе (`/connect {provider:'qr'}`), CRM опрашивает `/qr`;
после сканирования шлюз шлёт событие `connection` в вебхук, подключение становится активным.
Номер, активный у другой компании, не подключится (уникальный индекс по `phone_e164`).
Секреты: `WA_GATEWAY_URL`, `WA_GATEWAY_SECRET` (функции), подпись событий — секрет подключения в Vault.
Миграция: `20261006120000_whatsapp_qr.sql`. Запуск шлюза — `whatsapp-gateway/README.md`.

## Файлы

| Файл | Что делает |
| --- | --- |
| `migrations/20261006090000_whatsapp_channel.sql` | новые таблицы, расширение существующих, RLS, RPC бронирования, Vault-хелперы |
| `functions/_shared/whatsapp/types.ts` | `WhatsAppAdapter`, `NormalizedMessage`, `ProviderError` |
| `functions/_shared/whatsapp/meta.ts` | провайдер WhatsApp Cloud API: подпись `X-Hub-Signature-256`, `hub.challenge`, отправка, статусы |
| `functions/_shared/whatsapp/mock.ts` | тестовый провайдер, работает только при `WHATSAPP_ALLOW_MOCK=true` |
| `functions/_shared/whatsapp/index.ts` | реестр провайдеров, загрузка подключения и секретов |
| `functions/_shared/whatsapp/inbound.ts` | конвейер входящего сообщения, статусы доставки |
| `functions/_shared/whatsapp/outbound.ts` | сохранить → отправить → `sent`/`failed` + очередь повтора |
| `functions/_shared/crm/tools.ts` | 15 инструментов CRM + запись в `ai_actions` |
| `functions/_shared/agent/runner.ts` | цикл «агент ⇄ инструменты», протоколы `dentaline` и `openai` |
| `functions/_shared/tenant.ts` | `requireCompanyMember` — компания и роль по токену |
| `functions/whatsapp-webhook` | публичный вебхук (без JWT) |
| `functions/whatsapp` | API кабинета: подключение, ответы, передача оператору, настройки робота |
| `functions/whatsapp-worker` | повтор неотправленных сообщений и упавших вебхуков |
| `functions/dev-agent-stub` | заглушка агента для тестов; описывает контракт |
| `tests/whatsapp_e2e.test.ts` | 6 сквозных тестов на развёрнутом проекте |

## Таблицы

Используются существующие: `tenants` (+`timezone`), `tenant_integrations` (= подключение WhatsApp:
`provider`, `webhook_key`, ссылки на секреты в Vault, статусы), `patients` (+`phone_digits`),
`appointments` (+`source`, `conversation_id`), `services` (+`doctor_ids`, `ai_bookable`),
`doctors` (+часы), `tasks` (+`description`, `patient_id`, `conversation_id`), `ai_settings`
(+поля из п. 14 ТЗ), `activity_logs`, `integration_jobs` (очередь `wa_out`).

Добавлены: `conversations`, `messages`, `ai_actions`, `webhook_events`, `patient_notes`, `appointment_events`.
Отдельной таблицы подключений нет — `tenant_integrations` уже была и уже под RLS.

## Как определяется company_id

URL вебхука содержит случайный `webhook_key` (48 hex) конкретного подключения:
`/whatsapp-webhook/<webhook_key>` → строка `tenant_integrations` → `tenant_id`.
Второй замок — `metadata.phone_number_id` в теле должен совпасть с `external_id` подключения.
Подпись проверяется секретом этого же подключения. По номеру пациента компания не определяется никогда.
Один номер провайдера не может быть активен у двух компаний (уникальный индекс).

## Вебхук

1. найти подключение по ключу (неизвестный → 404);
2. проверить подпись сырого тела (`X-Hub-Signature-256`, HMAC-SHA256 app secret) → иначе 401;
3. `webhook_events` с `dedupe_key = sha256(тело)` — повтор того же вебхука сразу 200;
4. ответ 200, обработка в `EdgeRuntime.waitUntil`;
5. на каждое сообщение `processInbound`: дубль по `(integration_id, external_message_id)` → стоп;
   пациент `crm_find_or_create_patient` (advisory lock) → диалог upsert → **сохранить** входящее →
   робот → ответ. Статусы доставки обновляют `messages.status` только вверх (sent → delivered → read).

## Как робот вызывает CRM

`runner.ts` отправляет агенту историю диалога, настройки компании и схемы 15 инструментов.
Агент отвечает `tool_calls` → `runTool` выполняет запрос к таблицам **с фильтром company_id**
и пишет строку в `ai_actions` (инструмент, аргументы, результат, ссылка на запись/пациента) →
результат возвращается агенту. Цикл до 8 шагов, пока агент не вернёт текст.
Бронирование и перенос — транзакционные `crm_book_slot` / `crm_move_appointment`
(блокировка врача на день + проверка пересечения), история — `appointment_events`.

Контракт протокола `dentaline` (по умолчанию):
```
POST AI_AGENT_URL   Authorization: Bearer AI_AGENT_TOKEN
{ company:{id,name,timezone,settings}, conversation:{id}, patient:{id,name}, messages:[…], tools:[…] }
← { "tool_calls":[{ "id":"…", "name":"get_available_slots", "arguments":{…} }] }
← { "reply":"Есть завтра в 16:30 и 17:30. Какое время вам удобнее?" }
```
Если ваш агент — OpenAI-совместимый chat/completions с tools: `AI_AGENT_PROTOCOL=openai`, `AI_AGENT_MODEL=…`.

## Отправка обратно

`sendOutgoing`: строка `messages` со статусом `pending` → `adapter.sendMessage` → `sent` + `external_message_id`.
Ошибка провайдера → `failed` + текст ошибки; если ошибка временная (5xx, 429, таймаут) — задание в
`integration_jobs` (`wa_out`) с бэкоффом 15 с → 1 ч, воркер повторяет до 5 раз. Сообщение не теряется,
в чате CRM видно «Не отправлено · Повторить».

## Передача оператору

«Передать оператору» → `ai_enabled=false`, `status='needs_operator'`, системное событие в чате.
Входящие продолжают сохраняться, робот не запускается. «Вернуть робота» → `ai_enabled=true`.
Автоматически: ключевые слова из `ai_settings.human_handoff_rules.keywords`, инструмент
`transfer_to_human`, любая ошибка агента (`on_ai_error`) — пациент получает «передала администратору»,
создаётся задача.

## Развёртывание

```bash
supabase db push
supabase functions deploy whatsapp
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy whatsapp-worker  --no-verify-jwt
supabase secrets set PUBLIC_WEBHOOK_BASE_URL=https://<project>.functions.supabase.co \
  AI_AGENT_URL=… AI_AGENT_TOKEN=… WHATSAPP_WORKER_SECRET=$(openssl rand -hex 24)
# только на сервере разработки:
supabase secrets set WHATSAPP_ALLOW_MOCK=true
```
Воркер раз в минуту (pg_cron + pg_net или внешний планировщик): `POST /functions/v1/whatsapp-worker`
с заголовком `x-worker-secret`.

В Meta: App → WhatsApp → Configuration → Callback URL = адрес из CRM (Настройки → Каналы → WhatsApp),
Verify token = значение, показанное один раз после подключения; подписка на поле `messages`.

## Тесты

```bash
SUPABASE_URL=… SUPABASE_ANON_KEY=… A_EMAIL=… A_PASSWORD=… B_EMAIL=… B_PASSWORD=… \
  deno test -A backend/supabase/tests/whatsapp_e2e.test.ts
```
Демо-режим CRM (без сервера) проходит тот же сценарий локально: WhatsApp → Подключение →
тестовый провайдер → «Имитация входящего сообщения».
