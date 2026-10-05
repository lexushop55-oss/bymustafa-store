// Связка CRM ↔ существующий робот-администратор.
// Робот не пишет в базу сам: он возвращает вызовы инструментов, CRM их
// выполняет (tools.ts) и отдаёт результат обратно, пока робот не вернёт текст.
//
// Протокол выбирается переменной AI_AGENT_PROTOCOL:
//   "dentaline" (по умолчанию) — свой агент за HTTP:
//      POST AI_AGENT_URL  { company, conversation, patient, messages, tools }
//      ← { "tool_calls": [{ "id", "name", "arguments": {…} }] }  или  { "reply": "текст", "handoff": false }
//   "openai" — любой совместимый chat/completions с tools (AI_AGENT_URL = base URL, AI_AGENT_MODEL).
// Ключ агента — AI_AGENT_TOKEN (секрет функции, в браузер не попадает).

import { fetchWithTimeout } from "../http.ts";
import { type AiSettings, runTool, TOOL_SCHEMAS, type ToolContext, utcToLocal } from "../crm/tools.ts";

const MAX_STEPS = 8;
const TIMEOUT = () => Number(Deno.env.get("AI_AGENT_TIMEOUT_MS") ?? 25000);

type Msg =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: unknown[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export interface AgentRunResult {
  reply: string | null;
  handedOff: boolean;
  error: string | null;
  steps: number;
}

// Обязательные правила записи. Добавляются ВСЕГДА, даже если у компании свой system_prompt:
// свой текст клиники может менять тон и детали, но не порядок записи.
const BOOKING_PROTOCOL = `Порядок записи (строго):
1. Пойми запрос и определи услугу. Список услуг бери только из get_services. Если подходящей услуги нет — скажи об этом и предложи консультацию или администратора.
2. Узнай имя пациента. Телефон по умолчанию — номер WhatsApp, с которого он пишет; уточни, записывать ли на него.
3. Узнай желаемую дату и удобное время.
4. Вызови check_free_slots. Называй пациенту ТОЛЬКО окна из ответа инструмента (2–3 варианта). Если окон нет — предложи другой день.
5. Когда пациент выбрал окно — вызови propose_appointment, затем одним сообщением перечисли услугу, дату, время, врача, имя и телефон и спроси: «Подтверждаете запись?».
6. Только после ответа пациента «да» следующим сообщением вызови create_appointment с confirmed=true.
7. Фразу «Вы записаны» пиши только если create_appointment вернул ok=true, и укажи номер записи из ответа. Если инструмент вернул ошибку — запись НЕ создана: объясни и предложи другое время.
Запрещено придумывать услуги, цены, врачей, свободное время и факт записи. Не ставь диагнозы.`;

function systemPrompt(ctx: ToolContext, companyName: string): string {
  const s = ctx.settings, now = utcToLocal(new Date(), ctx.timezone);
  return [
    s.system_prompt || `Ты администратор стоматологической клиники «${s.business_name || companyName}» в WhatsApp. Отвечай кратко, вежливо и профессионально: 1–3 предложения, без эмодзи и лишних любезностей.`,
    s.business_description ? `О клинике: ${s.business_description}` : "",
    s.booking_rules ? `Правила записи клиники: ${s.booking_rules}` : "",
    `Язык ответа: ${s.language}. Тон: ${s.tone}.`,
    `Сейчас ${now.date} ${now.time}, день недели ${now.weekday} (${ctx.timezone}). Даты передавай в инструменты как YYYY-MM-DD, время как HH:MM.`,
    BOOKING_PROTOCOL,
    "Если вопрос медицинский (острая боль, отёк, кровотечение, жалоба на лечение) или пациент просит человека — вызови transfer_to_human.",
  ].filter(Boolean).join("\n\n");
}

const BOOKED_CLAIM = /(вы\s+записан|записал[аи]?\s+вас|запись\s+(создана|оформлена|подтверждена)|you\s+are\s+booked)/i;

async function callAgent(messages: Msg[], ctx: ToolContext, meta: Record<string, unknown>) {
  const url = Deno.env.get("AI_AGENT_URL"), token = Deno.env.get("AI_AGENT_TOKEN") ?? "";
  if (!url) throw new Error("AI_AGENT_URL не задан");
  const protocol = Deno.env.get("AI_AGENT_PROTOCOL") ?? "dentaline";
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };

  if (protocol === "openai") {
    const res = await fetchWithTimeout(`${url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model: Deno.env.get("AI_AGENT_MODEL"), messages,
        tools: TOOL_SCHEMAS.map((t) => ({ type: "function", function: t })), tool_choice: "auto" }),
    }, TIMEOUT());
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message ?? `Агент: HTTP ${res.status}`);
    const m = body?.choices?.[0]?.message ?? {};
    const parse = (s: string) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
    return {
      raw: { role: "assistant", content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
      toolCalls: (m.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: string } }) => ({
        id: c.id, name: c.function.name, arguments: parse(c.function.arguments) })),
      reply: m.content ?? null, handoff: false,
    };
  }

  const res = await fetchWithTimeout(url, { method: "POST", headers,
    body: JSON.stringify({ ...meta, messages, tools: TOOL_SCHEMAS }) }, TIMEOUT());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `Агент: HTTP ${res.status}`);
  return { raw: { role: "assistant", content: body.reply ?? "", tool_calls: body.tool_calls ?? [] },
    toolCalls: body.tool_calls ?? [], reply: body.reply ?? null, handoff: !!body.handoff };
}

/** Один проход робота по входящему сообщению. Ошибки не роняют диалог — их обрабатывает вызывающий. */
export async function runAgent(ctx: ToolContext, companyName: string): Promise<AgentRunResult> {
  const { data: hist } = await ctx.db.from("messages").select("direction, sender_type, text, message_type")
    .eq("company_id", ctx.companyId).eq("conversation_id", ctx.conversationId).neq("message_type", "event")
    .order("created_at", { ascending: false }).limit(30);
  const { data: conv } = await ctx.db.from("conversations").select("agent_state, contact_name").eq("id", ctx.conversationId).single();

  const messages: Msg[] = [{ role: "system", content: systemPrompt(ctx, companyName) }];
  if (conv?.agent_state && Object.keys(conv.agent_state).length) {
    messages.push({ role: "system", content: `Состояние диалога: ${JSON.stringify(conv.agent_state)}` });
  }
  for (const m of (hist ?? []).reverse()) {
    messages.push({ role: m.direction === "incoming" ? "user" : "assistant", content: m.text ?? `[${m.message_type}]` });
  }
  const meta = { company: { id: ctx.companyId, name: companyName, timezone: ctx.timezone, settings: ctx.settings },
    conversation: { id: ctx.conversationId }, patient: { id: ctx.patientId, name: conv?.contact_name ?? null } };

  let handedOff = false, booked = false;
  for (let step = 1; step <= MAX_STEPS; step++) {
    const r = await callAgent(messages, ctx, meta);
    if (!r.toolCalls.length) {
      return { reply: await guardReply(ctx, r.reply?.trim() || null, booked), handedOff: handedOff || r.handoff, error: null, steps: step };
    }
    messages.push(r.raw as Msg);
    for (const call of r.toolCalls) {
      const out = await runTool(ctx, call.name, call.arguments ?? {});
      if (call.name === "transfer_to_human" && out.ok) handedOff = true;
      if (call.name === "create_appointment" && out.ok) booked = true;
      messages.push({ role: "tool", tool_call_id: call.id, name: call.name,
        content: JSON.stringify(out.ok ? { ok: true, data: out.data } : { ok: false, error: out.error }) });
    }
  }
  return { reply: null, handedOff, error: `Робот не завершил ответ за ${MAX_STEPS} шагов`, steps: MAX_STEPS };
}

/** Модель сказала «вы записаны», а запись в этом проходе не создана и запись в процессе оформления —
 *  такой ответ не отправляем: пациент получает просьбу подтвердить или выбрать окно. */
async function guardReply(ctx: ToolContext, reply: string | null, booked: boolean): Promise<string | null> {
  if (!reply || booked || !BOOKED_CLAIM.test(reply)) return reply;
  const { data } = await ctx.db.from("conversations").select("agent_state").eq("id", ctx.conversationId).single();
  const st = (data?.agent_state ?? {}) as { pending_booking?: Record<string, string> | null; offered_slots?: unknown[] };
  const p = st.pending_booking;
  if (p) {
    console.warn("[agent] blocked false booking claim", ctx.conversationId);
    return `Пожалуйста, подтвердите запись: ${p.service_name}, ${p.date} в ${p.time}, врач ${p.doctor_name}, на имя ${p.patient_name}. Ответьте «Да» или «Нет».`;
  }
  if (st.offered_slots?.length) {
    console.warn("[agent] blocked false booking claim", ctx.conversationId);
    return "Уточните, пожалуйста, какое из предложенных окон вам подходит — после этого я попрошу подтвердить запись.";
  }
  return reply;
}

export async function loadAiSettings(db: ToolContext["db"], companyId: string): Promise<AiSettings> {
  const { data } = await db.from("ai_settings").select("*").eq("company_id", companyId).maybeSingle();
  return {
    ai_enabled: !!data?.ai_enabled, system_prompt: data?.system_prompt ?? null, business_name: data?.business_name ?? null,
    business_description: data?.business_description ?? null, working_hours: data?.working_hours ?? {},
    booking_rules: data?.booking_rules ?? null, language: data?.language ?? "ru", tone: data?.tone ?? "friendly",
    human_handoff_rules: data?.human_handoff_rules ?? { keywords: [], on_ai_error: true },
    slot_step_min: data?.slot_step_min ?? 30, booking_horizon_days: data?.booking_horizon_days ?? 14,
  };
}
