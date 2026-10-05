// GET /api/admin/health — сводный health-check платформы.
// Ответ:
// {
//   db:            { status, latency },
//   edgeFunctions: { status, latency },
//   whatsapp:      { status, latency, tenants: [...] },
//   telegram:      { status, latency, tenants: [...] },
//   queues:        { pending, failed, byQueue: [...] },
//   checkedAt
// }

import type { AdminContext } from "../_shared/auth.ts";
import { readSecret } from "../_shared/auth.ts";
import { fetchWithTimeout, timed, withDeadline } from "../_shared/http.ts";

type Status = "ok" | "degraded" | "down";

interface ComponentHealth {
  status: Status;
  latency: number | null;
  detail?: string;
  tenants?: Array<{ tenantId: string; name: string; status: Status; error: string | null }>;
}

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v20.0";

// Бюджеты health-check. Все пробы идут параллельно, поэтому верхняя граница
// ответа роута — самая медленная проба, а не сумма.
const PROBE_TIMEOUT_MS = 5000;   // Graph API / Bot API
const EDGE_TIMEOUT_MS = 4000;    // собственный лёгкий эндпоинт
const DB_TIMEOUT_MS = 5000;      // у supabase-js нет signal — страхуем withDeadline

/** PostgreSQL ping: RPC db_ping() — дешёвый round-trip без чтения таблиц. */
async function checkDb(ctx: AdminContext): Promise<ComponentHealth> {
  const probe = await withDeadline(
    timed(async () => {
      const { error } = await ctx.db.rpc("db_ping");
      if (error) throw new Error(error.message);
      return true;
    }),
    DB_TIMEOUT_MS + 500,
    () => ({ value: null, ms: DB_TIMEOUT_MS, error: `Таймаут ${DB_TIMEOUT_MS} мс: БД не ответила` }),
  );
  if (probe.error) return { status: "down", latency: probe.ms, detail: probe.error };
  // > 400 мс на ping — признак деградации пула/региона.
  return { status: probe.ms > 400 ? "degraded" : "ok", latency: probe.ms };
}

/**
 * Edge Functions: пингуем изолированный лёгкий эндпоинт (EDGE_PROBE_URL,
 * например /functions/v1/health-probe). Самовызов admin-функции запрещён —
 * получилась бы рекурсия и ложная латентность.
 */
async function checkEdge(): Promise<ComponentHealth> {
  const url = Deno.env.get("EDGE_PROBE_URL");
  if (!url) return { status: "ok", latency: null, detail: "EDGE_PROBE_URL не задан, проверен только текущий рантайм" };
  const probe = await timed(async () => {
    const res = await fetchWithTimeout(url, { headers: { "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "" } }, EDGE_TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  });
  if (probe.error) return { status: "down", latency: probe.ms, detail: probe.error };
  return { status: probe.ms > 1200 ? "degraded" : "ok", latency: probe.ms };
}

interface IntegrationRow {
  tenant_id: string;
  type: "whatsapp" | "telegram";
  external_id: string | null;
  webhook_url: string | null;
  secret_ref: string | null;
  tenants: { name: string } | null;
}

/** WhatsApp Cloud API: читаем phone_number_id — самый дешёвый авторизованный вызов. */
async function probeWhatsapp(ctx: AdminContext, row: IntegrationRow) {
  const token = await readSecret(ctx.db, row.secret_ref);
  if (!token || !row.external_id) return { status: "down" as Status, error: "Нет токена или phone_number_id", ms: 0 };
  const probe = await timed(async () => {
    const res = await fetchWithTimeout(
      `https://graph.facebook.com/${GRAPH_VERSION}/${row.external_id}?fields=verified_name,quality_rating`,
      { headers: { authorization: `Bearer ${token}` } },
      PROBE_TIMEOUT_MS,
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    return body;
  });
  return { status: (probe.error ? "down" : "ok") as Status, error: probe.error, ms: probe.ms };
}

/** Telegram: getWebhookInfo сразу показывает и доступность API, и статус вебхука. */
async function probeTelegram(ctx: AdminContext, row: IntegrationRow) {
  const token = await readSecret(ctx.db, row.secret_ref);
  if (!token) return { status: "down" as Status, error: "Нет токена бота", ms: 0 };
  const probe = await timed(async () => {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/getWebhookInfo`, {}, PROBE_TIMEOUT_MS);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok !== true) throw new Error(body?.description ?? `HTTP ${res.status}`);
    return body.result as { url?: string; last_error_message?: string; pending_update_count?: number };
  });
  if (probe.error) return { status: "down" as Status, error: probe.error, ms: probe.ms };
  const info = probe.value!;
  if (!info.url) return { status: "degraded" as Status, error: "Вебхук не зарегистрирован (polling-режим)", ms: probe.ms };
  if (info.last_error_message) return { status: "degraded" as Status, error: info.last_error_message, ms: probe.ms };
  return { status: "ok" as Status, error: null, ms: probe.ms };
}

function rollup(items: Array<{ status: Status }>): Status {
  if (items.length === 0) return "ok";
  if (items.every((i) => i.status === "ok")) return "ok";
  if (items.every((i) => i.status === "down")) return "down";
  return "degraded";
}

export async function handleHealth(ctx: AdminContext) {
  const { data: integrations, error: intErr } = await ctx.db
    .from("tenant_integrations")
    .select("tenant_id, type, external_id, webhook_url, secret_ref, tenants(name)")
    .neq("status", "not_configured")
    .returns<IntegrationRow[]>();

  if (intErr) console.error("[admin] integrations read failed", intErr.message);
  const rows = integrations ?? [];

  // Все проверки параллельно: суммарная латентность = самой медленной, не сумме.
  const [db, edge, waResults, tgResults, queues] = await Promise.all([
    checkDb(ctx),
    checkEdge(),
    Promise.all(rows.filter((r) => r.type === "whatsapp").map(async (r) => ({ row: r, res: await probeWhatsapp(ctx, r) }))),
    Promise.all(rows.filter((r) => r.type === "telegram").map(async (r) => ({ row: r, res: await probeTelegram(ctx, r) }))),
    ctx.db.from("queue_stats").select("queue, pending, failed, oldest_sec"),
  ]);

  const toComponent = (list: Array<{ row: IntegrationRow; res: { status: Status; error: string | null; ms: number } }>): ComponentHealth => ({
    status: rollup(list.map((x) => x.res)),
    latency: list.length ? Math.max(...list.map((x) => x.res.ms)) : null,
    detail: list.filter((x) => x.res.status !== "ok").map((x) => `${x.row.tenants?.name ?? x.row.tenant_id}: ${x.res.error}`).join("; ") || undefined,
    tenants: list.map((x) => ({ tenantId: x.row.tenant_id, name: x.row.tenants?.name ?? "—", status: x.res.status, error: x.res.error })),
  });

  const whatsapp = toComponent(waResults);
  const telegram = toComponent(tgResults);
  const byQueue = (queues.data ?? []) as Array<{ queue: string; pending: number; failed: number; oldest_sec: number }>;

  // Пишем срез в историю — без await, ответ не должен ждать запись.
  const probeRows = [
    { component: "db", status: db.status, latency_ms: db.latency, detail: db.detail ?? null },
    { component: "edge", status: edge.status, latency_ms: edge.latency, detail: edge.detail ?? null },
    { component: "whatsapp", status: whatsapp.status, latency_ms: whatsapp.latency, detail: whatsapp.detail ?? null },
    { component: "telegram", status: telegram.status, latency_ms: telegram.latency, detail: telegram.detail ?? null },
  ];
  ctx.db.from("health_probe_log").insert(probeRows).then(({ error }) => {
    if (error) console.error("[admin] health log failed", error.message);
  });

  // Кэшируем последний статус в tenant_integrations, чтобы таблица компаний
  // показывала бейджи WA/TG без повторного обхода внешних API.
  // Параллельно: последовательные UPDATE на 20 клиник добавляли секунды к ответу.
  const nowIso = new Date().toISOString();
  await Promise.all([...waResults, ...tgResults].map((item) =>
    ctx.db.from("tenant_integrations")
      .update({
        status: item.res.status,
        last_check_at: nowIso,
        last_latency_ms: item.res.ms,
        last_error: item.res.error,
        updated_at: nowIso,
      })
      .eq("tenant_id", item.row.tenant_id)
      .eq("type", item.row.type)
  ));

  return {
    db: { status: db.status, latency: db.latency, detail: db.detail },
    edgeFunctions: { status: edge.status, latency: edge.latency, detail: edge.detail },
    whatsapp,
    telegram,
    queues: {
      pending: byQueue.reduce((a, q) => a + Number(q.pending ?? 0), 0),
      failed: byQueue.reduce((a, q) => a + Number(q.failed ?? 0), 0),
      byQueue,
    },
    checkedAt: new Date().toISOString(),
  };
}
