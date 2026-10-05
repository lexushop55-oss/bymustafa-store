# DentaLine CRM

Статический сайт: публичная страница и вход (`DentaLine.dc.html`), CRM клиники
(`DentaLine Dashboard.dc.html`), кабинет разработчика (`Developer Portal.dc.html`).
Сборка не нужна — файлы открываются браузером как есть.

## Публикация на GitHub Pages

1. Создайте репозиторий на github.com (например, `dentaline-crm`).
2. Загрузите в корень **всё содержимое этой папки** (Add file → Upload files или `git push`).
   Файл `.nojekyll` обязателен — без него GitHub Pages обрабатывает сайт через Jekyll.
3. Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, папка `/ (root)` → Save.
4. Через 1–2 минуты сайт будет доступен по адресу `https://<логин>.github.io/<репозиторий>/`.

Через git:
```bash
cd deploy
git init && git add -A && git commit -m "DentaLine CRM"
git branch -M main
git remote add origin https://github.com/<логин>/<репозиторий>.git
git push -u origin main
```

## Режимы

- `dentaline.config.js` пустой → **демо-режим**: данные хранятся в браузере, вход `1` / `1` (клиника),
  `Salah-13` / `Salah-13` (кабинет разработчика).
- Заполнен `supabaseUrl` и `supabaseAnonKey` → боевой режим. Anon-ключ публичный по замыслу Supabase,
  его можно хранить в репозитории; доступ к данным ограничивает RLS. Ключ `service_role` и токены
  WhatsApp в репозиторий **не кладутся** — они задаются через `supabase secrets set`.

Бэкенд (миграции и Edge Functions) — в `backend/`; развёртывание описано в
`backend/DEPLOY.md` и `backend/WHATSAPP.md`. GitHub Pages его не запускает — он деплоится в Supabase.
В Supabase → Auth → URL Configuration добавьте адрес сайта GitHub Pages в Site URL и Redirect URLs.
