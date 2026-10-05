# DentaLine Platform · чеклист деплоя

Пошаговое развёртывание admin-бэкенда для `Developer Portal.dc.html`.
Порядок важен: миграции → секреты → функция → назначение суперадмина → проверка.

Что подставить своё: `<project>` (project-ref Supabase), `<region>`, домены,
email/uuid суперадмина.

---

## 0. Предварительные требования

```bash
supabase --version          # >= 1.200; ниже — нет части флагов functions deploy
supabase login
supabase link --project-ref <project>
```

- Доступ к проекту с ролью Owner/Admin (иначе `secrets set` и `db push` отвалятся на 403).
- Хотя бы один пользователь в `auth.users` — он станет суперадмином (шаг 4).
- Расширения: `pgcrypto` (для `gen_random_uuid()`) и `supabase_vault` включены —
  в облачном Supabase оба по умолчанию есть. Проверка:

```sql
select extname from pg_extension where extname in ('pgcrypto','supabase_vault','pg_cron');
```

---

## 1. Миграции

```bash
supabase db push
```

Применяется по порядку:

| Файл | Что создаёт |
| --- | --- |
| `20260901120000_admin_platform.sql` | `tenants`, `tenant_members`, `platform_admins`, `tenant_integrations`, `admin_audit_logs`, `integration_jobs`, `health_probe_log`, вьюха `queue_stats`, `is_superadmin()`, `db_ping()`, `admin_set_tenant_plan()`, RLS + grants |
| `20260902090000_admin_hardening.sql` | `admin_rate_limits` + `admin_rate_limit_hit()`, `admin_audit_logs_archive` + `admin_audit_prune()`, pg_cron job `admin_audit_prune_nightly` |

Обе идемпотентны (`create ... if not exists`, `create or replace`, политики через
`pg_policies`-guard) — повторный `db push` на живой базе безопасен.

Проверка, что всё встало:

```sql
select tablename from pg_tables
 where schemaname = 'public'
   and tablename in ('platform_admins','tenant_integrations','admin_audit_logs',
                     'admin_audit_logs_archive','admin_rate_limits','integration_jobs');
-- ожидаем 6 строк

select proname from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('is_superadmin','db_ping','admin_set_tenant_plan',
                   'admin_rate_limit_hit','admin_audit_prune');
-- ожидаем 5 строк

select count(*) from pg_policies where schemaname = 'public';  -- > 0
select jobname, schedule from cron.job where jobname = 'admin_audit_prune_nightly';
```

Последний запрос вернёт 0 строк, если pg_cron не включён — это не ошибка деплоя,
см. «Типовые ошибки».

---

## 2. Секреты и переменные функции

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` платформа
подставляет сама — их задавать не нужно. Остальное:

```bash
supabase secrets set \
  SUPABASE_JWT_SECRET='<Settings → API → JWT Secret>' \
  PUBLIC_WEBHOOK_BASE_URL='https://api.example.com/webhooks' \
  CRM_APP_URL='https://crm.example.com' \
  EDGE_PROBE_URL='https://<project>.functions.supabase.co/functions/v1/health-probe' \
  TELEGRAM_WEBHOOK_SECRET='<произвольная строка 32+ симв.>' \
  WHATSAPP_GRAPH_VERSION='v20.0' \
  ADMIN_ALLOWED_ORIGINS='https://admin.example.com' \
  IMPERSONATION_TTL_SECONDS='600'
```

```bash
supabase secrets list        # проверить, что все ключи на месте
```

Замечания:

- `SUPABASE_JWT_SECRET` обязателен — без него `/auth/impersonate` вернёт 500.
- `EDGE_PROBE_URL` можно не задавать: проба Edge Functions тогда отдаст
  `status: "unknown"`, health останется 200.
- `ADMIN_ALLOWED_ORIGINS` пустой = отражать origin запроса. Для прода лучше
  перечислить домены явно, через запятую, **без слэша в конце**.

---

## 3. Деплой функции

```bash
supabase functions deploy admin
supabase functions list                    # admin: ACTIVE
supabase functions logs admin --tail       # держать в соседнем терминале при проверке
```

Публичный путь: `https://<project>.functions.supabase.co/admin/*`.
Панель дёргает `/api/admin/*`, поэтому нужен один rewrite:

```
# nginx
location /api/admin/ {
  proxy_pass https://<project>.functions.supabase.co/admin/;
}
```

```json
// vercel.json
{ "rewrites": [
  { "source": "/api/admin/:path*",
    "destination": "https://<project>.functions.supabase.co/admin/:path*" }
]}
```

Без прокси — задать базу панели прямо в браузере (DevTools → Console на странице портала):

```js
localStorage.dentaline_api_base = 'https://<project>.functions.supabase.co/admin';
location.reload();
```

Префикс `/api/admin` роутер отрезает сам, так что оба варианта рабочие.

---

## 4. Назначить суперадмина (Supabase SQL Editor)

Без активной строки в `platform_admins` любой admin-запрос вернёт **403
`forbidden`** — роль читается из БД, а не из JWT. Выполнить один из вариантов.

### Вариант А — по email

```sql
-- Подставьте свой email из auth.users.
insert into public.platform_admins (user_id, email, role, is_active)
select u.id, u.email, 'superadmin', true
  from auth.users u
 where lower(u.email) = lower('you@example.com')
on conflict (user_id) do nothing;
```

Если вставилось 0 строк — пользователя с таким email в Auth нет:

```sql
select id, email, created_at from auth.users order by created_at desc limit 20;
```

### Вариант Б — по uuid из auth.users

```sql
insert into public.platform_admins (user_id, email, role, is_active)
select u.id, u.email, 'superadmin', true
  from auth.users u
 where u.id = '00000000-0000-0000-0000-000000000000'::uuid
on conflict (user_id) do nothing;
```

### Реактивировать / повысить существующую запись

`ON CONFLICT DO NOTHING` не тронет строку, если она уже есть, но выключена
(`is_active = false`) или в роли `support`. Тогда:

```sql
update public.platform_admins
   set role = 'superadmin', is_active = true
 where lower(email) = lower('you@example.com');
```

### Проверить

```sql
select user_id, email, role, is_active, created_at from public.platform_admins;
select public.is_superadmin('<user_uuid>'::uuid);   -- true
```

`platform_admins` пишется только `service_role`, поэтому запросы выполняются
в **SQL Editor** (он идёт от service_role), а не из клиента с anon-ключом.

### Отозвать доступ

```sql
update public.platform_admins set is_active = false
 where lower(email) = lower('someone@example.com');
```

Мягкое отключение предпочтительнее `delete`: `admin_audit_logs.actor_id` останется
связанным с пользователем.

---

## 5. Верификация через curl

Токен суперадмина — `access_token` из ответа Auth (или `supabase.auth.getSession()`
в консоли панели):

```bash
export BASE='https://<project>.functions.supabase.co/admin'
export TOKEN='<access_token суперадмина>'
```

**5.1 Без токена — 401**

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health"      # 401
```

**5.2 Health — 200**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/health" | jq
```

Ожидаем `db.status = "ok"` и числовой `latency`. `whatsapp` / `telegram` вернут
`not_configured`, пока нет строк в `tenant_integrations` — это нормально.
Общее время ответа ≤ ~6 с (пробы идут параллельно); если дольше — смотрите,
какая проба висит, в `logs admin`.

**5.3 CORS preflight**

```bash
curl -si -X OPTIONS "$BASE/health" \
  -H 'Origin: https://admin.example.com' \
  -H 'Access-Control-Request-Method: GET' | grep -i '^access-control'
```

Должны прийти `access-control-allow-origin` с вашим доменом и
`access-control-allow-headers` с `authorization`.

**5.4 Rate limit — 429**

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "$i:%{http_code} " -X POST "$BASE/auth/impersonate" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"targetTenantId":"<uuid>"}'
done; echo
```

Первые ответы — 200/4xx по делу, дальше 429. Заголовки лимита:

```bash
curl -si -X POST "$BASE/auth/impersonate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"targetTenantId":"<uuid>"}' \
  | grep -iE 'retry-after|x-ratelimit'
```

Сброс счётчика в БД, если мешает тестировать:

```sql
delete from public.admin_rate_limits where key like 'impersonate:%';
```

**5.5 Смена тарифа**

```bash
curl -s -X PATCH "$BASE/tenants/<tenant_uuid>/plan" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"plan":"Professional"}' | jq
```

**5.6 Аудит записался**

```sql
select created_at, action, target_type, success
  from public.admin_audit_logs order by created_at desc limit 10;
```

**5.7 Retention руками**

```sql
select public.admin_audit_prune(90, 540, 30);
-- { "archived": 0, "purged": 0, "probes_deleted": 0, "limits_deleted": N }
```

---

## Типовые ошибки

**403 `forbidden` на всех эндпоинтах при валидном токене.**
Нет активной строки в `platform_admins` — шаг 4. Проверка:
`select public.is_superadmin('<uuid>'::uuid);`

**403 `impersonation_denied`.**
Вы зашли токеном, полученным через impersonation (`app_metadata.impersonated_by`).
Так и задумано: из-под клиники в admin-API не попасть. Войдите своим аккаунтом.

**401 на `/health` с корректным Bearer.**
Токен от другого проекта либо истёк. Перелогиньтесь; сверьте project-ref в `$BASE`.

**CORS: браузер режет запрос, curl работает.**
Причины по частоте: origin не в `ADMIN_ALLOWED_ORIGINS`; слэш в конце значения
(`https://admin.example.com/` ≠ origin); проксирование через домен, который в списке
не указан; preflight не доходит до функции, потому что nginx сам отвечает на OPTIONS.
Правьте список и redeploy:

```bash
supabase secrets set ADMIN_ALLOWED_ORIGINS='https://admin.example.com,https://staging.example.com'
supabase functions deploy admin
```

Секреты подхватываются только новым деплоем функции.

**pg_cron: `select ... from cron.job` → `relation "cron.job" does not exist`.**
Расширение не включено, миграция это проглотила (`raise notice`). Включите
в Dashboard → Database → Extensions → `pg_cron`, затем:

```sql
select cron.schedule('admin_audit_prune_nightly', '25 3 * * *',
                     $$select public.admin_audit_prune(90, 540, 30);$$);
```

Либо оставьте как есть и вызывайте `admin_audit_prune()` из внешнего планировщика
(GitHub Actions, cron на своём сервере) — функция для этого и разделена.

**`/health` отдаёт `edgeFunctions.status: "unknown"`.**
`EDGE_PROBE_URL` не задан или отвечает не 2xx. Проверьте руками:
`curl -s -o /dev/null -w '%{http_code}\n' "$EDGE_PROBE_URL"`.

**`Таймаут 5000 мс: graph.facebook.com не ответил`.**
Внешний API недоступен или медленный; текст попадает в `tenant_integrations.last_error`
и в toast панели. Потолок жёсткий (`EXTERNAL_TIMEOUT_MAX_MS = 6000`) и не поднимается
переменной — это защита от зависания роута.

**500 на `/auth/impersonate`.**
Не задан `SUPABASE_JWT_SECRET` (подпись HS256) или он от другого проекта.

**Reconnect: `secret_not_found` / пустой токен.**
`tenant_integrations.secret_ref` указывает на несуществующий секрет в Vault.
Значения токенов в таблицах не лежат — только имя секрета:

```sql
select name from vault.decrypted_secrets order by name;
select tenant_id, type, secret_ref, status from public.tenant_integrations;
```

**429 сразу на первом запросе.**
Сработал лимит по цели (`reconnect:target:<tenant>:<type>` — 5 / 10 мин,
мин. интервал 30 с) от предыдущего админа. Ждите `Retry-After` либо чистите
`admin_rate_limits` (см. 5.4).

**`permission denied for table platform_admins` из панели или psql с anon-ключом.**
Ожидаемо: запись отозвана у `authenticated`/`anon`. Используйте SQL Editor.

**`db push` спорит с историей миграций.**
На базе, где схема уже частично создана руками, применяйте файлы через SQL Editor
(они идемпотентны) или синхронизируйте историю `supabase migration repair`.

---

## Откат

Полного down-скрипта нет намеренно: файлы аддитивные, откат схемы на живых данных
опаснее, чем оставить неиспользуемые таблицы.

- Функция: `supabase functions delete admin` (панель начнёт получать сетевые ошибки).
- Расписание: `select cron.unschedule('admin_audit_prune_nightly');`
- Доступ: `update public.platform_admins set is_active = false;` — мгновенно
  закрывает admin-API всем, схему не трогает.

---

## Итоговый чеклист

- [ ] `supabase link` выполнен, версия CLI ≥ 1.200
- [ ] `supabase db push` — обе миграции применены, проверочные запросы дают 6 таблиц / 5 функций
- [ ] `supabase secrets list` — `SUPABASE_JWT_SECRET`, `CRM_APP_URL`, `PUBLIC_WEBHOOK_BASE_URL` на месте
- [ ] `supabase functions deploy admin` — статус ACTIVE
- [ ] rewrite `/api/admin/*` настроен (или задан `localStorage.dentaline_api_base`)
- [ ] строка в `platform_admins`, `is_superadmin()` = true
- [ ] `/health` без токена → 401, с токеном → 200 и `db.status = ok`
- [ ] CORS preflight отдаёт нужный origin
- [ ] `impersonate` упирается в 429 после лимита
- [ ] запись появилась в `admin_audit_logs`
- [ ] `cron.job` содержит `admin_audit_prune_nightly` (или заведён внешний планировщик)
