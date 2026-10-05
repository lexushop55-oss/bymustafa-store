// Входящее сообщение WhatsApp → CRM → робот → ответ.
// Порядок фиксирован: СНАЧАЛА сохранить, ПОТОМ обрабатывать. Повтор того же
// external_message_id останавливается на шаге 3 (уникальный индекс) и робот
// второй раз не запускается — значит, и вторая запись не создаётся.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadAiSettings, runAgent } from "../agent/runner.ts";
import { runTool, type ToolContext } from "../crm/tools.ts";
import { logActivity } from "../tenant.ts";
import { sendOutgoing } from "./outbound.ts";
import type { NormalizedMessage, NormalizedStatus, WhatsAppConnection } from "./types.ts";

export interface InboundResult {
  duplicate: boolean;
  conversationId: string | null;
  patientId: string | null;
  patientCreated: boolean;
  messageId: string | null;
  ai: "replied" | "handed_off" | "disabled" | "operator" | "error" | "skipped";
  replyStatus?: string;
}

const FALLBACK_REPLY = "Спасибо! Передала ваше сообщение администратору — он ответит в ближайшее время.";

export async function processInbound(db: SupabaseClient, conn: WhatsAppConnection, msg: NormalizedMessage): Promise<InboundResult> {
  const companyId = conn.tenant_id; // компания — из подключения, не из номера пациента

  // 1. Быстрая проверка дубля до любых побочных эффектов.
  const { data: seen } = await db.from("messages").select("id, conversation_id")
    .eq("integration_id", conn.id).eq("external_message_id", msg.external_message_id).maybeSingle();
  if (seen) return { duplicate: true, conversationId: seen.conversation_id, patientId: null, patientCreated: false, messageId: seen.id, ai: "skipped" };

  // 2. Пациент компании по номеру (найти или создать атомарно).
  const { data: pRows, error: pErr } = await db.rpc("crm_find_or_create_patient",
    { p_company: companyId, p_phone: msg.phone, p_name: msg.customer_name ?? "", p_source: "whatsapp" });
  if (pErr) throw new Error(`patient: ${pErr.message}`);
  const patientId: string = pRows[0].patient_id, patientCreated: boolean = pRows[0].created;

  // 3. Диалог: один на (компания, канал, номер).
  const { data: conv, error: cErr } = await db.from("conversations").upsert({
    company_id: companyId, channel: "whatsapp", external_contact_id: msg.external_contact_id,
    integration_id: conn.id, patient_id: patientId, contact_name: msg.customer_name ?? undefined,
  }, { onConflict: "company_id,channel,external_contact_id", ignoreDuplicates: false })
    .select("id, ai_enabled, status").single();
  if (cErr) throw new Error(`conversation: ${cErr.message}`);

  // 4. Сохранить входящее. Уникальный индекс (integration_id, external_message_id) — последний рубеж от гонки дублей.
  const { data: saved, error: mErr } = await db.from("messages").insert({
    company_id: companyId, conversation_id: conv.id, patient_id: patientId, integration_id: conn.id,
    external_message_id: msg.external_message_id, direction: "incoming", sender_type: "customer",
    message_type: msg.message_type, text: msg.text, media_url: msg.media_url, payload: msg.payload,
    status: "received", created_at: msg.timestamp,
  }).select("id").single();
  if (mErr) {
    if (mErr.code === "23505") return { duplicate: true, conversationId: conv.id, patientId, patientCreated, messageId: null, ai: "skipped" };
    throw new Error(`message: ${mErr.message}`);
  }
  await db.from("tenant_integrations").update({ last_inbound_at: new Date().toISOString(), webhook_status: "verified" }).eq("id", conn.id);
  if (patientCreated) await logActivity(db, companyId, null, "patient_created_from_whatsapp", { patient_id: patientId, phone: msg.phone });

  const base: InboundResult = { duplicate: false, conversationId: conv.id, patientId, patientCreated, messageId: saved.id, ai: "skipped" };

  // 5. Робот: выключен в компании или в этом диалоге → сообщение ждёт оператора.
  const settings = await loadAiSettings(db, companyId);
  if (!settings.ai_enabled) return { ...base, ai: "disabled" };
  if (!conv.ai_enabled || conv.status === "needs_operator") return { ...base, ai: "operator" };

  const { data: tenant } = await db.from("tenants").select("name, timezone").eq("id", companyId).single();
  const ctx: ToolContext = { db, companyId, conversationId: conv.id, patientId, triggerMessageId: saved.id,
    timezone: tenant?.timezone ?? "Europe/Moscow", settings };

  // 5a. Правило компании: ключевые слова → сразу оператору, без модели.
  const text = (msg.text ?? "").toLowerCase();
  const kw = (settings.human_handoff_rules.keywords ?? []).find((k) => k && text.includes(k.toLowerCase()));
  if (kw) {
    await runTool(ctx, "transfer_to_human", { reason: `Пациент написал «${kw}»` });
    const r = await sendOutgoing(db, conn, { companyId, conversationId: conv.id, patientId, to: msg.phone, text: FALLBACK_REPLY, senderType: "system" });
    return { ...base, ai: "handed_off", replyStatus: r.status };
  }

  // 6. Агент + инструменты CRM. Любая ошибка → передать оператору, диалог не ломается.
  try {
    const run = await runAgent(ctx, tenant?.name ?? "");
    if (run.error || !run.reply) throw new Error(run.error ?? "Пустой ответ робота");
    const r = await sendOutgoing(db, conn, { companyId, conversationId: conv.id, patientId, to: msg.phone, text: run.reply, senderType: "ai" });
    await db.from("ai_actions").insert({ company_id: companyId, conversation_id: conv.id, trigger_message_id: saved.id,
      tool: "send_whatsapp_message", args: { length: run.reply.length }, result: { status: r.status, error: r.error, summary: r.status === "sent" ? "Отправлено сообщение WhatsApp" : `Сообщение не отправлено: ${r.error}` },
      status: r.status === "sent" ? "ok" : "error", entity_type: "message", entity_id: r.messageId });
    return { ...base, ai: run.handedOff ? "handed_off" : "replied", replyStatus: r.status };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    console.error("[wa] agent failed", conv.id, err);
    await db.from("ai_actions").insert({ company_id: companyId, conversation_id: conv.id, trigger_message_id: saved.id,
      tool: "agent_run", args: {}, result: { error: err, summary: "Робот не смог обработать сообщение" }, status: "error" });
    if (settings.human_handoff_rules.on_ai_error !== false) {
      await runTool(ctx, "transfer_to_human", { reason: "Ошибка робота: " + err.slice(0, 120) });
      await sendOutgoing(db, conn, { companyId, conversationId: conv.id, patientId, to: msg.phone, text: FALLBACK_REPLY, senderType: "system" });
    }
    return { ...base, ai: "error" };
  }
}

/** Статусы доставки от провайдера → messages.status. Понижать статус нельзя (read не станет sent). */
const RANK: Record<string, number> = { pending: 0, failed: 1, sent: 2, delivered: 3, read: 4 };
export async function applyStatus(db: SupabaseClient, conn: WhatsAppConnection, st: NormalizedStatus) {
  const { data: m } = await db.from("messages").select("id, status").eq("integration_id", conn.id)
    .eq("external_message_id", st.external_message_id).maybeSingle();
  if (!m || (RANK[st.status] ?? 0) <= (RANK[m.status] ?? 0) && st.status !== "failed") return;
  await db.from("messages").update({ status: st.status, error: st.error }).eq("id", m.id);
}
