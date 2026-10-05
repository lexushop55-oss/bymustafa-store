// Реестр провайдеров + загрузка подключения и его секретов.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { readSecret } from "../auth.ts";
import { baileysAdapter } from "./baileys.ts";
import { metaCloudAdapter } from "./meta.ts";
import { mockAdapter, mockEnabled } from "./mock.ts";
import type { ConnectionSecrets, ProviderId, WhatsAppAdapter, WhatsAppConnection } from "./types.ts";

const ADAPTERS: Record<ProviderId, WhatsAppAdapter> = { meta_cloud: metaCloudAdapter, mock: mockAdapter, baileys: baileysAdapter };

export function getAdapter(provider: string): WhatsAppAdapter {
  const a = ADAPTERS[provider as ProviderId];
  if (!a) throw new Error(`Неизвестный провайдер WhatsApp: ${provider}`);
  if (a.id === "mock" && !mockEnabled()) throw new Error("Тестовый провайдер выключен на этом сервере");
  return a;
}

export const CONNECTION_COLUMNS =
  "id, tenant_id, provider, external_id, account_id, phone_e164, display_name, secret_ref, app_secret_ref, verify_token_ref, webhook_key, is_active";

/** Компания определяется ТОЛЬКО так: webhook_key из URL → строка подключения → tenant_id. */
export async function connectionByWebhookKey(db: SupabaseClient, key: string): Promise<WhatsAppConnection | null> {
  if (!/^[a-f0-9]{32,64}$/.test(key)) return null;
  const { data } = await db.from("tenant_integrations").select(CONNECTION_COLUMNS)
    .eq("type", "whatsapp").eq("webhook_key", key).maybeSingle();
  return (data as WhatsAppConnection | null) ?? null;
}

export async function connectionOfCompany(db: SupabaseClient, companyId: string): Promise<WhatsAppConnection | null> {
  const { data } = await db.from("tenant_integrations").select(CONNECTION_COLUMNS)
    .eq("type", "whatsapp").eq("tenant_id", companyId).maybeSingle();
  return (data as WhatsAppConnection | null) ?? null;
}

export async function loadSecrets(db: SupabaseClient, conn: WhatsAppConnection): Promise<ConnectionSecrets> {
  const [accessToken, appSecret, verifyToken] = await Promise.all([
    readSecret(db, conn.secret_ref), readSecret(db, conn.app_secret_ref), readSecret(db, conn.verify_token_ref),
  ]);
  return { accessToken, appSecret, verifyToken };
}

export const secretName = (companyId: string, kind: "token" | "app_secret" | "verify") => `wa_${kind}_${companyId}`;

/** Номер привязан по QR: активировать подключение, если этот номер не занят другой компанией. */
export async function activateQrConnection(db: SupabaseClient, conn: WhatsAppConnection, phone: string | null, name: string | null) {
  if (phone) {
    const { data: clash } = await db.from("tenant_integrations").select("id").eq("type", "whatsapp").eq("is_active", true)
      .eq("phone_e164", phone).neq("tenant_id", conn.tenant_id).maybeSingle();
    if (clash) {
      await db.from("tenant_integrations").update({ status: "down", last_error: "Этот номер уже подключён к другой компании" }).eq("id", conn.id);
      return { ok: false as const, error: "Этот номер уже подключён к другой компании" };
    }
  }
  const now = new Date().toISOString();
  await db.from("tenant_integrations").update({ is_active: true, status: "ok", webhook_status: "verified", phone_e164: phone,
    display_name: conn.display_name || name, connected_at: now, last_check_at: now, last_error: null, updated_at: now }).eq("id", conn.id);
  await db.from("activity_logs").insert({ company_id: conn.tenant_id, actor_id: null, action: "whatsapp_connected", payload: { provider: "baileys", phone } });
  return { ok: true as const };
}
