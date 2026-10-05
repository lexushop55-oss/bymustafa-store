// DentaData — слой данных CRM в режиме supabase.
// Пациенты, записи, врачи и услуги живут ТОЛЬКО в таблицах patients / appointments /
// doctors / services (тех же, что читает и пишет робот WhatsApp через tools.ts).
// В workspace_state и localStorage эти коллекции не сохраняются.
//
// Идентификаторы: в таблице id — uuid, crm_ref — ключ, которым пользуется интерфейс
// ('c1', 's1', 'd1', номер записи 1032). Строки, созданные роботом, получают crm_ref
// в триггере (uuid для пациентов, следующий номер для записей). Поля интерфейса без
// своей колонки (план лечения, оплаты, кресло, история) лежат в колонке crm jsonb
// той же строки — второй копии данных нет.
//
// Запись: persist() CRM → commit(next) — сравнение с последним известным состоянием
// базы, upsert изменённых строк и delete удалённых. Чтение: load() и Realtime-подписка
// на изменения компании (в том числе от робота) → onData(свежие коллекции).
(function () {
  if (window.DentaData) return;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TABLES = ['doctors', 'services', 'patients', 'appointments'];      // порядок upsert (родители раньше)
  const SLICE = { doctors: 'doctors', services: 'services', patients: 'clients', appointments: 'appointments' };
  const ST_TO_DB = { new: 'scheduled', confirmed: 'confirmed', arrived: 'arrived', in_progress: 'in_chair', completed: 'done', cancelled: 'cancelled', no_show: 'no_show' };
  const ST_FROM_DB = { scheduled: 'new', confirmed: 'confirmed', arrived: 'arrived', in_chair: 'in_progress', done: 'completed', cancelled: 'cancelled', no_show: 'no_show' };
  const SRC_FROM_DB = (s) => (!s ? 'admin' : (s === 'whatsapp_ai' || s === 'ai' || s === 'whatsapp') ? 'bot' : s);
  const KNOWN = {
    doctors: ['id', 'name', 'role', 'open', 'close', 'active'],
    services: ['id', 'name', 'price', 'duration', 'active', 'category', 'doctorIds'],
    patients: ['id', 'name', 'phone', 'email'],
    appointments: ['id', 'clientId', 'serviceId', 'doctorId', 'date', 'time', 'status', 'source', 'comment', 'conversationId']
  };
  const PAGE = 1000;

  let S = null; // состояние текущей компании
  const fresh = (companyId) => ({
    companyId, tz: 'Europe/Moscow', ready: false, ver: 0, chain: Promise.resolve(), channel: null, timer: null,
    ref2id: { doctors: new Map(), services: new Map(), patients: new Map(), appointments: new Map() },
    id2ref: { doctors: new Map(), services: new Map(), patients: new Map(), appointments: new Map() },
    snap: { doctors: new Map(), services: new Map(), patients: new Map(), appointments: new Map() },
    opts: {}
  });

  // ---------- время: дата/время клиники ⇄ UTC (как localToUtc/utcToLocal в tools.ts) ----------
  function parts(ms, tz) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const o = {}; f.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; }); return o;
  }
  function toLocal(iso, tz) { const o = parts(Date.parse(iso), tz); return { date: o.year + '-' + o.month + '-' + o.day, time: o.hour + ':' + o.minute }; }
  function toUtc(date, time, tz) {
    const [y, m, d] = date.split('-').map(Number), [h, mi] = String(time || '00:00').split(':').map(Number);
    const want = Date.UTC(y, m - 1, d, h || 0, mi || 0); let ms = want;
    for (let i = 0; i < 3; i++) { const o = parts(ms, tz); ms += want - Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute); }
    return new Date(ms).toISOString();
  }
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const isTime = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));
  const hhmm = (t) => String(t || '').slice(0, 5);
  const uuid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const omit = (o, keys) => { const r = {}; Object.keys(o || {}).forEach((k) => { if (keys.indexOf(k) < 0 && o[k] !== undefined) r[k] = o[k]; }); return r; };

  // ---------- ключи ----------
  function bind(t, ref, id) { S.ref2id[t].set(ref, id); S.id2ref[t].set(id, ref); }
  function idFor(t, ref) {                       // своя строка: uuid известен или выдаётся новый
    const k = String(ref); let id = S.ref2id[t].get(k);
    if (!id) { id = UUID_RE.test(k) ? k : uuid(); bind(t, k, id); }
    return id;
  }
  const fk = (t, ref) => (ref == null || ref === '') ? null : (S.ref2id[t].get(String(ref)) || null); // ссылка: только существующие
  const refVal = (t, ref) => (t === 'appointments' && /^\d{1,15}$/.test(ref)) ? Number(ref) : ref;
  function refOf(t, id) { if (!S || !id) return null; const r = S.id2ref[t] && S.id2ref[t].get(id); return r == null ? null : refVal(t, r); }

  // ---------- CRM ⇄ строка таблицы ----------
  function toRow(t, o, ctx) {
    if (!o || o.id == null || o.id === '') return null;
    const base = { id: idFor(t, o.id), company_id: S.companyId, crm_ref: String(o.id), crm: omit(o, KNOWN[t]) };
    if (t === 'doctors') return Object.assign(base, { full_name: String(o.name || 'Врач').slice(0, 120), specialty: o.role || null,
      work_open: isTime(o.open) ? o.open : '09:00', work_close: isTime(o.close) ? o.close : '20:00', is_active: o.active !== false });
    if (t === 'services') return Object.assign(base, { name: String(o.name || 'Услуга').slice(0, 200), category: o.category || null,
      price: Number(o.price) || 0, duration_min: Math.max(5, Number(o.duration) || 30), is_active: o.active !== false,
      ai_bookable: S.opts.aiBookable ? !!S.opts.aiBookable(o) : o.aiBooking === 'auto',
      doctor_ids: (o.doctorIds || []).map((r) => fk('doctors', r)).filter(Boolean) });
    if (t === 'patients') return Object.assign(base, { full_name: String(o.name || o.phone || 'Пациент').slice(0, 120),
      phone: o.phone || null, email: o.email || null, birth_date: isDate(o.birth) ? o.birth : null });
    if (t === 'appointments') {
      if (!isDate(o.date) || !isTime(o.time)) return null;
      const sv = ctx.svc[String(o.serviceId)];
      return Object.assign(base, { patient_id: fk('patients', o.clientId), doctor_id: fk('doctors', o.doctorId), service_id: fk('services', o.serviceId),
        starts_at: toUtc(o.date, o.time, S.tz), duration_min: Math.max(5, Number(o.duration) || (sv && Number(sv.duration)) || 30),
        status: ST_TO_DB[o.status] || 'scheduled', price: o.payment && o.payment.cost != null ? Number(o.payment.cost) || 0 : (sv ? Number(sv.price) || 0 : null),
        comment: o.comment || null, source: o.source || 'admin', conversation_id: UUID_RE.test(String(o.conversationId || '')) ? o.conversationId : null });
    }
    return null;
  }
  function fromRow(t, r) {
    const c = r.crm || {}, ref = refVal(t, r.crm_ref || r.id);
    if (t === 'doctors') { const d = Object.assign({}, c, { id: ref, name: r.full_name, role: r.specialty || '', open: hhmm(r.work_open) || '09:00', close: hhmm(r.work_close) || '20:00' }); if (!r.is_active) d.active = false; return d; }
    if (t === 'services') {
      const s = Object.assign({}, c, { id: ref, name: r.name, price: Number(r.price) || 0, duration: r.duration_min, active: r.is_active !== false,
        aiBooking: c.aiBooking || (r.ai_bookable ? 'auto' : 'consult') });
      if (r.category) s.category = r.category;
      const docs = (r.doctor_ids || []).map((id) => refOf('doctors', id)).filter((x) => x != null);
      if (docs.length) s.doctorIds = docs;
      return s;
    }
    if (t === 'patients') {
      const p = Object.assign({ telegram: '—', notes: [], plan: [] }, c, { id: ref, name: r.full_name, phone: r.phone || '',
        birth: r.birth_date || c.birth || '', added: c.added || String(r.created_at || '').slice(0, 10) });
      if (r.email) p.email = r.email;
      if (!c.source && r.source) p.source = r.source;
      return p;
    }
    const l = toLocal(r.starts_at, S.tz);
    return Object.assign({}, c, { id: ref, clientId: refOf('patients', r.patient_id), serviceId: refOf('services', r.service_id), doctorId: refOf('doctors', r.doctor_id),
      date: l.date, time: l.time, status: ST_FROM_DB[r.status] || 'new', source: SRC_FROM_DB(r.source), comment: r.comment || '',
      createdAt: c.createdAt || String(r.created_at || '').slice(0, 10), conversationId: r.conversation_id || c.conversationId || null,
      payment: c.payment || { cost: Number(r.price) || 0, history: [] } });
  }
  const ctxOf = (data) => { const svc = {}; (data.services || []).forEach((s) => { svc[String(s.id)] = s; }); return { svc }; };
  function snapshot(data) {
    const ctx = ctxOf(data);
    TABLES.forEach((t) => { S.snap[t] = new Map(); (data[SLICE[t]] || []).forEach((o) => { const row = toRow(t, o, ctx); if (row) S.snap[t].set(row.crm_ref, JSON.stringify(row)); }); });
  }

  // ---------- чтение ----------
  async function fetchAll(sb, t, order) {
    const out = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(t).select('*').eq('company_id', S.companyId).order(order).order('id').range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) return out;
    }
  }
  async function readAll() {
    const sb = await window.DentaAuth.client();
    const { data: ten } = await sb.from('tenants').select('timezone').eq('id', S.companyId).maybeSingle();
    if (ten && ten.timezone) S.tz = ten.timezone;
    const rows = {};
    rows.doctors = await fetchAll(sb, 'doctors', 'created_at');
    rows.services = await fetchAll(sb, 'services', 'created_at');
    rows.patients = await fetchAll(sb, 'patients', 'created_at');
    rows.appointments = await fetchAll(sb, 'appointments', 'starts_at');
    TABLES.forEach((t) => { S.ref2id[t] = new Map(); S.id2ref[t] = new Map(); rows[t].forEach((r) => bind(t, String(r.crm_ref || r.id), r.id)); });
    let data = {};
    TABLES.forEach((t) => { data[SLICE[t]] = rows[t].map((r) => fromRow(t, r)); });
    // Нормализация интерфейса (например, normalizePay) — до снимка, иначе первый же
    // persist() принял бы её за правку и переписал бы все строки.
    if (S.opts.normalize) data = S.opts.normalize(data);
    snapshot(data);
    S.ready = true;
    return data;
  }

  // ---------- запись ----------
  async function doCommit(next) {
    if (!S || !S.ready) return;
    const sb = await window.DentaAuth.client(), ctx = ctxOf(next), ups = {}, dels = {};
    TABLES.forEach((t) => {
      const seen = new Set(); ups[t] = [];
      (next[SLICE[t]] || []).forEach((o) => {
        const row = toRow(t, o, ctx); if (!row || seen.has(row.crm_ref)) return;
        seen.add(row.crm_ref);
        const j = JSON.stringify(row);
        if (S.snap[t].get(row.crm_ref) !== j) ups[t].push({ row, j });
      });
      dels[t] = Array.from(S.snap[t].keys()).filter((k) => !seen.has(k));
    });
    let failed = null;
    for (const t of TABLES) {
      for (let i = 0; i < ups[t].length; i += 500) {
        const chunk = ups[t].slice(i, i + 500);
        const { error } = await sb.from(t).upsert(chunk.map((x) => x.row), { onConflict: 'id' });
        if (error) { failed = failed || { t, error }; break; }
        chunk.forEach((x) => S.snap[t].set(x.row.crm_ref, x.j));
      }
    }
    for (const t of TABLES.slice().reverse()) {
      const ids = dels[t].map((k) => S.ref2id[t].get(k)).filter(Boolean);
      if (!ids.length) continue;
      const { error } = await sb.from(t).delete().eq('company_id', S.companyId).in('id', ids);
      if (error) { failed = failed || { t, error }; continue; }
      dels[t].forEach((k) => S.snap[t].delete(k));
    }
    if (failed) {
      console.warn('[crm-data] commit failed', failed.t, failed.error);
      if (S.opts.onError) S.opts.onError(failed.error, failed.t);
      schedule(0); // вернуть интерфейс к состоянию базы
    }
  }
  function commit(next) {
    if (!S || !S.ready) return Promise.resolve();
    S.ver++;
    const run = S.chain.then(() => doCommit(next)).catch((e) => { console.warn('[crm-data] commit', e); if (S && S.opts.onError) S.opts.onError(e); });
    S.chain = run;
    return run;
  }

  // Повторное чтение после изменений в базе (робот, другой сотрудник, своя запись).
  // Если пока шло чтение пользователь успел что-то изменить — результат отбрасываем.
  function schedule(delay) {
    if (!S) return;
    clearTimeout(S.timer);
    const me = S;
    S.timer = setTimeout(() => {
      me.chain = me.chain.then(async () => {
        if (S !== me) return;
        const v = me.ver;
        try {
          const data = await readAll();
          if (S !== me) return;
          if (v !== me.ver) { schedule(300); return; }
          if (me.opts.onData) me.opts.onData(data);
        } catch (e) { console.warn('[crm-data] reload', e); }
      });
    }, delay == null ? 400 : delay);
  }

  // ---------- публичный API ----------
  // open(companyId, { aiBookable, normalize, onData, onError }) → { ok, data }
  async function open(companyId, opts) {
    stop();
    S = fresh(companyId);
    S.opts = opts || {};
    try { return { ok: true, data: await readAll() }; }
    catch (e) { console.warn('[crm-data] load', e); S.ready = false; return { ok: false, error: e }; }
  }
  const isEmpty = (data) => TABLES.every((t) => !(data[SLICE[t]] || []).length);
  const digits = (p) => String(p || '').replace(/\D/g, '');

  // Одноразовый перенос коллекций из старого снимка workspace_state в таблицы.
  // Пациент, которого робот уже создал по тому же номеру, не дублируется: строка
  // переиспользуется и получает ключ интерфейса из снимка. Возвращает итоговые данные.
  async function importLegacy(current, legacy) {
    if (!S || !S.ready) return current;
    const next = {}, remap = { doctors: {}, services: {}, patients: {} };
    const match = { doctors: (a, b) => String(a.name).trim().toLowerCase() === String(b.name).trim().toLowerCase(),
      services: (a, b) => String(a.name).trim().toLowerCase() === String(b.name).trim().toLowerCase(),
      patients: (a, b) => digits(a.phone).length >= 7 && digits(a.phone) === digits(b.phone) };
    ['doctors', 'services', 'patients'].forEach((t) => {
      const cur = (current[SLICE[t]] || []).slice(), leg = legacy[SLICE[t]] || [];
      leg.forEach((o) => {
        if (S.ref2id[t].has(String(o.id))) return;
        const i = cur.findIndex((x) => match[t](x, o) && !UUID_RE.test(String(o.id)) && UUID_RE.test(String(x.id)));
        if (i < 0) return;
        const oldRef = String(cur[i].id), id = S.ref2id[t].get(oldRef);
        S.ref2id[t].delete(oldRef); S.snap[t].delete(oldRef); bind(t, String(o.id), id);
        remap[t][oldRef] = o.id; cur.splice(i, 1);
      });
      const ids = new Set(cur.map((x) => String(x.id)));
      next[SLICE[t]] = cur.concat(leg.filter((o) => !ids.has(String(o.id))));
    });
    const rm = (t, v) => (v != null && remap[t][String(v)] != null) ? remap[t][String(v)] : v;
    const appts = (current.appointments || []).map((a) => Object.assign({}, a, { clientId: rm('patients', a.clientId), serviceId: rm('services', a.serviceId), doctorId: rm('doctors', a.doctorId) }));
    const have = new Set(appts.map((a) => String(a.id)));
    next.appointments = appts.concat((legacy.appointments || []).filter((a) => !have.has(String(a.id))));
    await commit(next);
    return next;
  }

  async function subscribe() {
    if (!S || S.channel) return;
    const me = S, sb = await window.DentaAuth.client();
    if (S !== me) return;
    let ch = sb.channel('crm-data-' + me.companyId);
    TABLES.forEach((t) => { ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'company_id=eq.' + me.companyId }, () => schedule()); });
    me.channel = ch.subscribe();
  }
  function stop() {
    if (!S) return;
    clearTimeout(S.timer);
    const ch = S.channel; S = null;
    if (ch) window.DentaAuth.client().then((sb) => sb.removeChannel(ch)).catch(() => {});
  }

  window.DentaData = {
    SLICES: ['clients', 'appointments', 'doctors', 'services'],
    open, commit, importLegacy, subscribe, stop, isEmpty, reload: () => schedule(0),
    ready: () => !!(S && S.ready),
    refOf, toUtc, toLocal
  };
})();
