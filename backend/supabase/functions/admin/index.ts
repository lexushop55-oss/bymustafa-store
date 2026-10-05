// Единая Edge Function `admin` с внутренним роутером.
// Деплой:  supabase functions deploy admin
// Публичный путь: /functions/v1/admin/*  (прокси отдаёт его как /api/admin/*)
//
// Маршруты:
//   GET   /health
//   POST  /integrations/reconnect
//   POST  /auth/impersonate
//   PATCH /tenants/:id/plan
//   POST  /tenants              (компания + владелец Owner)
//
// Любой маршрут проходит через requireSuperadmin: без активной записи
// в platform_admins запрос не доходит до обработчика.

import { requireSuperadmin } from "../_shared/auth.ts";
import { corsHeaders, errorResponse, HttpError, json } from "../_shared/http.ts";
import { enforceRateLimit } from "../_shared/ratelimit.ts";
import { handleHealth } from "./health.ts";
import { handleReconnect } from "./reconnect.ts";
import { handleImpersonate } from "./impersonate.ts";
import { handleSetPlan } from "./plan.ts";
import { handleCreateCompany } from "./companies.ts";

/** Убираем префиксы, которые добавляют Supabase-роутер и внешний прокси. */
function routeOf(url: URL): string {
  return url.pathname
    .replace(/^\/functions\/v1/, "")
    .replace(/^\/api/, "")
    .replace(/^\/admin/, "")
    .replace(/\/+$/, "") || "/";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  const url = new URL(req.url);
  const route = routeOf(url);
  const started = performance.now();

  try {
    const ctx = await requireSuperadmin(req);

    if (route === "/health" && req.method === "GET") {
      return json(req, await handleHealth(ctx));
    }
    if (route === "/integrations/reconnect" && req.method === "POST") {
      // 20 переподключений за 10 мин на админа + антидребезг 2 с.
      // Лимит на конкретную интеграцию (30 с) стоит внутри обработчика.
      await enforceRateLimit(ctx.db, {
        key: `reconnect:actor:${ctx.userId}`,
        max: 20,
        windowSeconds: 600,
        minIntervalSeconds: 2,
        message: "Слишком много переподключений подряд",
      });
      return json(req, await handleReconnect(ctx, req));
    }
    if (route === "/auth/impersonate" && req.method === "POST") {
      // Вход от лица клиники — самый чувствительный метод: 10 за 5 мин, не чаще 3 с.
      await enforceRateLimit(ctx.db, {
        key: `impersonate:actor:${ctx.userId}`,
        max: 10,
        windowSeconds: 300,
        minIntervalSeconds: 3,
        message: "Превышен лимит сессий сопровождения",
      });
      return json(req, await handleImpersonate(ctx, req));
    }
    if (route === "/tenants" && req.method === "POST") {
      await enforceRateLimit(ctx.db, {
        key: `create_company:actor:${ctx.userId}`,
        max: 30,
        windowSeconds: 600,
        minIntervalSeconds: 2,
        message: "Слишком много компаний подряд",
      });
      return json(req, await handleCreateCompany(ctx, req));
    }
    const planMatch = route.match(/^\/tenants\/([0-9a-f-]{36})\/plan$/i);
    if (planMatch && (req.method === "PATCH" || req.method === "POST")) {
      return json(req, await handleSetPlan(ctx, req, planMatch[1]));
    }

    throw new HttpError(404, `Маршрут ${req.method} ${route} не найден`, "no_route");
  } catch (err) {
    return errorResponse(req, err);
  } finally {
    console.log(`[admin] ${req.method} ${route} ${Math.round(performance.now() - started)}ms`);
  }
});
