// Инструменты CRM для робота-администратора (function calling).
// Каждый инструмент — реальный запрос к таблицам CRM, ВСЕГДА с фильтром
// company_id = ctx.companyId. Робот не может прочитать или изменить данные
// другой компании, даже если передаст чужой id: такая строка просто не найдётся.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export interface ToolContext {
  db: SupabaseClient;
  companyId: string;
  conversationId: string;
  patientId: string | null;
  triggerMessageId: string | null;
  timezone: string;
  settings: AiSettings;
}

export interface AiSettings {
  ai_enabled: boolean;
  system_prompt: string | null;
  business_name: string | null;
  business_description: string | null;
  working_hours: Record<string, { open?: string; close?: string; break?: [string, string]; off?: boolean }>;
  booking_rules: string | null;
  language: string;
  tone: string;
  human_handoff_rules: { keywords?: string[]; on_ai_error?: boolean; medical_complaints?: boolean };
  slot_step_min: number;
  booking_horizon_days: number;
}

export interface ToolOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  entity?: { type: string; id: string };
  summary: string;                 // строка для ленты действий в чате
}

type Handler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolOutcome>;

// ---------- время в часовом поясе клиники ----------
function tzOffsetMin(tz: string, at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(at).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at.getTime() / 60000) * 60000) / 60000;
}
export function localToUtc(date: string, time: string, tz: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  return new Date(guess.getTime() - tzOffsetMin(tz, guess) * 60000);
}
export function utcToLocal(iso: string | Date, tz: string): { date: string; time: string; weekday: string } {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: String(p.weekday).toLowerCase().slice(0, 3) };
}
const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDaysIso = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const fail = (error: string, summary: string): ToolOutcome => ({ ok: false, error, summary });

async function ownPatient(ctx: ToolContext, id?: unknown): Promise<string | null> {
  const pid = str(id) || ctx.patientId;
  if (!pid) return null;
  const { data } = await ctx.db.from("patients").select("id").eq("company_id", ctx.companyId).eq("id", pid).maybeSingle();
  return data?.id ?? null;
}

async function apptView(ctx: ToolContext, a: Record<string, unknown>) {
  const l = utcToLocal(String(a.starts_at), ctx.timezone);
  return { id: a.id, date: l.date, time: l.time, status: a.status, duration_min: a.duration_min,
    service: (a.services as { name?: string } | null)?.name ?? null, doctor: (a.doctors as { full_name?: string } | null)?.full_name ?? null,
    service_id: a.service_id, doctor_id: a.doctor_id };
}

// ---------- реализации ----------
const handlers: Record<string, Handler> = {
  async find_patient(ctx, a) {
    const phone = str(a.phone).replace(/\D/g, ""), name = str(a.name);
    let q = ctx.db.from("patients").select("id, full_name, phone").eq("company_id", ctx.companyId).limit(5);
    if (phone) q = q.eq("phone_digits", phone); else if (name) q = q.ilike("full_name", `%${name}%`); else return fail("phone_or_name_required", "Поиск пациента: не указан телефон или имя");
    const { data, error } = await q;
    if (error) return fail(error.message, "Поиск пациента: ошибка");
    return { ok: true, data, summary: data?.length ? `Найден пациент → ${data[0].full_name}` : "Пациент не найден",
      entity: data?.[0] ? { type: "patient", id: data[0].id } : undefined };
  },

  async create_patient(ctx, a) {
    const phone = str(a.phone);
    if (!phone) return fail("phone_required", "Создание пациента: нет телефона");
    const { data, error } = await ctx.db.rpc("crm_find_or_create_patient", { p_company: ctx.companyId, p_phone: phone, p_name: str(a.full_name), p_source: "whatsapp" });
    if (error) return fail(error.message, "Создание пациента: ошибка");
    const row = data?.[0];
    return { ok: true, data: row, entity: { type: "patient", id: row.patient_id }, summary: row.created ? "Создан пациент" : "Пациент уже существует" };
  },

  async update_patient(ctx, a) {
    const pid = await ownPatient(ctx, a.patient_id);
    if (!pid) return fail("patient_not_found", "Обновление пациента: не найден");
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (str(a.full_name)) patch.full_name = str(a.full_name).slice(0, 120);
    if (str(a.email)) patch.email = str(a.email).slice(0, 200);
    if (str(a.birth_date) && /^\d{4}-\d{2}-\d{2}$/.test(str(a.birth_date))) patch.birth_date = str(a.birth_date);
    if (Object.keys(patch).length === 1) return fail("nothing_to_update", "Обновление пациента: нет полей");
    const { error } = await ctx.db.from("patients").update(patch).eq("company_id", ctx.companyId).eq("id", pid);
    if (error) return fail(error.message, "Обновление пациента: ошибка");
    if (patch.full_name) await ctx.db.from("conversations").update({ contact_name: patch.full_name }).eq("id", ctx.conversationId).eq("company_id", ctx.companyId);
    return { ok: true, data: patch, entity: { type: "patient", id: pid }, summary: `Обновлён пациент: ${Object.keys(patch).filter((k) => k !== "updated_at").join(", ")}` };
  },

  async get_patient(ctx, a) {
    const pid = await ownPatient(ctx, a.patient_id);
    if (!pid) return fail("patient_not_found", "Карточка пациента: не найдена");
    const { data } = await ctx.db.from("patients").select("id, full_name, phone, email, birth_date, created_at").eq("company_id", ctx.companyId).eq("id", pid).single();
    const { data: notes } = await ctx.db.from("patient_notes").select("text, kind, created_at").eq("company_id", ctx.companyId).eq("patient_id", pid).order("created_at", { ascending: false }).limit(5);
    return { ok: true, data: { ...data, recent_notes: notes ?? [] }, entity: { type: "patient", id: pid }, summary: `Открыта карточка → ${data?.full_name}` };
  },

  async get_services(ctx, a) {
    let q = ctx.db.from("services").select("id, name, category, price, duration_min, ai_bookable").eq("company_id", ctx.companyId).eq("is_active", true).order("name");
    if (str(a.query)) q = q.ilike("name", `%${str(a.query)}%`);
    const { data, error } = await q;
    if (error) return fail(error.message, "Услуги: ошибка");
    return { ok: true, data, summary: `Получены услуги (${data?.length ?? 0})` };
  },

  async get_doctors(ctx, a) {
    const { data, error } = await ctx.db.from("doctors").select("id, full_name, specialty, work_open, work_close").eq("company_id", ctx.companyId).eq("is_active", true).order("full_name");
    if (error) return fail(error.message, "Врачи: ошибка");
    let list = data ?? [];
    if (str(a.service_id)) {
      const { data: sv } = await ctx.db.from("services").select("doctor_ids").eq("company_id", ctx.companyId).eq("id", str(a.service_id)).maybeSingle();
      if (sv?.doctor_ids?.length) list = list.filter((d) => sv.doctor_ids.includes(d.id));
    }
    return { ok: true, data: list, summary: `Получены врачи (${list.length})` };
  },

  async get_available_slots(ctx, a) {
    const serviceId = str(a.service_id);
    const { data: sv } = await ctx.db.from("services").select("id, name, duration_min, doctor_ids").eq("company_id", ctx.companyId).eq("id", serviceId).eq("is_active", true).maybeSingle();
    if (!sv) return fail("service_not_found", "Свободные слоты: услуга не найдена");
    const today = utcToLocal(new Date(), ctx.timezone).date;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(str(a.date_from)) ? str(a.date_from) : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(str(a.date_to)) ? str(a.date_to) : from;
    const lastDay = addDaysIso(today, ctx.settings.booking_horizon_days || 14);
    const tFrom = str(a.time_from) ? toMin(str(a.time_from)) : 0, tTo = str(a.time_to) ? toMin(str(a.time_to)) : 24 * 60;
    const limit = Math.min(Number(a.limit) || 6, 20), step = ctx.settings.slot_step_min || 30;

    let dq = ctx.db.from("doctors").select("id, full_name, work_open, work_close").eq("company_id", ctx.companyId).eq("is_active", true);
    if (str(a.doctor_id)) dq = dq.eq("id", str(a.doctor_id));
    else if (sv.doctor_ids?.length) dq = dq.in("id", sv.doctor_ids);
    const { data: docs } = await dq;
    if (!docs?.length) return fail("no_doctors", "Свободные слоты: нет врачей для услуги");

    const rangeStart = localToUtc(from, "00:00", ctx.timezone).toISOString(), rangeEnd = localToUtc(addDaysIso(to, 1), "00:00", ctx.timezone).toISOString();
    const { data: busy } = await ctx.db.from("appointments").select("doctor_id, starts_at, duration_min").eq("company_id", ctx.companyId)
      .in("doctor_id", docs.map((d) => d.id)).not("status", "in", "(cancelled,no_show)").gte("starts_at", rangeStart).lt("starts_at", rangeEnd);

    const nowPlus = Date.now() + 30 * 60000;
    const slots: { date: string; time: string; doctor_id: string; doctor_name: string; starts_at: string }[] = [];
    for (let day = from; day <= to && day <= lastDay && slots.length < limit; day = addDaysIso(day, 1)) {
      const wd = utcToLocal(localToUtc(day, "12:00", ctx.timezone), ctx.timezone).weekday;
      const wh = ctx.settings.working_hours?.[wd];
      if (wh?.off) continue;
      for (let m = 0; m < 24 * 60 && slots.length < limit; m += step) {
        if (m < tFrom || m + sv.duration_min > tTo) continue;
        if (wh?.break && m < toMin(wh.break[1]) && m + sv.duration_min > toMin(wh.break[0])) continue;
        const start = localToUtc(day, toTime(m), ctx.timezone);
        if (start.getTime() < nowPlus) continue;
        const end = start.getTime() + sv.duration_min * 60000;
        for (const d of docs) {
          const open = Math.max(toMin(String(d.work_open).slice(0, 5)), wh?.open ? toMin(wh.open) : 0);
          const close = Math.min(toMin(String(d.work_close).slice(0, 5)), wh?.close ? toMin(wh.close) : 24 * 60);
          if (m < open || m + sv.duration_min > close) continue;
          const clash = (busy ?? []).some((b) => b.doctor_id === d.id && new Date(b.starts_at).getTime() < end &&
            new Date(b.starts_at).getTime() + b.duration_min * 60000 > start.getTime());
          if (!clash) { slots.push({ date: day, time: toTime(m), doctor_id: d.id, doctor_name: d.full_name, starts_at: start.toISOString() }); break; }
        }
      }
    }
    // Память диалога: какие слоты предложены — чтобы «давайте 17:30» связалось с конкретным врачом.
    await ctx.db.from("conversations").update({ agent_state: { offered_slots: slots, service_id: sv.id } }).eq("id", ctx.conversationId).eq("company_id", ctx.companyId);
    return { ok: true, data: { service: sv.name, duration_min: sv.duration_min, slots }, summary: `Получены свободные слоты: ${slots.length ? slots.map((s) => s.time).slice(0, 4).join(", ") : "нет"}` };
  },

  async create_appointment(ctx, a) {
    const pid = await ownPatient(ctx, a.patient_id);
    if (!pid) return fail("patient_not_found", "Создание записи: пациент не найден");
    const { data: sv } = await ctx.db.from("services").select("id, duration_min, ai_bookable").eq("company_id", ctx.companyId).eq("id", str(a.service_id)).maybeSingle();
    if (!sv) return fail("service_not_found", "Создание записи: услуга не найдена");
    if (!sv.ai_bookable) return fail("service_requires_admin", "Создание записи: услуга требует подтверждения администратора");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(a.date)) || !/^\d{2}:\d{2}$/.test(str(a.time))) return fail("bad_datetime", "Создание записи: неверные дата или время");
    const starts = localToUtc(str(a.date), str(a.time), ctx.timezone);
    const { data: id, error } = await ctx.db.rpc("crm_book_slot", {
      p_company: ctx.companyId, p_patient: pid, p_doctor: str(a.doctor_id), p_service: sv.id, p_starts: starts.toISOString(),
      p_duration: sv.duration_min, p_source: "whatsapp_ai", p_conversation: ctx.conversationId, p_actor_type: "ai", p_actor: null, p_comment: str(a.comment) || null,
    });
    if (error) return fail(error.message.includes("slot_taken") ? "slot_taken" : error.message, error.message.includes("slot_taken") ? "Слот уже занят — запись не создана" : "Создание записи: ошибка");
    return { ok: true, data: { appointment_id: id, date: str(a.date), time: str(a.time) }, entity: { type: "appointment", id }, summary: `Создана запись → ${str(a.date)} ${str(a.time)}` };
  },

  async update_appointment(ctx, a) {
    const id = str(a.appointment_id);
    const { data: ap } = await ctx.db.from("appointments").select("id, patient_id").eq("company_id", ctx.companyId).eq("id", id).maybeSingle();
    if (!ap) return fail("appointment_not_found", "Перенос записи: не найдена");
    if (ctx.patientId && ap.patient_id !== ctx.patientId) return fail("not_patient_appointment", "Перенос записи: запись другого пациента");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str(a.date)) || !/^\d{2}:\d{2}$/.test(str(a.time))) return fail("bad_datetime", "Перенос записи: неверные дата или время");
    const { error } = await ctx.db.rpc("crm_move_appointment", { p_company: ctx.companyId, p_appointment: id,
      p_starts: localToUtc(str(a.date), str(a.time), ctx.timezone).toISOString(), p_doctor: str(a.doctor_id) || null,
      p_actor_type: "ai", p_actor: null, p_conversation: ctx.conversationId });
    if (error) return fail(error.message.includes("slot_taken") ? "slot_taken" : error.message, "Перенос записи: " + (error.message.includes("slot_taken") ? "время занято" : "ошибка"));
    return { ok: true, data: { appointment_id: id, date: str(a.date), time: str(a.time) }, entity: { type: "appointment", id }, summary: `Запись перенесена → ${str(a.date)} ${str(a.time)}` };
  },

  async cancel_appointment(ctx, a) {
    const id = str(a.appointment_id);
    const { data: ap } = await ctx.db.from("appointments").select("id, patient_id, status, starts_at").eq("company_id", ctx.companyId).eq("id", id).maybeSingle();
    if (!ap) return fail("appointment_not_found", "Отмена записи: не найдена");
    if (ctx.patientId && ap.patient_id !== ctx.patientId) return fail("not_patient_appointment", "Отмена записи: запись другого пациента");
    if (["cancelled", "done", "no_show"].includes(ap.status)) return fail("appointment_closed", "Отмена записи: запись уже закрыта");
    const { error } = await ctx.db.from("appointments").update({ status: "cancelled", comment: str(a.reason) || "Отменено пациентом в WhatsApp", updated_at: new Date().toISOString() })
      .eq("company_id", ctx.companyId).eq("id", id);
    if (error) return fail(error.message, "Отмена записи: ошибка");
    await ctx.db.from("appointment_events").insert({ company_id: ctx.companyId, appointment_id: id, action: "cancelled", before: { status: ap.status },
      after: { status: "cancelled", reason: str(a.reason) || null }, actor_type: "ai", conversation_id: ctx.conversationId });
    return { ok: true, data: { appointment_id: id }, entity: { type: "appointment", id }, summary: "Запись отменена" };
  },

  async add_patient_note(ctx, a) {
    const pid = await ownPatient(ctx, a.patient_id);
    if (!pid || !str(a.text)) return fail("bad_request", "Заметка: нет пациента или текста");
    const kind = ["note", "complaint", "preference", "medical"].includes(str(a.kind)) ? str(a.kind) : "note";
    const { data, error } = await ctx.db.from("patient_notes").insert({ company_id: ctx.companyId, patient_id: pid, conversation_id: ctx.conversationId,
      text: str(a.text).slice(0, 2000), kind, source: "ai" }).select("id").single();
    if (error) return fail(error.message, "Заметка: ошибка");
    return { ok: true, data, entity: { type: "note", id: data.id }, summary: `Добавлена заметка: ${str(a.text).slice(0, 60)}` };
  },

  async create_task(ctx, a) {
    if (!str(a.title)) return fail("title_required", "Задача: нет заголовка");
    const { data, error } = await ctx.db.from("tasks").insert({ company_id: ctx.companyId, title: str(a.title).slice(0, 200), description: str(a.description) || null,
      due_at: str(a.due_at) || null, patient_id: ctx.patientId, conversation_id: ctx.conversationId, source: "ai" }).select("id").single();
    if (error) return fail(error.message, "Задача: ошибка");
    return { ok: true, data, entity: { type: "task", id: data.id }, summary: `Создана задача: ${str(a.title)}` };
  },

  async get_patient_appointments(ctx, a) {
    const pid = await ownPatient(ctx, a.patient_id);
    if (!pid) return { ok: true, data: [], summary: "Записей нет" };
    let q = ctx.db.from("appointments").select("id, starts_at, duration_min, status, service_id, doctor_id, services(name), doctors(full_name)")
      .eq("company_id", ctx.companyId).eq("patient_id", pid).order("starts_at");
    if (a.upcoming_only !== false) q = q.gte("starts_at", new Date().toISOString()).not("status", "in", "(cancelled,no_show,done)");
    const { data, error } = await q;
    if (error) return fail(error.message, "Записи пациента: ошибка");
    const list = await Promise.all((data ?? []).map((x) => apptView(ctx, x)));
    return { ok: true, data: list, summary: `Найдены записи пациента: ${list.length}` };
  },

  async get_conversation_history(ctx, a) {
    const { data } = await ctx.db.from("messages").select("direction, sender_type, text, created_at").eq("company_id", ctx.companyId)
      .eq("conversation_id", ctx.conversationId).neq("message_type", "event").order("created_at", { ascending: false }).limit(Math.min(Number(a.limit) || 20, 50));
    return { ok: true, data: (data ?? []).reverse(), summary: "Прочитана история диалога" };
  },

  async transfer_to_human(ctx, a) {
    const reason = str(a.reason) || "Робот передал диалог оператору";
    await ctx.db.from("conversations").update({ ai_enabled: false, status: "needs_operator", handoff_reason: reason, updated_at: new Date().toISOString() })
      .eq("company_id", ctx.companyId).eq("id", ctx.conversationId);
    await ctx.db.from("messages").insert({ company_id: ctx.companyId, conversation_id: ctx.conversationId, patient_id: ctx.patientId,
      direction: "outgoing", sender_type: "system", message_type: "event", text: `Диалог передан оператору: ${reason}`, status: "sent" });
    await ctx.db.from("tasks").insert({ company_id: ctx.companyId, title: "Ответить пациенту в WhatsApp", description: reason, patient_id: ctx.patientId,
      conversation_id: ctx.conversationId, source: "ai" });
    return { ok: true, data: { handed_off: true }, entity: { type: "conversation", id: ctx.conversationId }, summary: `Передано оператору: ${reason}` };
  },
};

// ---------- схемы для модели ----------
const S = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const T = { type: "string" }, D = { type: "string", description: "YYYY-MM-DD, местная дата клиники" }, H = { type: "string", description: "HH:MM, местное время клиники" };

export const TOOL_SCHEMAS = [
  { name: "find_patient", description: "Найти пациента компании по телефону или имени", parameters: S({ phone: T, name: T }) },
  { name: "create_patient", description: "Создать пациента (если номер уже есть — вернуть существующего)", parameters: S({ phone: T, full_name: T }, ["phone"]) },
  { name: "update_patient", description: "Обновить данные текущего пациента: имя, email, дату рождения", parameters: S({ patient_id: T, full_name: T, email: T, birth_date: D }) },
  { name: "get_patient", description: "Карточка пациента и последние заметки", parameters: S({ patient_id: T }) },
  { name: "get_services", description: "Список услуг клиники с ценой и длительностью", parameters: S({ query: T }) },
  { name: "get_doctors", description: "Врачи клиники, при необходимости — для услуги", parameters: S({ service_id: T }) },
  { name: "get_available_slots", description: "Свободное время для услуги. Используй перед любым предложением времени", parameters: S({ service_id: T, date_from: D, date_to: D, time_from: H, time_to: H, doctor_id: T, limit: { type: "integer" } }, ["service_id"]) },
  { name: "create_appointment", description: "Создать запись. Только после явного согласия пациента на конкретное время из get_available_slots", parameters: S({ service_id: T, doctor_id: T, date: D, time: H, patient_id: T, comment: T }, ["service_id", "doctor_id", "date", "time"]) },
  { name: "update_appointment", description: "Перенести запись пациента на новое время (проверь слот через get_available_slots)", parameters: S({ appointment_id: T, date: D, time: H, doctor_id: T }, ["appointment_id", "date", "time"]) },
  { name: "cancel_appointment", description: "Отменить запись пациента", parameters: S({ appointment_id: T, reason: T }, ["appointment_id"]) },
  { name: "add_patient_note", description: "Сохранить важную информацию о пациенте (жалоба, пожелание)", parameters: S({ text: T, kind: { type: "string", enum: ["note", "complaint", "preference", "medical"] }, patient_id: T }, ["text"]) },
  { name: "create_task", description: "Создать задачу персоналу", parameters: S({ title: T, description: T, due_at: T }, ["title"]) },
  { name: "get_patient_appointments", description: "Записи текущего пациента", parameters: S({ upcoming_only: { type: "boolean" }, patient_id: T }) },
  { name: "get_conversation_history", description: "Последние сообщения этого диалога", parameters: S({ limit: { type: "integer" } }) },
  { name: "transfer_to_human", description: "Передать диалог живому оператору и выключить робота в этом чате", parameters: S({ reason: T }, ["reason"]) },
];

/** Выполнить инструмент и записать действие в ai_actions. */
export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const h = handlers[name];
  const started = performance.now();
  let out: ToolOutcome;
  try {
    out = h ? await h(ctx, args ?? {}) : fail("unknown_tool", `Неизвестный инструмент ${name}`);
  } catch (e) {
    out = fail(e instanceof Error ? e.message : String(e), `${name}: исключение`);
  }
  await ctx.db.from("ai_actions").insert({
    company_id: ctx.companyId, conversation_id: ctx.conversationId, trigger_message_id: ctx.triggerMessageId,
    tool: name, args, result: out.ok ? { data: out.data ?? null, summary: out.summary } : { error: out.error, summary: out.summary },
    status: out.ok ? "ok" : "error", entity_type: out.entity?.type ?? null, entity_id: out.entity?.id ?? null,
    duration_ms: Math.round(performance.now() - started),
  });
  return out;
}
