// API канала WhatsApp для кабинета компании.  Деплой: supabase functions deploy whatsapp
// Доступ: только сотрудник компании (requireCompanyMember). company_id берётся из
// членства, НЕ из тела запроса; все выборки — .eq(company_id).
//
//   GET  /connection                  статус подключения (без секретов)
//   POST /connect                     подключить номер (Owner/Admin). Секреты → Vault
//   POST /check                       проверить API провайдера
//   POST /test        {to,text}       тестовая отправка
//   POST /disconnect                  отключить, удалить секреты
//   POST /conversations/:id/reply     {text, clientRef}  ответ сотрудника
//   POST /conversations/:id/handoff   {reason}  передать оператору (ai_enabled=false)
//   POST /conversations/:id/resume    вернуть робота (ai_enabled=true)
//   POST /conversations/:id/read      сбросить непрочитанные
//   POST /messages/:id/retry          повторить неотправленное
//   GET|PUT /ai-settings              настройки робота компании
//   POST /dev/inbound                 только mock-провайдер: имитировать входящее

import { corsHeaders, errorResponse, HttpError, json } from "../_shared/http.ts";
import { type CompanyContext, logActivity, requireCompanyMember } from "../_shared/tenant.ts";
import { CONNECTION_COLUMNS, connectionOfCompany, getAdapter, loadSecrets, secretName } from "../_shared/whatsapp/index.ts";
import { mockEnabled } from "../_shared/whatsapp/mock.ts";
import { deliver, sendOutgoing } from "../_shared/whatsapp/outbound.ts";
import { processInbound } from "../_shared/whatsapp/inbound.ts";
import { loadAiSettings } from "../_shared/agent/runner.ts";
import { digits, toE164, type WhatsAppConnection } from "../_shared/whatsapp/types.ts";

const WEBHOOK_BASE = () => (Deno.env.get("PUBLIC_WEBHOOK_BASE_URL") ?? "").replace(/\/$/, "");
const MANAGE = ["Owner", "Admin"] as const;
const REPLY = ["Owner", "Admin", "Manager"] as const;
const randomHex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

function routeOf(url: URL) {
  return url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/api/, "").replace(/^\/whatsapp/, "").replace(/\/+$/, "") || "/";
}

function publicView(c: WhatsAppConnection | null, extra: Record<string, unknown> = {}) {
  if (!c) return { connected: false };
  const r = c as unknown as Record<string, unknown>;
  return {
    connected: !!c.is_active, provider: c.provider, phone: c.phone_e164, displayName: c.display_name,
    status: r.status, webhookStatus: r.webhook_status, connectedAt: r.connected_at, lastInboundAt: r.last_inbound_at,
    lastOutboundAt: r.last_outbound_at, lastError: r.last_error, lastCheckAt: r.last_check_at,
    webhookUrl: c.webhook_key && WEBHOOK_BASE() ? `${WEBHOOK_BASE()}/whatsapp-webhook/${c.webhook_key}` : null,
    ...extra,
  };
}

async function fullRow(ctx: CompanyContext) {
  const { data } = await ctx.db.from("tenant_integrations")
    .select(CONNECTION_COLUMNS + ", status, webhook_status, connected_at, last_inbound_at, last_outbound_at, last_error, last_check_at")
    .eq("tenant_id", ctx.companyId).eq("type", "whatsapp").maybeSingle();
  return data as WhatsAppConnection | null;
}

async function ownConversation(ctx: CompanyContext, id: string) {
  const { data } = await ctx.db.from("conversations").select("id, patient_id, external_contact_id, ai_enabled, status")
    .eq("company_id", ctx.companyId).eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "Диалог не найден", "not_found");
  return data;
}

async function systemEvent(ctx: CompanyContext, conversationId: string, patientId: string | null, text: string) {
  await ctx.db.from("messages").insert({ company_id: ctx.companyId, conversation_id: conversationId, patient_id: patientId,
    direction: "outgoing", sender_type: "system", sender_id: ctx.userId, message_type: "event", text, status: "sent" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  const url = new URL(req.url), route = routeOf(url);
  try {
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({})) as Record<string, string>;

    if (route === "/connection" && req.method === "GET") {
      const ctx = await requireCompanyMember(req);
      return json(req, { success: true, connection: publicView(await fullRow(ctx)), mockAvailable: mockEnabled() });
    }

    if (route === "/connect" && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...MANAGE]);
      const provider = body.provider === "mock" ? "mock" : "meta_cloud";
      if (provider === "mock" && !mockEnabled()) throw new HttpError(400, "Тестовый провайдер доступен только на сервере разработки", "mock_disabled");
      if (!WEBHOOK_BASE()) throw new HttpError(500, "На сервере не задан PUBLIC_WEBHOOK_BASE_URL", "misconfigured");
      const verifyToken = randomHex(16);
      const appSecret = provider === "mock" ? randomHex(24) : String(body.appSecret ?? "").trim();
      const accessToken = provider === "mock" ? "mock" : String(body.accessToken ?? "").trim();
      if (provider === "meta_cloud" && (!accessToken || !appSecret || !body.phoneNumberId)) {
        throw new HttpError(400, "Нужны Phone number ID, постоянный токен доступа и App secret", "bad_request");
      }
      const adapter = getAdapter(provider);
      const res = await adapter.connect({ phoneNumberId: body.phoneNumberId, accountId: body.accountId, accessToken, appSecret, displayName: body.displayName },
        { accessToken, appSecret, verifyToken });

      // Номер уже подключён к другой компании — отказ (иначе вебхуки смешались бы).
      const { data: clash } = await ctx.db.from("tenant_integrations").select("tenant_id").eq("provider", provider)
        .eq("external_id", res.externalId).eq("is_active", true).neq("tenant_id", ctx.companyId).maybeSingle();
      if (clash) throw new HttpError(409, "Этот номер уже подключён к другой компании", "number_in_use");

      // Секреты — только в Vault. В таблицу пишем имена.
      const names = { token: secretName(ctx.companyId, "token"), app: secretName(ctx.companyId, "app_secret"), verify: secretName(ctx.companyId, "verify") };
      for (const [n, v] of [[names.token, accessToken], [names.app, appSecret], [names.verify, verifyToken]]) {
        const { error } = await ctx.db.rpc("wa_put_secret", { p_name: n, p_secret: v });
        if (error) throw new HttpError(500, "Не удалось сохранить секрет: " + error.message, "vault_error");
      }
      const now = new Date().toISOString();
      const existing = await connectionOfCompany(ctx.db, ctx.companyId);
      const row = {
        tenant_id: ctx.companyId, type: "whatsapp", provider, external_id: res.externalId, account_id: res.accountId,
        phone_e164: res.phoneE164, display_name: res.displayName, secret_ref: names.token, app_secret_ref: names.app,
        verify_token_ref: names.verify, webhook_key: existing?.webhook_key ?? randomHex(24), is_active: true,
        status: "ok", webhook_status: provider === "mock" ? "verified" : "waiting", connected_at: now, disconnected_at: null,
        last_error: null, last_check_at: now, updated_at: now,
      };
      const { error } = await ctx.db.from("tenant_integrations").upsert(row, { onConflict: "tenant_id,type" });
      if (error) throw new HttpError(500, "Подключение не сохранено: " + error.message, "db_error");
      await logActivity(ctx.db, ctx.companyId, ctx.userId, "whatsapp_connected", { provider, phone: res.phoneE164 });
      // verify token показываем ОДИН раз — его нужно вставить в настройки вебхука у Meta.
      return json(req, { success: true, connection: publicView(await fullRow(ctx), { verifyToken }) });
    }

    if (route === "/check" && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...MANAGE]);
      const conn = await fullRow(ctx);
      if (!conn?.is_active) throw new HttpError(400, "WhatsApp не подключён", "not_connected");
      const st = await getAdapter(conn.provider).getConnectionStatus(conn, await loadSecrets(ctx.db, conn));
      await ctx.db.from("tenant_integrations").update({ status: st.api === "ok" ? "ok" : "down", last_error: st.error,
        last_check_at: new Date().toISOString(), last_latency_ms: st.latencyMs }).eq("id", conn.id);
      return json(req, { success: st.api === "ok", check: st, connection: publicView(await fullRow(ctx)) });
    }

    if (route === "/test" && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...MANAGE]);
      const conn = await fullRow(ctx);
      if (!conn?.is_active) throw new HttpError(400, "WhatsApp не подключён", "not_connected");
      const to = digits(body.to);
      if (to.length < 10) throw new HttpError(400, "Укажите номер получателя", "bad_request");
      const res = await getAdapter(conn.provider).sendMessage(conn, await loadSecrets(ctx.db, conn), to,
        String(body.text || "Тестовое сообщение из CRM").slice(0, 1000)).catch((e) => { throw new HttpError(502, (e as Error).message, "provider_error"); });
      await logActivity(ctx.db, ctx.companyId, ctx.userId, "whatsapp_test_sent", { to: toE164(to) });
      return json(req, { success: true, externalMessageId: res.externalMessageId });
    }

    if (route === "/disconnect" && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...MANAGE]);
      const conn = await fullRow(ctx);
      if (!conn) return json(req, { success: true, connection: publicView(null) });
      await getAdapter(conn.provider).disconnect(conn, await loadSecrets(ctx.db, conn)).catch(() => {});
      for (const n of [conn.secret_ref, conn.app_secret_ref, conn.verify_token_ref]) if (n) await ctx.db.rpc("wa_drop_secret", { p_name: n });
      await ctx.db.from("tenant_integrations").update({ is_active: false, status: "not_configured", webhook_status: "unknown",
        secret_ref: null, app_secret_ref: null, verify_token_ref: null, disconnected_at: new Date().toISOString() }).eq("id", conn.id);
      await logActivity(ctx.db, ctx.companyId, ctx.userId, "whatsapp_disconnected", { phone: conn.phone_e164 });
      return json(req, { success: true, connection: publicView(await fullRow(ctx)) });
    }

    const cm = route.match(/^\/conversations\/([0-9a-f-]{36})\/(reply|handoff|resume|read)$/i);
    if (cm && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...REPLY]);
      const conv = await ownConversation(ctx, cm[1]);
      if (cm[2] === "reply") {
        const text = String(body.text ?? "").trim();
        if (!text) throw new HttpError(400, "Пустое сообщение", "bad_request");
        const conn = await connectionOfCompany(ctx.db, ctx.companyId);
        const r = await sendOutgoing(ctx.db, conn, { companyId: ctx.companyId, conversationId: conv.id, patientId: conv.patient_id,
          to: conv.external_contact_id, text: text.slice(0, 4096), senderType: "employee", senderId: ctx.userId, clientRef: body.clientRef || null });
        await ctx.db.from("conversations").update({ unread_count: 0, assigned_to: ctx.userId }).eq("id", conv.id);
        return json(req, { success: r.status !== "failed", message: r });
      }
      if (cm[2] === "handoff") {
        await ctx.db.from("conversations").update({ ai_enabled: false, status: "needs_operator", assigned_to: ctx.userId,
          handoff_reason: body.reason || "Оператор взял диалог", updated_at: new Date().toISOString() }).eq("id", conv.id);
        await systemEvent(ctx, conv.id, conv.patient_id, `${ctx.fullName || "Сотрудник"} взял(а) диалог — робот выключен`);
        await logActivity(ctx.db, ctx.companyId, ctx.userId, "conversation_handoff", { conversation_id: conv.id });
      }
      if (cm[2] === "resume") {
        await ctx.db.from("conversations").update({ ai_enabled: true, status: "open", handoff_reason: null, updated_at: new Date().toISOString() }).eq("id", conv.id);
        await systemEvent(ctx, conv.id, conv.patient_id, `${ctx.fullName || "Сотрудник"} вернул(а) робота в диалог`);
        await logActivity(ctx.db, ctx.companyId, ctx.userId, "conversation_ai_resumed", { conversation_id: conv.id });
      }
      if (cm[2] === "read") await ctx.db.from("conversations").update({ unread_count: 0 }).eq("id", conv.id);
      return json(req, { success: true });
    }

    const rm = route.match(/^\/messages\/([0-9a-f-]{36})\/retry$/i);
    if (rm && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...REPLY]);
      const { data: m } = await ctx.db.from("messages").select("id, text, status, conversation_id, conversations!inner(external_contact_id)")
        .eq("company_id", ctx.companyId).eq("id", rm[1]).maybeSingle();
      if (!m) throw new HttpError(404, "Сообщение не найдено", "not_found");
      if (m.status !== "failed") return json(req, { success: true, message: { messageId: m.id, status: m.status } });
      await ctx.db.from("messages").update({ status: "pending" }).eq("id", m.id);
      const conn = await connectionOfCompany(ctx.db, ctx.companyId);
      const r = await deliver(ctx.db, conn, m.id, (m.conversations as unknown as { external_contact_id: string }).external_contact_id, m.text ?? "", ctx.companyId);
      return json(req, { success: r.status === "sent", message: r });
    }

    if (route === "/ai-settings") {
      if (req.method === "GET") {
        const ctx = await requireCompanyMember(req);
        return json(req, { success: true, settings: await loadAiSettings(ctx.db, ctx.companyId) });
      }
      if (req.method === "PUT" || req.method === "POST") {
        const ctx = await requireCompanyMember(req, [...MANAGE]);
        const allowed = ["ai_enabled", "system_prompt", "business_name", "business_description", "working_hours", "booking_rules",
          "language", "tone", "human_handoff_rules", "slot_step_min", "booking_horizon_days"];
        const patch: Record<string, unknown> = { company_id: ctx.companyId, updated_at: new Date().toISOString() };
        for (const k of allowed) if (k in body) patch[k] = (body as Record<string, unknown>)[k];
        const { error } = await ctx.db.from("ai_settings").upsert(patch, { onConflict: "company_id" });
        if (error) throw new HttpError(500, "Настройки не сохранены: " + error.message, "db_error");
        await logActivity(ctx.db, ctx.companyId, ctx.userId, "ai_settings_updated", { fields: Object.keys(patch) });
        return json(req, { success: true, settings: await loadAiSettings(ctx.db, ctx.companyId) });
      }
    }

    if (route === "/dev/inbound" && req.method === "POST") {
      const ctx = await requireCompanyMember(req, [...MANAGE]);
      const conn = await fullRow(ctx);
      if (!mockEnabled() || conn?.provider !== "mock" || !conn.is_active) throw new HttpError(400, "Имитация доступна только с тестовым провайдером", "mock_only");
      const from = digits(body.from);
      const result = await processInbound(ctx.db, conn, {
        company_id: ctx.companyId, integration_id: conn.id, channel: "whatsapp", conversation_id: null,
        external_message_id: String(body.id || "dev." + crypto.randomUUID()), external_contact_id: from, phone: toE164(from),
        customer_name: body.name || null, direction: "incoming", message_type: "text", text: String(body.text ?? ""),
        media_url: null, payload: { dev: true }, timestamp: new Date().toISOString(),
      });
      return json(req, { success: true, result });
    }

    throw new HttpError(404, `Маршрут ${req.method} ${route} не найден`, "no_route");
  } catch (err) {
    return errorResponse(req, err);
  }
});
