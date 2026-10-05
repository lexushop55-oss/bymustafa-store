# DentaLine Platform · admin API

Суперадмин-бэкенд для панели `Developer Portal.dc.html`: health-check платформы,
переподключение интеграций, impersonation и смена тарифов.

```
backend/supabase/
  migrations/20260901120000_admin_platform.sql   роли, аудит, интеграции, очереди, RLS
  migrations/20260902090000_admin_hardening.sql  rate limit, архив аудита, prune + pg_cron
  functions/_shared/http.ts                      CORS, JSON, HttpError, timed, fetchWithTimeout
  functions/_shared/auth.ts                      requireSuperadmin, audit, Vault-секреты
  functions/_shared/ratelimit.ts                 in-memory окно + admin_rate_limit_hit()
  functions/admin/index.ts                       роутер
  functions/admin/health.ts                      GET  /health
  functions/admin/reconnect.ts                   POST /integrations/reconnect
  functions/admin/impersonate.ts                 POST /auth/impersonate
  functions/admin/plan.ts                        PATCH /tenants/:id/plan
```

## Вход, регистрация и изоляция компаний (CRM)

Канал WhatsApp и робот через инструменты CRM — см. [`WHATSAPP.md`](./WHATSAPP.md).

```
migrations/20261005090000_crm_multitenant.sql   company_id во всех сущностях CRM, RLS, триггер регистрации, my_workspace()
functions/admin/companies.ts                    POST /tenants — компания + владелец Owner (приглашение или временный пароль)
../../auth.js, ../../dentaline.config.js        клиент: Supabase Auth, сессия, защита кабинета
../../DentaLine.dc.html                         публичная страница, вход, регистрация, восстановление пароля
```

- **Компания = `tenants`**, связь пользователя — `tenant_members (tenant_id, user_id, role, is_active)`. Роли: Owner, Admin, Manager, Employee. Один пользователь — одна компания.
- **Регистрация**: фронт вызывает `supabase.auth.signUp` с `data: { full_name, company_name }`; триггер `on_auth_user_created` в той же транзакции создаёт компанию и делает пользователя Owner. Повторно вводить данные не нужно.
- **После входа** фронт вызывает `rpc('my_workspace')`: компания, роль и `access` (`ok` / `inactive` / `no_company`). Неактивный участник или компания в статусе Suspended/Inactive в кабинет не попадает.
- **RLS**: каждая таблица CRM (`patients`, `appointments`, `payments`, `services`, `doctors`, `tasks`, `lead_requests`, `ai_settings`, `activity_logs`, `subscriptions`, `workspace_state`) читается только при `company_id = current_company_id()`; запись — по ролям. Прямой запрос через REST API с чужим `company_id` возвращает 0 строк, insert — ошибку политики.
- **Данные кабинета.** Пациенты, записи, врачи и услуги — только в таблицах `patients`, `appointments`, `doctors`, `services` (CRM читает и пишет их через `crm-data.js`, робот WhatsApp — через `tools.ts`; Realtime доставляет изменения в открытую CRM). `crm_ref` — ключ интерфейса, `crm jsonb` — поля без своей колонки (план лечения, оплаты, кресло). Миграция `20261007090000_crm_tables_source_of_truth.sql`. Остальные разделы (заявки, задачи, настройки интерфейса) пока хранятся документом в `workspace_state`; старый снимок с пациентами/записями переносится в таблицы при первом входе и перезаписывается без них.
- **Компании из кабинета разработчика**: `POST /api/admin/tenants` (только суперадмин). Пароль владельца задаётся на сервере через service_role; режим `invite` отправляет письмо, владелец сам задаёт пароль. Ключ service_role во фронтенд не попадает.
- **Восстановление пароля**: `resetPasswordForEmail` → ссылка ведёт на `DentaLine.dc.html#/reset`. В Supabase → Auth → URL Configuration добавьте адрес CRM в Redirect URLs.

Подключение фронта — заполнить `dentaline.config.js`:

```js
window.DENTALINE_CONFIG = { supabaseUrl: 'https://<project>.supabase.co', supabaseAnonKey: '<anon key>' };
```

Пока поля пустые, работает демо-режим: учётные записи хранятся в браузере (пароли — только PBKDF2-хеш), вход `1`/`1` открывает демо-клинику, `Salah-13` — кабинет разработчика. В боевом режиме эти реквизиты не работают.

Проверка изоляции после деплоя: зарегистрировать двух владельцев, под токеном первого выполнить
`GET /rest/v1/patients?company_id=eq.<id второй компании>` — ожидается `[]`.

## Развёртывание

Пошаговый чеклист с проверками, SQL для назначения суперадмина и разбором типовых
ошибок — в [`DEPLOY.md`](./DEPLOY.md). Кратко:

```bash
supabase link --project-ref <project>  # один раз
supabase db push                       # применить обе миграции по порядку
supabase functions deploy admin        # задеплоить функцию с роутером
```

Проверка после деплоя:

```bash
curl -i -H "Authorization: Bearer <superadmin-jwt>" \
  https://<project>.functions.supabase.co/admin/health
# ожидаем 200 и db.status = ok; без токена — 401
```

Публичный путь функции — `/functions/v1/admin/*`. Панель обращается к `/api/admin/*`,
поэтому в прокси (nginx / Vercel rewrite) нужен один маппинг:

```
/api/admin/(.*)  ->  https://<project>.functions.supabase.co/admin/$1
```

Либо задать панели базу напрямую: `localStorage.dentaline_api_base = 'https://<project>.functions.supabase.co/admin'`
(в этом случае префикс `/api/admin` отрезается роутером сам).

## Переменные окружения функции

| Переменная | Назначение |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | подставляются платформой; service_role используется только после проверки роли |
| `SUPABASE_JWT_SECRET` | подпись impersonation-токена (HS256) |
| `SUPABASE_ANON_KEY` | пинг проб-функции |
| `ADMIN_ALLOWED_ORIGINS` | список origin через запятую; пусто = отражать origin запроса |
| `EDGE_PROBE_URL` | лёгкий эндпоинт для замера Edge Functions (например `/functions/v1/health-probe`) |
| `PUBLIC_WEBHOOK_BASE_URL` | база вебхуков: `<base>/<type>/<tenantId>` |
| `WHATSAPP_GRAPH_VERSION` | версия Graph API, по умолчанию `v20.0` |
| `TELEGRAM_WEBHOOK_SECRET` | `secret_token` для `setWebhook` |
| `CRM_APP_URL` | адрес CRM клиники для redirect после impersonation |
| `IMPERSONATION_TTL_SECONDS` | срок жизни токена, по умолчанию 600 |

```bash
supabase secrets set SUPABASE_JWT_SECRET=... PUBLIC_WEBHOOK_BASE_URL=... CRM_APP_URL=...
```

## Модель доступа

1. **Роль не берётся из JWT.** `requireSuperadmin` валидирует токен в Auth, затем читает
   `platform_admins` (активная запись, `role = 'superadmin'`). Подделать claim бесполезно.
2. **Impersonation не эскалируется.** Выданный токен несёт `app_metadata.impersonated_by`;
   middleware отклоняет такие токены на входе в admin-API (403 `impersonation_denied`).
3. **RLS включён на всех таблицах.** Клиника видит только свои строки через `tenant_members`;
   суперадмин — всё через `is_superadmin()`. `INSERT/UPDATE/DELETE` на `tenants`,
   `tenant_integrations`, `admin_audit_logs`, `integration_jobs` у ролей `authenticated`/`anon`
   отозваны — писать может только service_role внутри функций.
4. **Тариф меняется только через `admin_set_tenant_plan(tenant, plan, actor)`** —
   SECURITY DEFINER с повторной проверкой роли в БД и записью в аудит.
5. **Аудит append-only.** `admin_audit_logs` доступен суперадмину на чтение; update/delete
   не выданы никому, кроме service_role.
6. **Секреты в Vault.** В `tenant_integrations.secret_ref` лежит имя секрета,
   значение читается через `vault.decrypted_secrets`; токены каналов в таблицах не хранятся.

## Контракты

```http
GET /api/admin/health
200 {
  "db":            { "status": "ok", "latency": 11 },
  "edgeFunctions": { "status": "ok", "latency": 82 },
  "whatsapp": { "status": "degraded", "latency": 210,
                "tenants": [{ "tenantId": "...", "name": "Beauty Lab", "status": "down", "error": "..." }] },
  "telegram": { "status": "ok", "latency": 190, "tenants": [...] },
  "queues":   { "pending": 56, "failed": 1,
                "byQueue": [{ "queue": "wa_out", "pending": 12, "failed": 0, "oldest_sec": 8 }] },
  "checkedAt": "2026-09-01T09:12:00.000Z"
}

POST /api/admin/integrations/reconnect
     { "tenantId": "uuid", "integrationType": "whatsapp" }
200  { "success": true, "message": "Beauty Lab: WhatsApp Cloud API переподключён", "status": "ok", "latency": 340 }
502  { "success": false, "code": "provider_error", "message": "Beauty Lab: Токен отклонён (HTTP 401)" }

POST /api/admin/auth/impersonate
     { "targetTenantId": "uuid" }
200  { "success": true, "token": "<jwt>", "expiresAt": "...", "tenant": { "id": "...", "name": "..." },
       "redirectUrl": "https://crm.example#impersonation_token=..." }

PATCH /api/admin/tenants/<uuid>/plan
     { "plan": "Professional" }
200  { "success": true, "message": "Тариф изменён: Professional" }
```

Ошибки всегда приходят как `{ success:false, code, message }` — панель показывает `message`
в toast без подстановки собственного текста.

## Очереди

`integration_jobs` — рабочая таблица воркера; вьюха `queue_stats` агрегирует
`pending` / `failed` / `oldest_sec` по каждой очереди, её и читает health-эндпоинт.
Воркер берёт задания `select ... where status='pending' and scheduled_at <= now()
for update skip locked`, увеличивает `attempts`, при `attempts >= max_attempts`
переводит в `dead`.

## Таймауты внешних вызовов

Все обращения к Graph API (WhatsApp), Bot API (Telegram) и edge-пробе идут только через
`fetchWithTimeout` — `AbortController` с жёстким потолком: `EXTERNAL_TIMEOUT_DEFAULT_MS = 5000`,
`EXTERNAL_TIMEOUT_MAX_MS = 6000` (значение больше потолка молча урезается). `AbortError`
переписывается в читаемое `Таймаут N мс: <host> не ответил` — этот текст уходит
в `tenant_integrations.last_error` и в toast.

| Вызов | Бюджет |
| --- | --- |
| `GET /health` · WhatsApp `GET /{phone_number_id}` | 5000 мс |
| `GET /health` · Telegram `getWebhookInfo` | 5000 мс |
| `GET /health` · edge-проба | 4000 мс |
| `GET /health` · `db_ping` (нет signal → `withDeadline`) | 5000 мс |
| `POST /reconnect` · Graph проверка токена | 5000 мс |
| `POST /reconnect` · `subscribed_apps` / `setWebhook` | 6000 мс |

Пробы в `/health` выполняются через `Promise.all`, поэтому верхняя граница ответа роута —
самая медленная проба (≈6 с), а не их сумма. Запись статусов в `tenant_integrations`
тоже параллельная.

## Rate limiting

`_shared/ratelimit.ts` — два уровня: in-memory окно внутри изолята (бесплатно отсекает флуд)
и атомарный счётчик в Postgres `admin_rate_limit_hit()` (единый для всех изолятов, row-lock
`for update`). При превышении — `429` с `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Window`
и человекочитаемым `message`.

| Эндпоинт | Ключ | Лимит | Мин. интервал |
| --- | --- | --- | --- |
| `POST /auth/impersonate` | `impersonate:actor:<userId>` | 10 / 5 мин | 3 с |
| `POST /integrations/reconnect` | `reconnect:actor:<userId>` | 20 / 10 мин | 2 с |
| `POST /integrations/reconnect` | `reconnect:target:<tenantId>:<type>` | 5 / 10 мин | 30 с |

Лимит по цели не зависит от актора: два разных админа не могут по очереди дёргать одну
интеграцию. Если RPC недоступен, решение остаётся за in-memory окном (ошибка пишется в лог).

## Retention аудита

`admin_audit_logs` остаётся append-only. Обслуживание — `public.admin_audit_prune(hot_days,
archive_days, probe_days, batch)`: логи старше `hot_days` (90) батчами переезжают
в `admin_audit_logs_archive`, из архива удаляются старше `archive_days` (540 ≈ 18 мес),
`health_probe_log` чистится по `probe_days` (30), плюс подчищаются истёкшие ключи
`admin_rate_limits`. Архив без FK на `tenants` — удаление клиники не рушит историю;
читать его может суперадмин, писать — только функция (`security definer`, grant только
`service_role`).

Расписание: pg_cron job `admin_audit_prune_nightly`, `25 3 * * *` UTC →
`select public.admin_audit_prune(90, 540, 30);`. Если pg_cron в проекте не включён,
миграция не падает (`raise notice`) — вызывайте функцию из внешнего планировщика.
Для 180-дневного окна достаточно поменять аргумент в расписании, схема та же.
