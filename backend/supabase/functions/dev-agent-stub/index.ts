// ТОЛЬКО для разработки и тестов: заглушка агента по протоколу "dentaline".
// Показывает контракт, который должен реализовать существующий робот-администратор:
//   вход  { company, conversation, patient, messages:[{role,content}|{role:'tool',name,content}], tools }
//   выход { tool_calls:[{id,name,arguments}] }  или  { reply }
// Логика — правила на регулярных выражениях, без модели. Деплой на прод не нужен.
// Деплой для тестов: supabase functions deploy dev-agent-stub --no-verify-jwt; AI_AGENT_URL=<url функции>

type M = { role: string; content: string; name?: string };
const RU_DOW: Record<string, number> = { "понедельник": 1, "вторник": 2, "сред": 3, "четверг": 4, "пятниц": 5, "суббот": 6, "воскресен": 0 };

function targetDate(text: string, today: string): string {
  const d = new Date(today + "T00:00:00Z");
  if (/послезавтра/.test(text)) d.setUTCDate(d.getUTCDate() + 2);
  else if (/завтра/.test(text)) d.setUTCDate(d.getUTCDate() + 1);
  else for (const [k, n] of Object.entries(RU_DOW)) if (text.includes(k)) { do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== n); break; }
  return d.toISOString().slice(0, 10);
}
const call = (name: string, args: Record<string, unknown>) => ({ tool_calls: [{ id: crypto.randomUUID(), name, arguments: args }] });

Deno.serve(async (req) => {
  const { messages, company } = await req.json() as { messages: M[]; company: { timezone: string } };
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";
  const lastIdx = messages.map((m) => m.role).lastIndexOf("user");
  const tools = messages.slice(lastIdx + 1).filter((m) => m.role === "tool").map((m) => ({ name: m.name!, out: JSON.parse(m.content) }));
  const got = (n: string) => tools.find((t) => t.name === n)?.out;
  const state = messages.find((m) => m.role === "system" && m.content.startsWith("Состояние диалога:"));
  const offered = state ? JSON.parse(state.content.replace("Состояние диалога: ", "")).offered_slots ?? [] : [];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: company.timezone }).format(new Date());

  // Выбор времени из ранее предложенных.
  const tm = lastUser.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (tm && offered.length && !/перен/.test(lastUser)) {
    const t = `${tm[1].padStart(2, "0")}:${tm[2]}`, slot = offered.find((s: { time: string }) => s.time === t);
    const svc = state ? JSON.parse(state.content.replace("Состояние диалога: ", "")).service_id : null;
    if (slot && !got("create_appointment")) return Response.json(call("create_appointment", { service_id: svc, doctor_id: slot.doctor_id, date: slot.date, time: slot.time }));
    const r = got("create_appointment");
    if (r?.ok) return Response.json({ reply: `Записала вас на ${r.data.date} в ${r.data.time}.` });
    if (r) return Response.json({ reply: "Это время только что заняли. Подобрать другое?" });
  }
  if (/отмен/.test(lastUser)) {
    const ap = got("get_patient_appointments");
    if (!ap) return Response.json(call("get_patient_appointments", {}));
    if (!ap.data?.length) return Response.json({ reply: "Не нашла у вас активных записей." });
    if (!got("cancel_appointment")) return Response.json(call("cancel_appointment", { appointment_id: ap.data[0].id, reason: "Пациент отменил в WhatsApp" }));
    return Response.json({ reply: `Отменила запись на ${ap.data[0].date} ${ap.data[0].time}.` });
  }
  if (/перен/.test(lastUser)) {
    const ap = got("get_patient_appointments");
    if (!ap) return Response.json(call("get_patient_appointments", {}));
    if (!ap.data?.length) return Response.json({ reply: "Не нашла у вас активных записей." });
    const date = targetDate(lastUser, today), time = tm ? `${tm[1].padStart(2, "0")}:${tm[2]}` : null;
    const sl = got("get_available_slots");
    if (!sl) return Response.json(call("get_available_slots", { service_id: ap.data[0].service_id, date_from: date, ...(time ? { time_from: time } : {}) }));
    const exact = time ? sl.data.slots.find((s: { time: string }) => s.time === time) : sl.data.slots[0];
    if (!exact) return Response.json({ reply: `На это время мест нет. Есть: ${sl.data.slots.map((s: { time: string }) => s.time).join(", ") || "—"}.` });
    if (!got("update_appointment")) return Response.json(call("update_appointment", { appointment_id: ap.data[0].id, date: exact.date, time: exact.time, doctor_id: exact.doctor_id }));
    return Response.json({ reply: `Перенесла запись на ${exact.date} в ${exact.time}.` });
  }
  if (/запис|чистк|консульт|кариес/.test(lastUser)) {
    const sv = got("get_services");
    if (!sv) return Response.json(call("get_services", {}));
    const s = sv.data.find((x: { name: string }) => /чистк/.test(lastUser) ? /чистк/i.test(x.name) : /кариес/.test(lastUser) ? /кариес/i.test(x.name) : /консульт/i.test(x.name)) ?? sv.data[0];
    const after = lastUser.match(/после\s+(\d{1,2})/);
    const sl = got("get_available_slots");
    if (!sl) return Response.json(call("get_available_slots", { service_id: s.id, date_from: targetDate(lastUser, today), ...(after ? { time_from: `${after[1].padStart(2, "0")}:00` } : {}), limit: 2 }));
    if (!sl.data.slots.length) return Response.json({ reply: "На этот день свободного времени нет. Посмотреть другой день?" });
    return Response.json({ reply: `Есть ${sl.data.slots.map((x: { time: string }) => x.time).join(" и ")}. Какое время вам удобнее?` });
  }
  const name = lastUser.match(/меня зовут\s+([а-яёa-z-]+)/i);
  if (name && !got("update_patient")) return Response.json(call("update_patient", { full_name: name[1][0].toUpperCase() + name[1].slice(1) }));
  if (/болит|боль|опух/.test(lastUser) && !got("add_patient_note")) return Response.json(call("add_patient_note", { text: lastUser, kind: "complaint" }));
  return Response.json({ reply: "Здравствуйте! Чем могу помочь? Могу записать на приём, перенести или отменить запись." });
});
