// Универсальный слой WhatsApp. CRM знает только эти типы; конкретный
// провайдер (Meta Cloud API, тестовый mock, позже — любой другой) реализует
// WhatsAppAdapter и регистрируется в ./index.ts.

/** Строка tenant_integrations с type = 'whatsapp' — «подключение». */
export interface WhatsAppConnection {
  id: string;
  tenant_id: string;            // = company_id
  provider: ProviderId;
  external_id: string | null;   // phone_number_id у Meta
  account_id: string | null;    // WABA id
  phone_e164: string | null;
  display_name: string | null;
  secret_ref: string | null;    // токен доступа (Vault)
  app_secret_ref: string | null;   // подпись вебхука (Vault)
  verify_token_ref: string | null; // GET-проверка вебхука (Vault)
  webhook_key: string | null;
  is_active: boolean;
}

export type ProviderId = "meta_cloud" | "mock" | "baileys";

/** Расшифрованные секреты подключения. Живут только в памяти функции. */
export interface ConnectionSecrets {
  accessToken: string | null;
  appSecret: string | null;
  verifyToken: string | null;
}

/** Внутренний формат входящего сообщения — одинаковый для всех провайдеров. */
export interface NormalizedMessage {
  company_id: string;
  integration_id: string;
  channel: "whatsapp";
  conversation_id: string | null;    // заполняется пайплайном
  external_message_id: string;
  external_contact_id: string;       // wa_id — цифры номера
  phone: string;                     // +E.164
  customer_name: string | null;
  direction: "incoming";
  message_type: "text" | "image" | "audio" | "video" | "document" | "location" | "interactive" | "unsupported";
  text: string | null;
  media_url: string | null;          // у Meta — media id; URL берётся отдельным запросом
  payload: Record<string, unknown>;
  timestamp: string;                 // ISO
}

/** Статус доставки исходящего сообщения от провайдера. */
export interface NormalizedStatus {
  external_message_id: string;
  status: "sent" | "delivered" | "read" | "failed";
  error: string | null;
  timestamp: string;
}

export interface WebhookBatch {
  messages: NormalizedMessage[];
  statuses: NormalizedStatus[];
  /** Событие состояния сессии (провайдер по QR): номер привязан / отвязан в телефоне. */
  connection?: { state: string; phone: string | null; name: string | null };
}

export interface ConnectInput {
  phoneNumberId?: string;
  accountId?: string;
  accessToken?: string;
  appSecret?: string;
  displayName?: string;
}

export interface ConnectResult {
  externalId: string;
  accountId: string | null;
  phoneE164: string | null;
  displayName: string | null;
}

export interface ConnectionStatus {
  api: "ok" | "down";
  latencyMs: number;
  phoneE164: string | null;
  displayName: string | null;
  quality: string | null;
  error: string | null;
}

export interface SendResult {
  externalMessageId: string;
}

/** Ошибка провайдера: retryable решает, ставить ли сообщение в очередь повтора. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code = "provider_error") {
    super(message);
    this.name = "ProviderError";
  }
}

export interface WhatsAppAdapter {
  readonly id: ProviderId;
  /** Проверить реквизиты у провайдера и подписать номер на вебхук. */
  connect(input: ConnectInput, secrets: ConnectionSecrets): Promise<ConnectResult>;
  disconnect(conn: WhatsAppConnection, secrets: ConnectionSecrets): Promise<void>;
  sendMessage(conn: WhatsAppConnection, secrets: ConnectionSecrets, to: string, text: string): Promise<SendResult>;
  sendTemplate(conn: WhatsAppConnection, secrets: ConnectionSecrets, to: string, template: string, lang: string, params: string[]): Promise<SendResult>;
  getConnectionStatus(conn: WhatsAppConnection, secrets: ConnectionSecrets): Promise<ConnectionStatus>;
  /** GET-рукопожатие провайдера при настройке вебхука. null — не наш запрос. */
  handleChallenge(url: URL, secrets: ConnectionSecrets): Response | null;
  /** Проверка подлинности POST-вебхука по сырому телу. */
  verifyWebhook(req: Request, rawBody: string, secrets: ConnectionSecrets): Promise<boolean>;
  /** Сырой payload → нормализованные сообщения и статусы ЭТОГО подключения. */
  normalizeIncomingMessage(payload: unknown, conn: WhatsAppConnection): WebhookBatch;
}

export const digits = (s: string | null | undefined) => String(s ?? "").replace(/\D/g, "");
export const toE164 = (s: string | null | undefined) => {
  const d = digits(s);
  return d ? "+" + d : "";
};

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сравнение за постоянное время — подпись не подбирается по таймингу. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
