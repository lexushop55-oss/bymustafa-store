// Исходящие сообщения: сначала сохранить (pending), потом отправить.
// Если API недоступен — сообщение остаётся в CRM со статусом failed и
// уходит в очередь wa_out; воркер повторит отправку с бэкоффом.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getAdapter, loadSecrets } from "./index.ts";
import { ProviderError, type WhatsAppConnection } from "./types.ts";

export interface OutgoingInput {
  companyId: string;
  conversationId: string;
  patientId: string | null;
  to: string;                       // +E.164 / wa_id
  text: string;
  senderType: "ai" | "employee" | "system";
  senderId?: string | null;
  clientRef?: string | null;        // идемпотентность кнопки «Отправить» в CRM
}

export interface OutgoingResult {
  messageId: string;
  status: "sent" | "failed" | "pending";
  error: string | null;
  duplicate?: boolean;
}

const BACKOFF_SEC = [15, 60, 300, 900, 3600];

export async function sendOutgoing(db: SupabaseClient, conn: WhatsAppConnection | null, input: OutgoingInput): Promise<OutgoingResult> {
  const { data: row, error } = await db.from("messages").insert({
    company_id: input.companyId, conversation_id: input.conversationId, patient_id: input.patientId,
    integration_id: conn?.id ?? null, direction: "outgoing", sender_type: input.senderType, sender_id: input.senderId ?? null,
    message_type: "text", text: input.text, ai_generated: input.senderType === "ai", status: "pending", client_ref: input.clientRef ?? null,
  }).select("id").single();

  if (error) {
    if (error.code === "23505" && input.clientRef) {
      const { data: dup } = await db.from("messages").select("id, status, error")
        .eq("company_id", input.companyId).eq("client_ref", input.clientRef).single();
      return { messageId: dup!.id, status: dup!.status, error: dup!.error, duplicate: true };
    }
    throw new Error(`Сообщение не сохранено: ${error.message}`);
  }
  return await deliver(db, conn, row.id, input.to, input.text, input.companyId);
}

/** Одна попытка доставки уже сохранённого сообщения (используется и воркером). */
export async function deliver(
  db: SupabaseClient, conn: WhatsAppConnection | null, messageId: string, to: string, text: string, companyId: string,
): Promise<OutgoingResult> {
  if (!conn || !conn.is_active) {
    await db.from("messages").update({ status: "failed", error: "WhatsApp не подключён" }).eq("id", messageId);
    return { messageId, status: "failed", error: "WhatsApp не подключён" };
  }
  try {
    const adapter = getAdapter(conn.provider);
    const res = await adapter.sendMessage(conn, await loadSecrets(db, conn), to, text);
    const now = new Date().toISOString();
    await db.from("messages").update({ status: "sent", external_message_id: res.externalMessageId, sent_at: now, error: null })
      .eq("id", messageId);
    await db.from("tenant_integrations").update({ last_outbound_at: now }).eq("id", conn.id);
    return { messageId, status: "sent", error: null };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    const retryable = e instanceof ProviderError ? e.retryable : true;
    const { data: m } = await db.from("messages").update({ status: "failed", error: err })
      .eq("id", messageId).select("attempts").single();
    if (retryable) {
      const attempt = (m?.attempts ?? 0);
      await db.from("integration_jobs").insert({
        tenant_id: companyId, queue: "wa_out", payload: { message_id: messageId },
        scheduled_at: new Date(Date.now() + BACKOFF_SEC[Math.min(attempt, BACKOFF_SEC.length - 1)] * 1000).toISOString(),
      });
    }
    return { messageId, status: "failed", error: err };
  }
}
