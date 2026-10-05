// Аутентификация и авторизация суперадмина + запись аудита.
// Правило: роль НИКОГДА не берётся из claims JWT — только из таблицы platform_admins.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { HttpError } from "./http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export interface AdminContext {
  /** Клиент с service_role: обходит RLS, используется только после проверки роли. */
  db: SupabaseClient;
  userId: string;
  email: string;
  ip: string | null;
  userAgent: string | null;
}

export function serviceClient(): SupabaseClient {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new HttpError(500, "Функция не сконфигурирована: нет SUPABASE_URL / SERVICE_ROLE_KEY", "misconfigured");
  }
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/**
 * Middleware для всех /api/admin/* маршрутов.
 * 1. Достаёт Bearer-токен, валидирует его в Auth (подпись + срок).
 * 2. Проверяет активную запись в platform_admins с ролью superadmin.
 * 3. Отклоняет уже импersonированные токены — из-под impersonation
 *    нельзя вызывать админ-API (защита от эскалации).
 */
export async function requireSuperadmin(req: Request): Promise<AdminContext> {
  const header = req.headers.get("authorization") ?? "";
  // Регистр схемы и лишние пробелы не должны давать 401: нормализуем префикс регуляркой.
  const token = /^bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new HttpError(401, "Требуется авторизация суперадмина", "no_token");

  const db = serviceClient();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, "Сессия недействительна или истекла", "invalid_token");

  const user = data.user;
  const claims = (user.app_metadata ?? {}) as Record<string, unknown>;
  if (claims.impersonated_by) {
    throw new HttpError(403, "Админ-API недоступно из режима impersonation", "impersonation_denied");
  }

  const { data: admin, error: adminErr } = await db
    .from("platform_admins")
    .select("user_id, role, is_active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminErr) throw new HttpError(500, `Не удалось проверить права: ${adminErr.message}`, "role_check_failed");
  if (!admin || !admin.is_active || admin.role !== "superadmin") {
    throw new HttpError(403, "Недостаточно прав: нужен доступ суперадмина", "forbidden");
  }

  return {
    db,
    userId: user.id,
    email: user.email ?? "",
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent"),
  };
}

/** Запись в admin_audit_logs. Ошибку аудита не проглатываем молча — логируем. */
export async function audit(
  ctx: AdminContext,
  action: string,
  targetTenantId: string | null,
  payload: Record<string, unknown> = {},
  result: "ok" | "error" = "ok",
): Promise<void> {
  const { error } = await ctx.db.from("admin_audit_logs").insert({
    actor_id: ctx.userId,
    actor_email: ctx.email,
    action,
    target_tenant_id: targetTenantId,
    payload,
    result,
    ip: ctx.ip,
    user_agent: ctx.userAgent,
  });
  if (error) console.error("[admin] audit insert failed", action, error.message);
}

/**
 * Секреты интеграций живут в Supabase Vault, а не в таблице.
 * secret_ref в tenant_integrations — это vault.secrets.name.
 */
export async function readSecret(db: SupabaseClient, ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const { data, error } = await db
    .schema("vault")
    .from("decrypted_secrets")
    .select("decrypted_secret")
    .eq("name", ref)
    .maybeSingle();
  if (error) {
    console.error("[admin] vault read failed", ref, error.message);
    return null;
  }
  return (data?.decrypted_secret as string | undefined) ?? null;
}
