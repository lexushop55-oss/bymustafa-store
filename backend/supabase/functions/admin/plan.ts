// PATCH /api/admin/tenants/:id/plan
// Body: { plan: string }
// Смена тарифа идёт только через SECURITY DEFINER функцию admin_set_tenant_plan,
// которая ещё раз проверяет is_superadmin(actor) на стороне БД и сама пишет аудит.
// Прямой UPDATE public.tenants из браузера отозван в миграции.

import type { AdminContext } from "../_shared/auth.ts";
import { HttpError } from "../_shared/http.ts";

export async function handleSetPlan(ctx: AdminContext, req: Request, tenantId: string) {
  if (!tenantId) throw new HttpError(400, "Не указан идентификатор клиники", "bad_request");

  const body = (await req.json().catch(() => ({}))) as { plan?: string };
  const plan = (body.plan ?? "").trim();
  if (!plan) throw new HttpError(400, "Не передан тариф", "bad_request");

  const { data: allowed, error: planErr } = await ctx.db
    .from("plans")
    .select("name")
    .eq("name", plan)
    .maybeSingle();
  // Таблица тарифов может отсутствовать на раннем этапе — тогда доверяем БД-функции.
  if (planErr && planErr.code !== "42P01") {
    throw new HttpError(500, `Не удалось проверить тариф: ${planErr.message}`, "db_error");
  }
  if (!planErr && !allowed) throw new HttpError(422, `Тариф «${plan}» не существует`, "unknown_plan");

  const { data, error } = await ctx.db.rpc("admin_set_tenant_plan", {
    p_tenant_id: tenantId,
    p_plan: plan,
    p_actor: ctx.userId,
  });

  if (error) {
    if (error.code === "42501") throw new HttpError(403, "Недостаточно прав для смены тарифа", "forbidden");
    if (error.code === "P0002") throw new HttpError(404, "Клиника не найдена", "not_found");
    throw new HttpError(500, `Тариф не изменён: ${error.message}`, "db_error");
  }

  return { success: true, message: `Тариф изменён: ${plan}`, tenant: data };
}
