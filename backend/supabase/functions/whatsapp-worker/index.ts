// Воркер повторной отправки (очередь wa_out) и повторной обработки упавших вебхуков.
// Деплой: supabase functions deploy whatsapp-worker --no-verify-jwt
// Вызов раз в минуту из pg_cron / внешнего планировщика:
//   POST /functions/v1/whatsapp-worker   header x-worker-secret: <WHATSAPP_WORKER_SECRET>

import { serviceClient } from "../_shared/auth.ts";
import { safeEqual } from "../_shared/whatsapp/types.ts";
import { CONNECTION_COLUMNS, connectionByWebhookKey, getAdapter } from "../_shared/whatsapp/index.ts";
import { deliver } from "../_shared/whatsapp/outbound.ts";
import { applyStatus, processInbound } from "../_shared/whatsapp/inbound.ts";
import type { WhatsAppConnection } from "../_shared/whatsapp/types.ts";

Deno.serve(async (req) => {
  const secret = Deno.env.get("WHATSAPP_WORKER_SECRET") ?? "";
  if (!secret || !safeEqual(req.headers.get("x-worker-secret") ?? "", secret)) return new Response("forbidden", { status: 403 });
  const db = serviceClient();
  const report = { sent: 0, failed: 0, dead: 0, webhooksRetried: 0 };

  // 1. Неотправленные сообщения.
  const { data: jobs } = await db.rpc("wa_claim_jobs", { p_limit: 25 });
  for (const job of jobs ?? []) {
    const { data: m } = await db.from("messages").select("id, company_id, text, status, conversations!inner(external_contact_id)")
      .eq("id", job.payload?.message_id).maybeSingle();
    if (!m || m.status !== "failed") { await db.from("integration_jobs").update({ status: "done" }).eq("id", job.id); continue; }
    const { data: conn } = await db.from("tenant_integrations").select(CONNECTION_COLUMNS).eq("tenant_id", m.company_id).eq("type", "whatsapp").maybeSingle();
    await db.from("messages").update({ status: "pending", attempts: job.attempts }).eq("id", m.id);
    const r = await deliver(db, conn as WhatsAppConnection | null, m.id,
      (m.conversations as unknown as { external_contact_id: string }).external_contact_id, m.text ?? "", m.company_id);
    if (r.status === "sent") { report.sent++; await db.from("integration_jobs").update({ status: "done" }).eq("id", job.id); continue; }
    const dead = job.attempts >= job.max_attempts;
    // deliver() уже поставил новое задание с бэкоффом; текущее закрываем.
    await db.from("integration_jobs").update({ status: dead ? "dead" : "failed", last_error: r.error }).eq("id", job.id);
    dead ? report.dead++ : report.failed++;
  }

  // 2. Вебхуки, упавшие при обработке (например, БД была недоступна), — до 3 попыток.
  const { data: evs } = await db.from("webhook_events").select("id, integration_id, payload, attempts, tenant_integrations!inner(webhook_key)")
    .eq("status", "failed").lt("attempts", 3).order("created_at").limit(20);
  for (const ev of evs ?? []) {
    const conn = await connectionByWebhookKey(db, (ev.tenant_integrations as unknown as { webhook_key: string }).webhook_key);
    if (!conn) continue;
    try {
      const batch = getAdapter(conn.provider).normalizeIncomingMessage(ev.payload, conn);
      for (const m of batch.messages) await processInbound(db, conn, m); // дубли отсекаются внутри
      for (const s of batch.statuses) await applyStatus(db, conn, s);
      await db.from("webhook_events").update({ status: "processed", processed_at: new Date().toISOString(), attempts: ev.attempts + 1 }).eq("id", ev.id);
    } catch (e) {
      await db.from("webhook_events").update({ attempts: ev.attempts + 1, error: (e as Error).message }).eq("id", ev.id);
    }
    report.webhooksRetried++;
  }
  return new Response(JSON.stringify(report), { headers: { "content-type": "application/json" } });
});
