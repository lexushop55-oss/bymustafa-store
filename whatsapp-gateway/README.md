# Шлюз WhatsApp по QR-коду

Держит сессии WhatsApp Web (библиотека Baileys) для всех клиник: каждая клиника
сканирует свой QR в CRM, и её номер работает через этот шлюз. Отвечает робот CRM
(инструменты: слоты, записи, пациенты), шлюз только передаёт сообщения.

```
Телефон клиники ⇄ WhatsApp ⇄ шлюз (Baileys) ⇄ Supabase: whatsapp-webhook / whatsapp ⇄ CRM + робот
```

## Где запускать

Шлюз должен работать постоянно и быть доступен из интернета по HTTPS.
Подходит любой VPS (Timeweb, Selectel, Hetzner) или Railway/Render **с постоянным диском** —
в папке сессий хранится вход в WhatsApp, без диска после перезапуска придётся снова сканировать QR.
Serverless (Supabase Functions, Vercel) не подходит.

### VPS + Docker
```bash
git clone <ваш репозиторий> && cd whatsapp-gateway
echo "GATEWAY_SECRET=$(openssl rand -hex 24)" > .env
docker build -t dentaline-wa .
docker run -d --restart=always --env-file .env -p 8787:8787 -v wa-data:/data --name dentaline-wa dentaline-wa
```
HTTPS — через Caddy/nginx перед портом 8787 (например, `wa.вашдомен.ru`).

### Без Docker
```bash
npm install
cp .env.example .env   # впишите GATEWAY_SECRET
npm start
```

## Связать с CRM

```bash
supabase secrets set WA_GATEWAY_URL=https://wa.вашдомен.ru WA_GATEWAY_SECRET=<тот же GATEWAY_SECRET>
supabase functions deploy whatsapp
supabase functions deploy whatsapp-webhook --no-verify-jwt
supabase db push
```
Затем в CRM: WhatsApp → Подключение → «По QR-коду» → «Показать QR-код» →
на телефоне клиники WhatsApp → Настройки → Связанные устройства → Привязка устройства.

## Ваш прежний бот

Остановите старый скрипт на компьютере перед подключением того же номера — иначе на
каждое сообщение ответят оба. Его «мозг» переносится в CRM:
```bash
supabase secrets set AI_AGENT_PROTOCOL=openai AI_AGENT_URL=https://api.openai.com/v1 \
  AI_AGENT_MODEL=gpt-4o-mini AI_AGENT_TOKEN=<ключ OpenAI>
```
Текст системной инструкции администратора вставьте в CRM: WhatsApp → Робот → «Инструкция роботу».
В отличие от старого бота, робот CRM видит реальное расписание и сам создаёт, переносит и отменяет записи.

## Важно

- Это неофициальный способ (WhatsApp Web). WhatsApp может заблокировать номер за массовые
  рассылки или жалобы. Для ответов пациентам, которые написали сами, риск низкий; рассылки
  по базе через этот канал не делайте. Официальный путь — WhatsApp Cloud API (тоже есть в CRM).
- Телефон с WhatsApp должен выходить в интернет хотя бы раз в 14 дней, иначе привязка слетит.
- Папка `sessions/` — это доступ к WhatsApp клиник. Не коммитьте её и не передавайте.
