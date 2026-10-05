// POST /api/admin/integrations/reconnect
// Body: { tenantId: string, integrationType: 'whatsapp' | 'telegram' }
// Ответ: { success: boolean, message: string, status, latency }
//
// Шаги: валидация токена во внешнем API -> перерегистрация вебхука -> запись
// статуса в tenant_integrations -> аудит. Любая неудача возвращает 4xx/5xx
// с человекочитаемым message, который фронт показывает в toast.

import type { AdminContext } from "../_shared/auth.ts";
import { audit, readSecret } from "../_shared/auth.ts";
import { fetchWithTimeout, HttpError, timed } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v20.0";
const WEBHOOK_BASE = Deno.env.get("PUBLIC_WEBHOOK_BASE_URL") ?? "";

interface Body {
  tenantId?: string;
  integrationType?: string;
}

export async function handleReconnect(ctx: AdminContext, req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const tenantId = (body.tenantId ?? "").trim();
  const type = (body.integrationType ?? "").trim();

  if (!tenantId) throw new HttpError(400, "Не передан tenantId", "bad_request");
  if (type !== "whatsapp" && type !== "telegram") {
    throw new HttpError(400, "integrationType должен быть 'whatsapp' или 'telegram'", "bad_request");
  }

  // Минимальный интервал на конкретную интеграцию: setWebhook/subscribed_apps
  // у провайдеров сами рейт-лимитируются, а спам переподключений рвёт вебхук.
  // Ключ не зависит от админа — два разных админа не могут дёргать одну интеграцию по очереди.
  await enforceRateLimit(ctx.db, {
    key: `reconnect:target:${tenantId}:${type}`,
    max: 5,
    windowSeconds: 600,
    minIntervalSeconds: 30,
    message: "Переподключение этой интеграции уже выполнялось только что",
  });

  const { data: row, error } = await ctx.db
    .from("tenant_integrations")
    .select("id, tenant_id, type, external_id, secret_ref, webhook_url, tenants(name)")
    .eq("tenant_id", tenantId)
    .eq("type", type)
    .maybeSingle();

  if (error) throw new HttpError(500, `Не удалось прочитать интеграцию: ${error.message}`, "db_error");
  if (!row) throw new HttpError(404, "Интеграция для этой клиники не настроена", "not_found");

  const tenantName = (row as { tenants?: { name?: string } }).tenants?.name ?? tenantId;
  const token = await readSecret(ctx.db, row.secret_ref as string | null);
  if (!token) {
    await fail(ctx, tenantId, type, "Секрет интеграции не найден в Vault");
    throw new HttpError(422, "Токен интеграции не найден в Vault — переподключение невозможно", "no_secret");
  }

  const webhookUrl = (row.webhook_url as string | null) ?? (WEBHOOK_BASE ? `${WEBHOOK_BASE}/${type}/${tenantId}` : "");
  if (!webhookUrl) {
    await fail(ctx, tenantId, type, "Не задан публичный URL вебхука");
    throw new HttpError(500, "Не сконфигурирован PUBLIC_WEBHOOK_BASE_URL", "misconfigured");
  }

  const probe = await timed(() => (type === "telegram"
    ? reconnectTelegram(token, webhookUrl)
    : reconnectWhatsapp(token, String(row.external_id ?? ""))));

  if (probe.error) {
    await fail(ctx, tenantId, type, probe.error);
    // 502: сбой внешнего провайдера, а не нашей логики.
    throw new HttpError(502, `${tenantName}: ${probe.error}`, "provider_error");
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await ctx.db
    .from("tenant_integrations")
    .update({ status: "ok", webhook_url: webhookUrl, last_check_at: nowIso, last_latency_ms: probe.ms, last_error: null, verified_at: nowIso, updated_at: nowIso })
    .eq("id", row.id);
  if (updErr) throw new HttpError(500, `Статус не сохранён: ${updErr.message}`, "db_error");

  await audit(ctx, "reconnect_integration", tenantId, { integrationType: type, webhookUrl, latencyMs: probe.ms });

  return {
    success: true,
    message: `${tenantName}: ${type === "telegram" ? "вебхук Telegram" : "WhatsApp Cloud API"} переподключён`,
    status: "ok",
    latency: probe.ms,
  };
}

async function fail(ctx: AdminContext, tenantId: string, type: string, message: string) {
  const nowIso = new Date().toISOString();
  await ctx.db.from("tenant_integrations")
    .update({ status: "down", last_error: message, last_check_at: nowIso, updated_at: nowIso })
    .eq("tenant_id", tenantId).eq("type", type);
  await audit(ctx, "reconnect_integration", tenantId, { integrationType: type, error: message }, "error");
}

/** Telegram: setWebhook переустанавливает адрес и сбрасывает залипшие апдейты. */
async function reconnectTelegram(token: string, webhookUrl: string) {
  const secretToken = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
  const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      drop_pending_updates: false,
      allowed_updates: ["message", "callback_query"],
      ...(secretToken ? { secret_token: secretToken } : {}),
    }),
  }, 6000);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok !== true) throw new Error(body?.description ?? `Telegram API вернул HTTP ${res.status}`);
  return body.result;
}

/**
 * WhatsApp Cloud API: вебхук задаётся на уровне App, не номера, поэтому
 * «переподключение» = валидация токена + повторная подписка номера
 * (subscribed_apps) — именно она отваливается при ротации токена.
 */
async function reconnectWhatsapp(token: string, phoneNumberId: string) {
  if (!phoneNumberId) throw new Error("Не указан phone_number_id");

  const check = await fetchWithTimeout(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}?fields=verified_name`,
    { headers: { authorization: `Bearer ${token}` } },
    5000,
  );
  const checkBody = await check.json().catch(() => ({}));
  if (!check.ok) throw new Error(checkBody?.error?.message ?? `Токен отклонён (HTTP ${check.status})`);

  const sub = await fetchWithTimeout(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/subscribed_apps`,
    { method: "POST", headers: { authorization: `Bearer ${token}` } },
    // Meta отвечает на subscribed_apps медленнее, чем на чтение полей:
    // 8 с вместо 6 — иначе задержка Graph API даёт ложный статус down.
    8000,
  );
  const subBody = await sub.json().catch(() => ({}));
  if (!sub.ok || subBody?.success === false) {
    throw new Error(subBody?.error?.message ?? `Подписка номера не оформлена (HTTP ${sub.status})`);
  }
  return subBody;
}
