// Тестовый провайдер ТОЛЬКО для разработки. Ничего не отправляет наружу.
// Включается переменной WHATSAPP_ALLOW_MOCK=true; в продакшене выключен,
// и подключение с provider = 'mock' функция `whatsapp` отклоняет.
//
// Формат входящего (свой, простой):
//   POST /whatsapp-webhook/<webhook_key>
//   x-mock-signature: hex(HMAC-SHA256(app_secret, body))
//   { "messages": [{ "id": "m1", "from": "79161234567", "name": "Ахмед", "text": "…", "ts": 1759650000 }],
//     "statuses": [{ "id": "mock.…", "status": "delivered" }] }

import {
  type ConnectionSecrets, digits, hmacSha256Hex, ProviderError, safeEqual, toE164,
  type WebhookBatch, type WhatsAppAdapter, type WhatsAppConnection,
} from "./types.ts";

export const mockEnabled = () => Deno.env.get("WHATSAPP_ALLOW_MOCK") === "true";

function guard() {
  if (!mockEnabled()) throw new ProviderError("Тестовый провайдер выключен на этом сервере", false, "mock_disabled");
}

export const mockAdapter: WhatsAppAdapter = {
  id: "mock",

  async connect(input) {
    guard();
    const phone = toE164(input.phoneNumberId) || "+70000000000";
    return { externalId: "mock-" + digits(phone), accountId: null, phoneE164: phone, displayName: input.displayName || "Тестовый номер" };
  },

  async disconnect() { /* нечего отключать */ },

  async sendMessage(_conn: WhatsAppConnection, _s: ConnectionSecrets, to: string, text: string) {
    guard();
    // Детерминированный сбой для теста «API недоступен»: текст с маркером [fail].
    if (text.includes("[fail]")) throw new ProviderError("Тестовый провайдер: имитация недоступности API", true, "mock_down");
    console.log(`[wa:mock] → ${toE164(to)}: ${text.slice(0, 80)}`);
    return { externalMessageId: "mock." + crypto.randomUUID() };
  },

  async sendTemplate(conn, s, to, template) {
    return this.sendMessage(conn, s, to, `[template:${template}]`);
  },

  async getConnectionStatus(conn) {
    return { api: mockEnabled() ? "ok" : "down", latencyMs: 1, phoneE164: conn.phone_e164, displayName: conn.display_name,
      quality: "TEST", error: mockEnabled() ? null : "Тестовый провайдер выключен" };
  },

  handleChallenge() { return null; },

  async verifyWebhook(req, rawBody, secrets) {
    if (!mockEnabled() || !secrets.appSecret) return false;
    return safeEqual(req.headers.get("x-mock-signature") ?? "", await hmacSha256Hex(secrets.appSecret, rawBody));
  },

  normalizeIncomingMessage(payload, conn): WebhookBatch {
    // deno-lint-ignore no-explicit-any
    const p = payload as any;
    return {
      messages: (p?.messages ?? []).map((m: { id: string; from: string; name?: string; text?: string; ts?: number }) => ({
        company_id: conn.tenant_id, integration_id: conn.id, channel: "whatsapp" as const, conversation_id: null,
        external_message_id: String(m.id), external_contact_id: digits(m.from), phone: toE164(m.from),
        customer_name: m.name ?? null, direction: "incoming" as const, message_type: "text" as const,
        text: m.text ?? "", media_url: null, payload: m,
        timestamp: new Date((m.ts ?? Date.now() / 1000) * 1000).toISOString(),
      })),
      statuses: (p?.statuses ?? []).map((s: { id: string; status: "sent" | "delivered" | "read" | "failed"; error?: string }) => ({
        external_message_id: s.id, status: s.status, error: s.error ?? null, timestamp: new Date().toISOString(),
      })),
    };
  },
};
