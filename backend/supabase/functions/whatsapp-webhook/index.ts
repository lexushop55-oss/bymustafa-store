// Публичный вебхук входящих WhatsApp.  Деплой: supabase functions deploy whatsapp-webhook --no-verify-jwt
// URL подключения: <PUBLIC_WEBHOOK_BASE_URL>/whatsapp-webhook/<webhook_key>
//
//  GET  — рукопожатие провайдера (Meta: hub.verify_token → hub.challenge)
//  POST — 1) найти подключение по webhook_key  → company_id
//         2) проверить подпись сырым телом секретом ЭТОГО подключения
//         3) записать событие в webhook_events (повтор = тот же dedupe_key → 200 без обработки)
//         4) ответить 200 сразу (Meta ретраит при медленном ответе)
//         5) в фоне: нормализовать → processInbound / applyStatus

import { serviceClient } from "../_shared/auth.ts";
import { activateQrConnection, connectionByWebhookKey, getAdapter, loadSecrets } from "../_shared/whatsapp/index.ts";
import { applyStatus, processInbound } from "../_shared/whatsapp/inbound.ts";
import { sha256Hex } from "../_shared/whatsapp/types.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const ok = () => new Response("ok", { status: 200 });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const key = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const db = serviceClient();
  const conn = await connectionByWebhookKey(db, key);
  // Неизвестный ключ: 404 без подробностей — не подсказываем, какие ключи существуют.
  if (!conn) return new Response("not found", { status: 404 });

  let adapter;
  try { adapter = getAdapter(conn.provider); } catch { return new Response("provider disabled", { status: 404 }); }
  const secrets = await loadSecrets(db, conn);

  if (req.method === "GET") {
    const res = adapter.handleChallenge(url, secrets);
    if (res && res.status === 200) {
      await db.from("tenant_integrations").update({ webhook_status: "verified", last_webhook_at: new Date().toISOString() }).eq("id", conn.id);
    }
    return res ?? new Response("bad request", { status: 400 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const raw = await req.text();
  const signatureOk = await adapter.verifyWebhook(req, raw, secrets);
  if (!signatureOk) {
    console.warn("[wa-webhook] bad signature", conn.id);
    await db.from("tenant_integrations").update({ webhook_status: "failing", last_error: "Подпись вебхука не прошла проверку" }).eq("id", conn.id);
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  const dedupe = await sha256Hex(raw);
  const { data: ev, error: evErr } = await db.from("webhook_events").insert({
    integration_id: conn.id, company_id: conn.tenant_id, provider: conn.provider, dedupe_key: dedupe, payload, signature_ok: true,
  }).select("id").single();
  if (evErr) {
    if (evErr.code === "23505") return ok(); // тот же вебхук пришёл повторно
    console.error("[wa-webhook] event insert failed", evErr.message);
    return new Response("retry", { status: 500 }); // пусть провайдер повторит — сообщение не теряется
  }
  await db.from("tenant_integrations").update({ last_webhook_at: new Date().toISOString(), webhook_status: "verified" }).eq("id", conn.id);

  const work = (async () => {
    try {
      const batch = adapter.normalizeIncomingMessage(payload, conn);
      if (batch.connection) {
        if (batch.connection.state === "connected") {
          if (!conn.is_active) await activateQrConnection(db, conn, batch.connection.phone, batch.connection.name);
        } else if (batch.connection.state === "logged_out") {
          await db.from("tenant_integrations").update({ status: "down", webhook_status: "failing",
            last_error: "Номер отвязан в телефоне — подключите заново по QR-коду" }).eq("id", conn.id);
        }
      }
      // Пока номер не активирован, сообщения не принимаем — подключение ещё не принадлежит компании окончательно.
      if (conn.is_active || batch.connection?.state === "connected") {
        for (const m of batch.messages) await processInbound(db, { ...conn, is_active: true }, m);
      }
      for (const s of batch.statuses) await applyStatus(db, conn, s);
      await db.from("webhook_events").update({ status: batch.messages.length || batch.statuses.length ? "processed" : "ignored", processed_at: new Date().toISOString(), attempts: 1 }).eq("id", ev.id);
    } catch (e) {
      console.error("[wa-webhook] processing failed", ev.id, e);
      await db.from("webhook_events").update({ status: "failed", error: e instanceof Error ? e.message : String(e), attempts: 1 }).eq("id", ev.id);
    }
  })();
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return ok();
});
