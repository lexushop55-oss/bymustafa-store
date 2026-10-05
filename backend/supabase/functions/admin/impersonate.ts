// POST /api/admin/auth/impersonate
// Body: { targetTenantId: string }
// Ответ: { success, token, expiresAt, tenant: { id, name }, redirectUrl }
//
// Токен подписывается SUPABASE_JWT_SECRET (HS256), живёт 10 минут и несёт
// claim impersonated_by. Middleware requireSuperadmin отклоняет такие токены,
// поэтому из-под impersonation нельзя вернуться в админ-API.

import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import type { AdminContext } from "../_shared/auth.ts";
import { audit } from "../_shared/auth.ts";
import { HttpError } from "../_shared/http.ts";

const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET") ?? "";
const CRM_URL = Deno.env.get("CRM_APP_URL") ?? "";
const TTL_SECONDS = Number(Deno.env.get("IMPERSONATION_TTL_SECONDS") ?? "600");

export async function handleImpersonate(ctx: AdminContext, req: Request) {
  if (!JWT_SECRET) throw new HttpError(500, "Не сконфигурирован SUPABASE_JWT_SECRET", "misconfigured");

  const body = (await req.json().catch(() => ({}))) as { targetTenantId?: string };
  const tenantId = (body.targetTenantId ?? "").trim();
  if (!tenantId) throw new HttpError(400, "Не передан targetTenantId", "bad_request");

  const { data: tenant, error } = await ctx.db
    .from("tenants")
    .select("id, name, status, owner_id")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) throw new HttpError(500, `Не удалось прочитать клинику: ${error.message}`, "db_error");
  if (!tenant) throw new HttpError(404, "Клиника не найдена", "not_found");

  // Владелец нужен как subject токена: impersonation работает от лица
  // реального пользователя, иначе RLS клиники не даст доступа к данным.
  let subjectId = tenant.owner_id as string | null;
  if (!subjectId) {
    const { data: owner } = await ctx.db
      .from("tenant_members")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("role", "Owner")
      .limit(1)
      .maybeSingle();
    subjectId = (owner?.user_id as string | undefined) ?? null;
  }
  if (!subjectId) {
    await audit(ctx, "impersonate", tenantId, { error: "no_owner" }, "error");
    throw new HttpError(422, "У клиники нет владельца — вход от её лица невозможен", "no_owner");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const expNumeric = getNumericDate(TTL_SECONDS);
  const token = await create({ alg: "HS256", typ: "JWT" }, {
    sub: subjectId,
    aud: "authenticated",
    role: "authenticated",
    iat: getNumericDate(0),
    exp: expNumeric,
    session_id: crypto.randomUUID(),
    app_metadata: {
      provider: "impersonation",
      tenant_id: tenantId,
      impersonated_by: ctx.userId,
      impersonated_by_email: ctx.email,
    },
    user_metadata: { impersonation: true },
  }, key);

  await audit(ctx, "impersonate", tenantId, {
    subjectId,
    ttlSeconds: TTL_SECONDS,
    tenantName: tenant.name,
  });

  const expiresAt = new Date(expNumeric * 1000).toISOString();
  return {
    success: true,
    token,
    expiresAt,
    tenant: { id: tenant.id, name: tenant.name },
    // Фронт открывает CRM с одноразовым токеном в хэше — он не попадает в логи прокси.
    redirectUrl: CRM_URL ? `${CRM_URL}#impersonation_token=${encodeURIComponent(token)}` : null,
    message: `Сессия сопровождения открыта: ${tenant.name} (${Math.round(TTL_SECONDS / 60)} мин)`,
  };
}
