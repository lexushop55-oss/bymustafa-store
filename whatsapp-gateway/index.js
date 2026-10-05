// DentaLine · шлюз WhatsApp по QR-коду (Baileys).
// Одна сессия WhatsApp Web на каждое подключение компании. CRM управляет сессиями
// по HTTP (с общим секретом), шлюз пересылает входящие в вебхук CRM с HMAC-подписью.
//
//   POST /sessions/:id/start   { webhookUrl, signingSecret }   запустить / показать QR
//   GET  /sessions/:id                                         { state, qr, phone, name }
//   POST /sessions/:id/send    { to, text }                    отправить сообщение
//   POST /sessions/:id/logout                                  отвязать номер, удалить сессию
//   GET  /health
// Все запросы, кроме /health: Authorization: Bearer <GATEWAY_SECRET>.

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import * as B from '@whiskeysockets/baileys';

const makeWASocket = B.makeWASocket || (B.default && (B.default.default || B.default));
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = B.default && !B.useMultiFileAuthState ? B.default : B;

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.GATEWAY_SECRET || '';
const DIR = path.resolve(process.env.SESSIONS_DIR || './sessions');
if (SECRET.length < 24) { console.error('GATEWAY_SECRET не задан или короче 24 символов'); process.exit(1); }

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const quiet = pino({ level: 'silent' });
const sessions = new Map(); // id -> { sock, state, qr, phone, name, meta, retries, stopping }
const ID_RE = /^[a-z0-9-]{8,64}$/i;

const sessionDir = (id) => path.join(DIR, id);
const metaPath = (id) => path.join(sessionDir(id), 'dentaline.json');
async function readMeta(id) { try { return JSON.parse(await fs.readFile(metaPath(id), 'utf8')); } catch { return null; } }
async function writeMeta(id, meta) { await fs.mkdir(sessionDir(id), { recursive: true }); await fs.writeFile(metaPath(id), JSON.stringify(meta)); }

// ---------- доставка событий в CRM: подпись + повторы ----------
async function post(meta, body, attempt = 0) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', meta.signingSecret).update(raw).digest('hex');
  try {
    const r = await fetch(meta.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gateway-signature': sig }, body: raw, signal: AbortSignal.timeout(15000) });
    if (r.status >= 500 || r.status === 429) throw new Error('HTTP ' + r.status);
    if (!r.ok) log.warn({ status: r.status }, 'CRM отклонила событие');
  } catch (e) {
    if (attempt >= 6) { log.error({ err: e.message }, 'событие не доставлено в CRM'); return; }
    const delay = Math.min(60000, 2000 * 2 ** attempt);
    setTimeout(() => post(meta, body, attempt + 1), delay);
  }
}

const userDigits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

function textOf(m) {
  const x = m.message || {};
  const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x;
  return inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption
    || inner.documentMessage?.caption || inner.buttonsResponseMessage?.selectedDisplayText || inner.listResponseMessage?.title || null;
}
function typeOf(m) {
  const x = m.message || {};
  if (x.conversation || x.extendedTextMessage) return 'text';
  if (x.imageMessage) return 'image';
  if (x.audioMessage) return 'audio';
  if (x.videoMessage) return 'video';
  if (x.documentMessage) return 'document';
  if (x.locationMessage) return 'location';
  return 'unsupported';
}

// ---------- сессия ----------
async function start(id) {
  const prev = sessions.get(id);
  if (prev?.sock && prev.state !== 'closed' && prev.state !== 'logged_out') return prev;
  const meta = await readMeta(id);
  if (!meta) throw new Error('session_not_configured');
  const { state: auth, saveCreds } = await useMultiFileAuthState(sessionDir(id));
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* версия по умолчанию */ }
  const s = prev || { state: 'starting', qr: null, phone: null, name: null, retries: 0 };
  s.meta = meta; s.state = 'starting'; s.stopping = false;
  sessions.set(id, s);

  const sock = makeWASocket({ ...(version ? { version } : {}), auth, logger: quiet, printQRInTerminal: false,
    browser: Browsers ? Browsers.macOS('DentaLine CRM') : ['DentaLine CRM', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false });
  s.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { s.qr = await QRCode.toDataURL(qr, { margin: 1, width: 280 }); s.state = 'qr'; }
    if (connection === 'open') {
      s.state = 'connected'; s.qr = null; s.retries = 0;
      s.phone = userDigits(sock.user?.id); s.name = sock.user?.name || sock.user?.verifiedName || null;
      log.info({ id, phone: s.phone }, 'номер подключён');
      post(s.meta, { type: 'connection', session: id, state: 'connected', phone: s.phone, name: s.name, ts: Date.now() });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (s.stopping) return;
      if (code === DisconnectReason.loggedOut) {
        s.state = 'logged_out'; s.qr = null; s.sock = null;
        await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => {});
        await writeMeta(id, s.meta); // настройки вебхука сохраняем — можно снова показать QR
        log.warn({ id }, 'номер отвязан в телефоне');
        post(s.meta, { type: 'connection', session: id, state: 'logged_out', phone: s.phone, ts: Date.now() });
        return;
      }
      s.state = 'reconnecting'; s.sock = null;
      const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30000, 1000 * 2 ** s.retries++);
      setTimeout(() => start(id).catch((e) => log.error({ id, err: e.message }, 'переподключение не удалось')), delay);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    const out = [];
    for (const m of messages) {
      const jid = m.key.remoteJid || '';
      if (m.key.fromMe || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || !m.message) continue;
      // Новые аккаунты приходят с @lid; настоящий номер — в senderPn / remoteJidAlt.
      const pnJid = jid.endsWith('@s.whatsapp.net') ? jid : (m.key.senderPn || m.key.remoteJidAlt || null);
      const contact = userDigits(pnJid || jid);
      s.meta.contacts = s.meta.contacts || {};
      if (s.meta.contacts[contact] !== jid) { s.meta.contacts[contact] = jid; writeMeta(id, s.meta).catch(() => {}); }
      out.push({ id: m.key.id, from: contact, phoneKnown: !!pnJid, name: m.pushName || null, type: typeOf(m), text: textOf(m),
        ts: Number(m.messageTimestamp) || Math.floor(Date.now() / 1000) });
    }
    if (out.length) post(s.meta, { type: 'message', session: id, messages: out });
  });
  return s;
}

async function stop(id, logout) {
  const s = sessions.get(id);
  if (s) s.stopping = true;
  if (s?.sock) { try { logout ? await s.sock.logout() : s.sock.end(undefined); } catch { /* уже закрыта */ } }
  sessions.delete(id);
  if (logout) await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => {});
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/health', (_q, r) => r.json({ ok: true, sessions: sessions.size }));
app.use((q, r, next) => {
  const h = q.headers.authorization || '';
  const got = Buffer.from(h.replace(/^Bearer\s+/i, '')), want = Buffer.from(SECRET);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return r.status(401).json({ error: 'unauthorized' });
  next();
});
const sid = (q, r) => { const id = q.params.id; if (!ID_RE.test(id)) { r.status(400).json({ error: 'bad_session_id' }); return null; } return id; };
const view = (s) => ({ state: s?.state || 'closed', qr: s?.qr || null, phone: s?.phone || null, name: s?.name || null });

app.post('/sessions/:id/start', async (q, r) => {
  const id = sid(q, r); if (!id) return;
  const { webhookUrl, signingSecret } = q.body || {};
  if (!/^https:\/\//.test(webhookUrl || '') || String(signingSecret || '').length < 24) return r.status(400).json({ error: 'webhookUrl (https) и signingSecret обязательны' });
  const old = await readMeta(id);
  await writeMeta(id, { webhookUrl, signingSecret, contacts: old?.contacts || {} });
  const cur = sessions.get(id);
  if (cur && cur.state === 'logged_out') sessions.delete(id);
  try {
    const s = await start(id);
    s.meta.webhookUrl = webhookUrl; s.meta.signingSecret = signingSecret;
    // QR появляется через ~1–2 с после старта.
    for (let i = 0; i < 20 && s.state === 'starting'; i++) await new Promise((ok) => setTimeout(ok, 150));
    r.json(view(s));
  } catch (e) { r.status(500).json({ error: e.message }); }
});

app.get('/sessions/:id', async (q, r) => {
  const id = sid(q, r); if (!id) return;
  let s = sessions.get(id);
  if (!s && (await readMeta(id))) s = await start(id).catch(() => null);
  r.json(view(s));
});

app.post('/sessions/:id/send', async (q, r) => {
  const id = sid(q, r); if (!id) return;
  const s = sessions.get(id);
  if (!s?.sock || s.state !== 'connected') return r.status(503).json({ error: 'Номер не подключён к шлюзу', retryable: s?.state !== 'logged_out' });
  const to = String(q.body?.to || '').replace(/\D/g, ''), text = String(q.body?.text || '');
  if (to.length < 8 || !text) return r.status(400).json({ error: 'to и text обязательны', retryable: false });
  const jid = s.meta.contacts?.[to] || `${to}@s.whatsapp.net`;
  try {
    await s.sock.presenceSubscribe(jid).catch(() => {});
    await s.sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await new Promise((ok) => setTimeout(ok, Math.min(2500, 400 + text.length * 15)));
    await s.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    const sent = await s.sock.sendMessage(jid, { text });
    r.json({ id: sent?.key?.id });
  } catch (e) { r.status(502).json({ error: e.message, retryable: true }); }
});

app.post('/sessions/:id/logout', async (q, r) => {
  const id = sid(q, r); if (!id) return;
  await stop(id, true);
  r.json({ ok: true });
});

// Восстановить сессии после перезапуска — QR повторно не нужен.
await fs.mkdir(DIR, { recursive: true });
for (const id of await fs.readdir(DIR)) {
  if (!ID_RE.test(id)) continue;
  const hasCreds = await fs.stat(path.join(sessionDir(id), 'creds.json')).then(() => true, () => false);
  if (hasCreds && (await readMeta(id))) start(id).catch((e) => log.error({ id, err: e.message }, 'сессия не восстановлена'));
}
app.listen(PORT, () => log.info(`Шлюз WhatsApp слушает :${PORT}, сессии в ${DIR}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { for (const s of sessions.values()) { s.stopping = true; s.sock?.end(undefined); } process.exit(0); });
