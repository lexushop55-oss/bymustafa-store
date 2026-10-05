# WhatsApp MVP: реальный номер → робот → подтверждение → запись в CRM

```
Пациент → WhatsApp → Meta Cloud API → POST /whatsapp-webhook/<webhook_key>
  → подпись X-Hub-Signature-256 → webhook_events (дубль = 200 без обработки)
  → processInbound: пациент → диалог → messages → блокировка диалога (один запуск робота)
  → робот: get_services → check_free_slots → propose_appointment → «Подтверждаете?»
  → пациент «Да» → create_appointment(confirmed=true) → crm_book_slot → appointments
  → Realtime → календарь CRM
```

## Защита от записи без подтверждения (на сервере, не в промпте)

`create_appointment` создаёт запись, только если одновременно:
- `confirmed === true`;
- в `conversations.agent_state.pending_booking` есть слот, зафиксированный `propose_appointment`,
  и он взят из последнего `check_free_slots` (реальные врачи, график, занятость);
- услуга/врач/дата/время совпадают с этим слотом;
- после предложения пришло ОТДЕЛЬНОЕ входящее сообщение пациента с явным «да»
  (да, ок, подтверждаю, хорошо, +, 👍 …) и ни одного отказа (нет, не надо, отмена, другое время …);
- предложению не больше 2 часов, услуга `ai_bookable`, слот свободен (`crm_book_slot` с блокировкой врача).

Ответ модели «Вы записаны» без успешного `create_appointment` в этом же проходе заменяется
просьбой подтвердить (`guardReply` в `runner.ts`). Успешный ответ содержит `appointment_id` и номер записи (`crm_ref`).

## Дубли
- тот же вебхук → `webhook_events.dedupe_key` (sha256 тела);
- то же сообщение → уникальный `(integration_id, external_message_id)`;
- два сообщения подряд → `conversations.agent_lock_until`: второй запуск не стартует, первый после ответа
  подхватывает новые входящие;
- одна и та же запись дважды → `pending_booking` очищается после создания, `crm_book_slot` отклоняет пересечение.

## Миграции (по порядку)
```
20261005090000_crm_multitenant.sql
20261006090000_whatsapp_channel.sql
20261006120000_whatsapp_qr.sql          (не нужна для Meta, но безвредна)
20261007090000_crm_tables_source_of_truth.sql
20261008090000_whatsapp_mvp_booking.sql (новая)
```

## Переменные окружения (секреты функций Supabase)
| Переменная | Значение |
| --- | --- |
| `PUBLIC_WEBHOOK_BASE_URL` | `https://<project-ref>.supabase.co/functions/v1` |
| `AI_AGENT_PROTOCOL` | `openai` |
| `AI_AGENT_URL` | `https://api.openai.com/v1` |
| `AI_AGENT_MODEL` | `gpt-4o-mini` |
| `AI_AGENT_TOKEN` | ключ OpenAI |
| `AI_AGENT_TIMEOUT_MS` | `25000` (необязательно) |
| `WHATSAPP_GRAPH_VERSION` | `v20.0` (необязательно) |
| `WHATSAPP_WORKER_SECRET` | случайная строка |
| `WHATSAPP_ALLOW_MOCK` | НЕ задавать на проде |

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` Supabase подставляет сам. Токен Meta, App secret и verify token
вводятся в CRM и хранятся только в Vault (`wa_put_secret`), во фронтенд не возвращаются.

## Деплой
```bash
supabase link --project-ref <project-ref>
supabase db push
supabase secrets set PUBLIC_WEBHOOK_BASE_URL=https://<project-ref>.supabase.co/functions/v1 \
  AI_AGENT_PROTOCOL=openai AI_AGENT_URL=https://api.openai.com/v1 AI_AGENT_MODEL=gpt-4o-mini \
  AI_AGENT_TOKEN=sk-... WHATSAPP_WORKER_SECRET=$(openssl rand -hex 24)
supabase functions deploy whatsapp
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase functions deploy whatsapp-worker  --no-verify-jwt
```
Воркер повторной отправки — раз в минуту `POST .../functions/v1/whatsapp-worker` с заголовком `x-worker-secret`.

## Настройка в Meta
1. developers.facebook.com → My Apps → Create App → тип **Business** → добавить продукт **WhatsApp**.
2. Business Manager → WhatsApp Accounts: WhatsApp Business Account (WABA) клиники; добавить номер,
   подтвердить SMS/звонком, задать display name (нужна модерация имени).
3. Business Settings → System Users → создать System User (Admin) → Add Assets: приложение и WABA (Full control)
   → Generate token с правами `whatsapp_business_messaging`, `whatsapp_business_management`, срок «Never».
4. App Settings → Basic → **App Secret** (Show).
5. WhatsApp → API Setup: **Phone number ID** и **WhatsApp Business Account ID**.
6. Для продакшена: метод оплаты в WABA, Business Verification, приложение в режиме **Live**
   (в режиме Development сообщения приходят только с номеров из списка тестовых).

Embedded Signup в архитектуре не предусмотрен — подключение вручную по токену System User.

## Подключение номера
1. CRM → WhatsApp → Подключение → «WhatsApp Cloud API» → Phone number ID, WABA ID, токен, App secret → «Подключить».
   Сервер проверит номер в Graph API и подпишет приложение на WABA (`/subscribed_apps`).
2. CRM покажет **Callback URL** (`.../whatsapp-webhook/<webhook_key>`) и **Verify token** (один раз — скопируйте).
3. Meta → WhatsApp → Configuration → Webhook → Edit: вставить Callback URL и Verify token → Verify and save.
4. Там же Webhook fields → **messages** → Subscribe.
5. В CRM статус вебхука станет «подтверждён». Включить робота: WhatsApp → Робот → включено;
   у услуг, которые робот может записывать сам, — «запись роботом».
6. Проверить данные: врачи активны и с часами работы, услуги активны с длительностью, часовой пояс компании (`tenants.timezone`).

Одно приложение Meta = один Callback URL. Для второй клиники нужен свой Meta App
(или следующий шаг — override callback URL на уровне WABA).

## Тест MVP
1. Подключить номер (шаги выше), вебхук «подтверждён».
2. С другого телефона: «Здравствуйте, хочу на чистку завтра после 16».
3. В CRM → WhatsApp появился диалог и сообщение.
4. Робот ответил; в журнале действий: `get_services`, `check_free_slots`.
5. Названы реальные окна, которые есть в календаре CRM.
6. Ответить время, например «16:30» → робот присылает сводку и «Подтверждаете запись?».
7. **В календаре записи НЕТ**, в `appointments` нет строки с этим `conversation_id`.
8. Ответить «Да».
9. Робот: «Вы записаны… номер записи N».
10. `appointments`: строка `source='whatsapp_ai'`, `status='scheduled'`; `patients`: пациент с именем и номером.
11. Календарь CRM показал запись без перезагрузки.
12. Повторить с ответом «Нет» → записи нет. «Взять диалог» → робот молчит; «Вернуть робота» → отвечает.

Автотесты (сервер разработки с mock-провайдером и `dev-agent-stub`): `tests/whatsapp_e2e.test.ts`,
TEST 2 и 2b проверяют, что без «Да» запись не создаётся.
