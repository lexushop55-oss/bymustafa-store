// Контекст сотрудника компании для CRM-функций (не суперадмин).
// Компания и роль берутся из tenant_members по проверенному токену — не из тела
// запроса и не из claims. Дальше все запросы идут service_role, но КАЖДЫЙ
// фильтруется по ctx.companyId.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient } from "./auth.ts";
import { HttpError } from "./http.ts";

export type CompanyRole = "Owner" | "Admin" | "Manager" | "Employee";

export interface CompanyContext {
  db: SupabaseClient;
  userId: string;
  email: string;
  companyId: string;
  companyName: string;
  role: CompanyRole;
  fullName: string;
}

export async function requireCompanyMember(req: Request, roles?: CompanyRole[]): Promise<CompanyContext> {
  const header = req.headers.get("authorization") ?? "";
  const token = /^bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new HttpError(401, "Войдите в кабинет", "no_token");

  const db = serviceClient();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Сессия недействительна или истекла", "invalid_token");

  const { data: m, error: mErr } = await db
    .from("tenant_members")
    .select("tenant_id, role, is_active, full_name, tenants!inner(id, name, status)")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (mErr) throw new HttpError(500, "Не удалось проверить доступ", "role_check_failed");
  const tenant = (m as { tenants?: { id: string; name: string; status: string } } | null)?.tenants;
  if (!m || !tenant) throw new HttpError(403, "Пользователь не привязан к компании", "no_company");
  if (!m.is_active || ["Suspended", "Inactive"].includes(tenant.status)) {
    throw new HttpError(403, "Доступ к компании приостановлен", "inactive");
  }
  if (roles && !roles.includes(m.role as CompanyRole)) {
    throw new HttpError(403, "Недостаточно прав для этого действия", "forbidden");
  }
  return {
    db, userId: data.user.id, email: data.user.email ?? "",
    companyId: tenant.id, companyName: tenant.name,
    role: m.role as CompanyRole, fullName: (m.full_name as string) ?? "",
  };
}

/** Запись в общий журнал действий компании (раздел «Журнал действий» CRM). */
export async function logActivity(
  db: SupabaseClient, companyId: string, actorId: string | null, action: string, payload: Record<string, unknown> = {},
) {
  const { error } = await db.from("activity_logs").insert({ company_id: companyId, actor_id: actorId, action, payload });
  if (error) console.error("[crm] activity insert failed", action, error.message);
}
