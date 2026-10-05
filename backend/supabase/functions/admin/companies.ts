// POST /api/admin/tenants
// Body: { name, businessType?, plan?, status?, createdAt?,
//         owner: { fullName, email, mode: 'invite' | 'password', password? } }
// Создаёт компанию, auth-пользователя владельца и связь Owner.
// Пароль владельца задаётся только здесь, на сервере, через service_role;
// во фронтенде ключа service_role нет. Режим 'invite' отправляет письмо-приглашение,
// пароль владелец задаёт сам.

import { audit, type AdminContext } from "../_shared/auth.ts";
import { HttpError } from "../_shared/http.ts";

const PLANS = ["Starter", "Business", "Professional", "Enterprise"];
const STATUSES = ["Active", "Trial", "Pending", "Suspended", "Inactive"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Body {
  name?: string; businessType?: string; plan?: string; status?: string; createdAt?: string;
  owner?: { fullName?: string; email?: string; mode?: "invite" | "password"; password?: string };
}

export async function handleCreateCompany(ctx: AdminContext, req: Request) {
  const body = (await req.json().catch(() => ({}))) as Body;
  const name = (body.name ?? "").trim();
  const owner = body.owner ?? {};
  const email = (owner.email ?? "").trim().toLowerCase();
  const fullName = (owner.fullName ?? "").trim();
  const mode = owner.mode === "password" ? "password" : "invite";
  const plan = PLANS.includes(body.plan ?? "") ? body.plan! : "Starter";
  const status = STATUSES.includes(body.status ?? "") ? body.status! : "Trial";

  if (!name) throw new HttpError(400, "Укажите название компании", "bad_request");
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "Некорректный email владельца", "bad_email");
  if (mode === "password" && (owner.password ?? "").length < 8) {
    throw new HttpError(400, "Временный пароль — не короче 8 символов", "weak_password");
  }

  // 1. Компания.
  const { data: tenant, error: tErr } = await ctx.db.from("tenants").insert({
    name, plan, status, business_type: body.businessType || "Стоматология",
    ...(body.createdAt ? { created_at: body.createdAt } : {}),
  }).select("*").single();
  if (tErr) throw new HttpError(500, `Компания не создана: ${tErr.message}`, "db_error");

  // 2. Пользователь. app_metadata.company_id выключает триггер автосоздания компании.
  const appMeta = { company_id: tenant.id };
  const userMeta = { full_name: fullName };
  const created = mode === "invite"
    ? await ctx.db.auth.admin.inviteUserByEmail(email, {
        data: userMeta, redirectTo: Deno.env.get("CRM_APP_URL") ? `${Deno.env.get("CRM_APP_URL")}#/reset` : undefined,
      })
    : await ctx.db.auth.admin.createUser({
        email, password: owner.password, email_confirm: true, user_metadata: userMeta, app_metadata: appMeta,
      });

  if (created.error || !created.data?.user) {
    await ctx.db.from("tenants").delete().eq("id", tenant.id); // откат: компания без владельца не нужна
    const msg = created.error?.message ?? "неизвестная ошибка";
    const code = /already/i.test(msg) ? "user_exists" : "auth_error";
    throw new HttpError(code === "user_exists" ? 409 : 500,
      code === "user_exists" ? "Пользователь с таким email уже зарегистрирован" : `Владелец не создан: ${msg}`, code);
  }
  const user = created.data.user;
  if (mode === "invite") await ctx.db.auth.admin.updateUserById(user.id, { app_metadata: appMeta });

  // 3. Связь user → company с ролью Owner.
  const { error: mErr } = await ctx.db.from("tenant_members").insert({
    tenant_id: tenant.id, user_id: user.id, role: "Owner", full_name: fullName, email,
  });
  if (mErr) throw new HttpError(500, `Связь с компанией не создана: ${mErr.message}`, "db_error");
  await ctx.db.from("tenants").update({ owner_id: user.id }).eq("id", tenant.id);
  await ctx.db.from("workspace_state").insert({ company_id: tenant.id, data: {} });

  await audit(ctx, "create_company", tenant.id, { name, plan, status, owner_email: email, mode });

  return {
    success: true,
    message: mode === "invite" ? `Компания создана, приглашение отправлено на ${email}` : "Компания и владелец созданы",
    tenant: { ...tenant, owner_id: user.id },
    owner: { id: user.id, email, fullName, mode },
  };
}
