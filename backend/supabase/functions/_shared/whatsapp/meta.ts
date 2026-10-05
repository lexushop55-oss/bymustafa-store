// Провайдер: WhatsApp Business Cloud API (Meta Graph API).
// Подпись вебхука: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app_secret, сырое тело).
// GET-проверка: hub.mode=subscribe & hub.verify_token → вернуть hub.challenge.

import { fetchWithTimeout } from "../http.ts";
import {
  type ConnectInput, type ConnectionSecrets, type ConnectionStatus, type ConnectResult,
  digits, hmacSha256Hex, type NormalizedMessage, type NormalizedStatus, ProviderError,
  safeEqual, type SendResult, toE164, type WebhookBatch, type WhatsAppAdapter, type WhatsAppConnection,
} from "./types.ts";

const GRAPH = () => `https://graph.facebook.com/${Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v20.0"}`;

// Коды Graph API, при которых повтор бессмыслен (нужен шаблон, номер не в WhatsApp и т.п.).
const NON_RETRYABLE = new Set([131026, 131047, 131051, 132000, 132001, 100, 190]);

async function graph(path: string, token: string, init: RequestInit = {}, timeout = 6000) {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${GRAPH()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    }, timeout);
  } catch (e) {
    throw new ProviderError(e instanceof Error ? e.message : String(e), true, "network");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = Number(body?.error?.code ?? 0);
    const msg = body?.error?.error_data?.details ?? body?.error?.message ?? `HTTP ${res.status}`;
    const retryable = res.status >= 500 || res.status === 429 || (!NON_RETRYABLE.has(code) && res.status !== 400 && res.status !== 401 && res.status !== 403);
    throw new ProviderError(`WhatsApp API: ${msg}`, retryable, code ? `graph_${code}` : `http_${res.status}`);
  }
  return body;
}

function need(token: string | null): string {
  if (!token) throw new ProviderError("Токен доступа не найден в хранилище секретов", false, "no_secret");
  return token;
}

function mapType(t: string): NormalizedMessage["message_type"] {
  return (["text", "image", "audio", "video", "document", "location", "interactive"].includes(t)
    ? t : (t === "button" ? "interactive" : "unsupported")) as NormalizedMessage["message_type"];
}

export const metaCloudAdapter: WhatsAppAdapter = {
  id: "meta_cloud",

  async connect(input: ConnectInput, secrets: ConnectionSecrets): Promise<ConnectResult> {
    const token = need(secrets.accessToken);
    if (!input.phoneNumberId) throw new ProviderError("Укажите Phone number ID из кабинета Meta", false, "bad_request");
    const info = await graph(`/${input.phoneNumberId}?fields=display_phone_number,verified_name`, token);
    // Подписка номера на приложение — без неё вебхук не приходит.
    if (input.accountId) await graph(`/${input.accountId}/subscribed_apps`, token, { method: "POST" }, 8000);
    return {
      externalId: input.phoneNumberId,
      accountId: input.accountId ?? null,
      phoneE164: toE164(info?.display_phone_number) || null,
      displayName: input.displayName || info?.verified_name || null,
    };
  },

  async disconnect(conn: WhatsAppConnection, secrets: ConnectionSecrets) {
    if (!conn.account_id || !secrets.accessToken) return;
    await graph(`/${conn.account_id}/subscribed_apps`, secrets.accessToken, { method: "DELETE" }).catch((e) =>
      console.warn("[wa] unsubscribe failed", (e as Error).message));
  },

  async sendMessage(conn, secrets, to, text): Promise<SendResult> {
    const body = await graph(`/${conn.external_id}/messages`, need(secrets.accessToken), {
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), type: "text", text: { body: text, preview_url: false } }),
    });
    const id = body?.messages?.[0]?.id;
    if (!id) throw new ProviderError("WhatsApp API не вернул id сообщения", true, "no_id");
    return { externalMessageId: id };
  },

  async sendTemplate(conn, secrets, to, template, lang, params): Promise<SendResult> {
    const body = await graph(`/${conn.external_id}/messages`, need(secrets.accessToken), {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp", to: digits(to), type: "template",
        template: { name: template, language: { code: lang },
          components: params.length ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] : [] },
      }),
    });
    return { externalMessageId: body?.messages?.[0]?.id };
  },

  async getConnectionStatus(conn, secrets): Promise<ConnectionStatus> {
    const started = performance.now();
    try {
      const info = await graph(`/${conn.external_id}?fields=display_phone_number,verified_name,quality_rating`, need(secrets.accessToken), {}, 5000);
      return { api: "ok", latencyMs: Math.round(performance.now() - started), phoneE164: toE164(info?.display_phone_number) || null,
        displayName: info?.verified_name ?? null, quality: info?.quality_rating ?? null, error: null };
    } catch (e) {
      return { api: "down", latencyMs: Math.round(performance.now() - started), phoneE164: null, displayName: null, quality: null,
        error: (e as Error).message };
    }
  },

  handleChallenge(url: URL, secrets: ConnectionSecrets): Response | null {
    if (url.searchParams.get("hub.mode") !== "subscribe") return null;
    const token = url.searchParams.get("hub.verify_token") ?? "";
    if (!secrets.verifyToken || !safeEqual(token, secrets.verifyToken)) return new Response("forbidden", { status: 403 });
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  },

  async verifyWebhook(req: Request, rawBody: string, secrets: ConnectionSecrets): Promise<boolean> {
    const header = req.headers.get("x-hub-signature-256") ?? "";
    if (!secrets.appSecret || !header.startsWith("sha256=")) return false;
    return safeEqual(header.slice(7), await hmacSha256Hex(secrets.appSecret, rawBody));
  },

  normalizeIncomingMessage(payload: unknown, conn: WhatsAppConnection): WebhookBatch {
    const out: WebhookBatch = { messages: [], statuses: [] };
    // deno-lint-ignore no-explicit-any
    const p = payload as any;
    if (p?.object !== "whatsapp_business_account") return out;
    for (const entry of p.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        // Второй замок маршрутизации: сообщение должно быть адресовано номеру ЭТОГО подключения.
        if (String(v.metadata?.phone_number_id ?? "") !== String(conn.external_id ?? "")) continue;
        const names: Record<string, string> = {};
        for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name ?? "";
        for (const m of v.messages ?? []) {
          const type = mapType(m.type);
          const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title
            ?? m.image?.caption ?? m.document?.caption ?? m.video?.caption
            ?? (m.location ? `${m.location.latitude},${m.location.longitude}` : null);
          const media = m.image?.id ?? m.audio?.id ?? m.video?.id ?? m.document?.id ?? null;
          out.messages.push({
            company_id: conn.tenant_id, integration_id: conn.id, channel: "whatsapp", conversation_id: null,
            external_message_id: m.id, external_contact_id: digits(m.from), phone: toE164(m.from),
            customer_name: names[m.from] || null, direction: "incoming", message_type: type,
            text, media_url: media, payload: m, timestamp: new Date(Number(m.timestamp) * 1000).toISOString(),
          });
        }
        for (const s of v.statuses ?? []) {
          if (!["sent", "delivered", "read", "failed"].includes(s.status)) continue;
          out.statuses.push({
            external_message_id: s.id, status: s.status as NormalizedStatus["status"],
            error: s.errors?.[0]?.error_data?.details ?? s.errors?.[0]?.title ?? null,
            timestamp: new Date(Number(s.timestamp) * 1000).toISOString(),
          });
        }
      }
    }
    return out;
  },
};
