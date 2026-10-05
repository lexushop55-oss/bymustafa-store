// Сквозные тесты канала WhatsApp на развёрнутом проекте (сервер разработки).
// Требования: миграции применены; функции whatsapp, whatsapp-webhook, dev-agent-stub задеплоены;
// у функций WHATSAPP_ALLOW_MOCK=true, AI_AGENT_URL=<dev-agent-stub>; у компаний A и B есть услуга
// «Профессиональная чистка» и врач; ai_settings.ai_enabled=true.
//
//   SUPABASE_URL=… SUPABASE_ANON_KEY=… A_EMAIL=… A_PASSWORD=… B_EMAIL=… B_PASSWORD=… \
//   deno test -A backend/supabase/tests/whatsapp_e2e.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const FN = `${URL_}/functions/v1/whatsapp`;

async function login(email: string, password: string) {
  const sb = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(FN + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${data.session!.access_token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return await r.json();
  };
  return { sb, call };
}

const A = await login(Deno.env.get("A_EMAIL")!, Deno.env.get("A_PASSWORD")!);
const B = await login(Deno.env.get("B_EMAIL")!, Deno.env.get("B_PASSWORD")!);
const PHONE = "7999" + String(Date.now()).slice(-7);
const inbound = (c: typeof A, text: string, id?: string) => c.call("/dev/inbound", { from: PHONE, name: "Ахмед", text, id });
const lastOut = async (c: typeof A, convId: string) =>
  (await c.sb.from("messages").select("text, status, sender_type").eq("conversation_id", convId).eq("direction", "outgoing").neq("message_type", "event")
    .order("created_at", { ascending: false }).limit(1).single()).data!;

await A.call("/connect", { provider: "mock", phoneNumberId: "+7 900 000 0001", displayName: "Клиника A" });
await B.call("/connect", { provider: "mock", phoneNumberId: "+7 900 000 0002", displayName: "Клиника B" });
let conv = "";

Deno.test("TEST 1 · входящее → CRM → пациент → ответ робота", async () => {
  const r = await inbound(A, "Здравствуйте");
  assert(r.success); conv = r.result.conversationId;
  assert(r.result.patientId); assertEquals(r.result.ai, "replied");
  const out = await lastOut(A, conv);
  assertEquals(out.sender_type, "ai"); assertEquals(out.status, "sent");
});

Deno.test("TEST 2 · запись через слоты", async () => {
  const r1 = await inbound(A, "Хочу записаться завтра на чистку после 16:00");
  assertEquals(r1.result.ai, "replied");
  const offer = await lastOut(A, conv);
  const time = offer.text.match(/\d{2}:\d{2}/)![0];
  const r2 = await inbound(A, time);
  assertEquals(r2.result.ai, "replied");
  const { data: appts } = await A.sb.from("appointments").select("id, source").eq("conversation_id", conv);
  assertEquals(appts!.length, 1); assertEquals(appts![0].source, "whatsapp_ai");
  const { data: acts } = await A.sb.from("ai_actions").select("tool, status").eq("conversation_id", conv);
  for (const t of ["get_services", "get_available_slots", "create_appointment", "send_whatsapp_message"]) assert(acts!.some((a) => a.tool === t && a.status === "ok"), t);
});

Deno.test("TEST 3 · перенос записи", async () => {
  const { data: before } = await A.sb.from("appointments").select("id, starts_at").eq("conversation_id", conv).single();
  const r = await inbound(A, "Перенесите запись на послезавтра");
  assertEquals(r.result.ai, "replied");
  const { data: after } = await A.sb.from("appointments").select("starts_at").eq("id", before!.id).single();
  assert(after!.starts_at !== before!.starts_at);
  const { data: hist } = await A.sb.from("appointment_events").select("action").eq("appointment_id", before!.id);
  assert(hist!.some((h) => h.action === "rescheduled"));
});

Deno.test("TEST 4 · оператор вмешивается и возвращает робота", async () => {
  assert((await A.call(`/conversations/${conv}/handoff`, { reason: "тест" })).success);
  const r = await inbound(A, "Можно вопрос?");
  assertEquals(r.result.ai, "operator");
  const rep = await A.call(`/conversations/${conv}/reply`, { text: "Здравствуйте, это администратор", clientRef: "t4-" + PHONE });
  assert(rep.success); assertEquals(rep.message.status, "sent");
  const again = await A.call(`/conversations/${conv}/reply`, { text: "Здравствуйте, это администратор", clientRef: "t4-" + PHONE });
  assert(again.message.duplicate);
  assert((await A.call(`/conversations/${conv}/resume`, {})).success);
  assertEquals((await inbound(A, "Спасибо")).result.ai, "replied");
});

Deno.test("TEST 5 · изоляция компаний", async () => {
  const { data: bConvs } = await B.sb.from("conversations").select("id").eq("id", conv);
  assertEquals(bConvs!.length, 0);
  const { data: bMsgs } = await B.sb.from("messages").select("id").eq("conversation_id", conv);
  assertEquals(bMsgs!.length, 0);
  const steal = await B.call(`/conversations/${conv}/reply`, { text: "x" });
  assertEquals(steal.code, "not_found");
  const { error } = await A.sb.from("messages").insert({ company_id: "00000000-0000-0000-0000-000000000000", conversation_id: conv, direction: "outgoing", sender_type: "employee", text: "x" });
  assert(error);
});

Deno.test("TEST 6 · повторный вебхук не дублирует", async () => {
  const id = "dup-" + PHONE;
  const r1 = await inbound(A, "Отмените мою запись", id);
  const r2 = await inbound(A, "Отмените мою запись", id);
  assertEquals(r1.result.duplicate, false); assertEquals(r2.result.duplicate, true);
  const { count } = await A.sb.from("messages").select("id", { count: "exact", head: true }).eq("external_message_id", id);
  assertEquals(count, 1);
  const { data: cancels } = await A.sb.from("appointment_events").select("id").eq("conversation_id", conv).eq("action", "cancelled");
  assertEquals(cancels!.length, 1);
});
