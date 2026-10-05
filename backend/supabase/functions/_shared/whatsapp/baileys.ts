// Провайдер «По QR-коду»: свой шлюз на Baileys (whatsapp-gateway/), одна сессия WhatsApp Web
// на подключение. Шлюз — инфраструктура платформы: WA_GATEWAY_URL и WA_GATEWAY_SECRET задаются
// секретами функций и в браузер не попадают. Подпись событий шлюза — HMAC-SHA256 секретом
// ЭТОГО подключения (app_secret_ref в Vault), заголовок x-gateway-signature.

import { fetchWithTimeout } from "../http.ts";
import {
  type ConnectionSecrets, digits, hmacSha256Hex, ProviderError, safeEqual, toE164,
  type WebhookBatch, type WhatsAppAdapter, type WhatsAppConnection,
} from "./types.ts";

export const gatewayConfigured = () => !!Deno.env.get("WA_GATEWAY_URL") && !!Deno.env.get("WA_GATEWAY_SECRET");

export interface GatewayView { state: "starting" | "qr" | "connected" | "reconnecting" | "logged_out" | "closed"; qr: string | null; phone: string | null; name: string | null }

export async function gateway(path: string, body?: unknown, timeout = 12000) {
  if (!gatewayConfigured()) throw new ProviderError("Шлюз WhatsApp не настроен на сервере (WA_GATEWAY_URL)", false, "no_gateway");
  let res: Response;
  try {
    res = await fetchWithTimeout(Deno.env.get("WA_GATEWAY_URL")!.replace(/\/$/, "") + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${Deno.env.get("WA_GATEWAY_SECRET")}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeout);
  } catch (e) {
    throw new ProviderError("Шлюз WhatsApp недоступен: " + (e as Error).message, true, "gateway_down");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new ProviderError(out?.error || `Шлюз: HTTP ${res.status}`, out?.retryable ?? res.status >= 500, `gateway_${res.status}`);
  return out;
}

export const startSession = (sessionId: string, webhookUrl: string, signingSecret: string) =>
  gateway(`/sessions/${sessionId}/start`, { webhookUrl, signingSecret }, 15000) as Promise<GatewayView>;
export const sessionView = (sessionId: string) => gateway(`/sessions/${sessionId}`) as Promise<GatewayView>;

export const baileysAdapter: WhatsAppAdapter = {
  id: "baileys",

  // Подключение по QR идёт в два шага (старт → скан), его ведёт функция `whatsapp` (/connect, /qr).
  async connect() { throw new ProviderError("Используйте подключение по QR-коду", false, "use_qr"); },

  async disconnect(conn: WhatsAppConnection) {
    if (conn.external_id) await gateway(`/sessions/${conn.external_id}/logout`, {}).catch(() => {});
  },

  async sendMessage(conn, _s, to, text) {
    const r = await gateway(`/sessions/${conn.external_id}/send`, { to: digits(to), text }, 20000);
    if (!r?.id) throw new ProviderError("Шлюз не вернул id сообщения", true, "no_id");
    return { externalMessageId: r.id };
  },

  async sendTemplate(conn, s, to, _template, _lang, params) {
    return this.sendMessage(conn, s, to, params.join(" "));
  },

  async getConnectionStatus(conn) {
    const t = performance.now();
    try {
      const v = await sessionView(conn.external_id!);
      return { api: v.state === "connected" ? "ok" : "down", latencyMs: Math.round(performance.now() - t),
        phoneE164: v.phone ? toE164(v.phone) : null, displayName: v.name, quality: null,
        error: v.state === "connected" ? null : v.state === "logged_out" ? "Номер отвязан в телефоне — подключите заново по QR" : "Сессия переподключается" };
    } catch (e) {
      return { api: "down", latencyMs: Math.round(performance.now() - t), phoneE164: null, displayName: null, quality: null, error: (e as Error).message };
    }
  },

  handleChallenge() { return null; },

  async verifyWebhook(req, rawBody, secrets: ConnectionSecrets) {
    if (!secrets.appSecret) return false;
    return safeEqual(req.headers.get("x-gateway-signature") ?? "", await hmacSha256Hex(secrets.appSecret, rawBody));
  },

  normalizeIncomingMessage(payload, conn): WebhookBatch {
    // deno-lint-ignore no-explicit-any
    const p = payload as any;
    if (p?.session !== conn.external_id) return { messages: [], statuses: [] };
    if (p.type === "connection") {
      return { messages: [], statuses: [], connection: { state: p.state, phone: p.phone ? toE164(p.phone) : null, name: p.name ?? null } };
    }
    if (p.type !== "message") return { messages: [], statuses: [] };
    return {
      statuses: [],
      messages: (p.messages ?? []).map((m: { id: string; from: string; name?: string; type?: string; text?: string | null; ts?: number }) => ({
        company_id: conn.tenant_id, integration_id: conn.id, channel: "whatsapp" as const, conversation_id: null,
        external_message_id: String(m.id), external_contact_id: digits(m.from), phone: toE164(m.from),
        customer_name: m.name ?? null, direction: "incoming" as const,
        message_type: (["text", "image", "audio", "video", "document", "location"].includes(m.type ?? "") ? m.type : "unsupported") as "text",
        text: m.text ?? null, media_url: null, payload: m, timestamp: new Date((m.ts ?? Date.now() / 1000) * 1000).toISOString(),
      })),
    };
  },
};
