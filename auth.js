// DentaAuth — единая точка входа/регистрации/сессии для публичной части и CRM.
// Режим supabase: Supabase Auth (пароль проверяет сервер, сессия — refresh-токен
//   supabase-js), компания и роль приходят из RPC my_workspace(), данные — из
//   таблиц под RLS. Режим demo: без сервера, всё в этом браузере (пароли — только
//   PBKDF2-хеш с солью, сам пароль нигде не сохраняется).
(function () {
  if (window.DentaAuth) return;
  const CFG = () => window.DENTALINE_CONFIG || {};
  const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  const TOKEN_KEY = 'dentaline_crm_token', TOKEN_EXP_KEY = 'dentaline_crm_token_exp';
  const WS_KEY = 'dentaline_crm_workspace';
  const ACCOUNTS_KEY = 'dentaline_demo_accounts_v1';
  const ENTRY = 'DentaLine.dc.html', APP = 'DentaLine Dashboard.dc.html', PORTAL = 'Developer Portal.dc.html';

  const ss = {
    get(k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };
  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const fail = (code, message) => ({ ok: false, code, message });

  function mode() { const c = CFG(); return c.supabaseUrl && c.supabaseAnonKey ? 'supabase' : 'demo'; }

  let clientP = null;
  function client() {
    if (clientP) return clientP;
    clientP = new Promise((resolve, reject) => {
      const make = () => resolve(window.supabase.createClient(CFG().supabaseUrl, CFG().supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'dentaline_auth' }
      }));
      if (window.supabase && window.supabase.createClient) return make();
      const s = document.createElement('script');
      s.src = SUPABASE_CDN; s.async = true;
      s.onload = make; s.onerror = () => { clientP = null; reject(new Error('cdn')); };
      document.head.appendChild(s);
    });
    return clientP;
  }

  // ---- демо-хранилище учётных записей -------------------------------------
  async function hashPassword(password, saltHex) {
    if (!(window.crypto && crypto.subtle)) throw new Error('no_crypto');
    const salt = saltHex ? new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
    const hex = (b) => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
    return { salt: hex(salt), hash: hex(bits) };
  }
  const accounts = () => ls.get(ACCOUNTS_KEY) || {};

  // Сеанс «разработчик в клинике» не должен перекрывать обычный вход.
  function dropDevSession() { try { localStorage.removeItem('dentaline_dev_session'); } catch (e) {} }

  function startDemoSession(ws) {
    dropDevSession();
    ss.set(TOKEN_KEY, 'local');
    ss.set(TOKEN_EXP_KEY, String(Date.now() + 12 * 3600 * 1000));
    ss.set(WS_KEY, JSON.stringify(ws));
  }

  // ---- публичный API --------------------------------------------------------
  async function signIn(login, password) {
    login = String(login || '').trim();
    if (!login || !password) return fail('empty', 'Введите email и пароль');

    if (mode() === 'demo') {
      // Демо-реквизиты из CLAUDE.md: кабинет разработчика и базовая клиника.
      if (login === 'Salah-13' && password === 'Salah-13') return { ok: true, route: 'portal' };
      if (login === '1' && password === '1') {
        startDemoSession({ companyId: null, companyName: 'DentaLine', role: 'Owner', fullName: 'Владелец', email: '', mode: 'demo' });
        return { ok: true, route: 'dashboard' };
      }
      const acc = accounts()[login.toLowerCase()];
      if (!acc) return fail('not_found', 'Пользователь с таким email не найден');
      let h;
      try { h = await hashPassword(password, acc.salt); } catch (e) { return fail('no_crypto', 'Браузер не поддерживает безопасную проверку пароля'); }
      if (h.hash !== acc.hash) return fail('wrong_password', 'Неверный пароль');
      if (acc.active === false) return fail('inactive', 'Аккаунт отключён. Обратитесь к владельцу клиники');
      startDemoSession({ companyId: acc.companyId, companyName: acc.companyName, role: acc.role, fullName: acc.fullName, email: login.toLowerCase(), mode: 'demo' });
      return { ok: true, route: 'dashboard' };
    }

    if (!EMAIL_RE.test(login)) return fail('bad_email', 'Введите email, указанный при регистрации');
    let sb; try { sb = await client(); } catch (e) { return fail('network', 'Нет связи с сервером авторизации'); }
    const { error } = await sb.auth.signInWithPassword({ email: login, password });
    if (error) {
      if (/confirm/i.test(error.message)) return fail('email_not_confirmed', 'Email не подтверждён. Откройте письмо со ссылкой');
      if (error.status === 400) return fail('invalid', 'Неверный email или пароль');
      if (error.status === 429) return fail('rate_limited', 'Слишком много попыток. Подождите минуту');
      return fail('network', 'Сервер авторизации не ответил. Попробуйте ещё раз');
    }
    dropDevSession();
    const ws = await getWorkspace();
    if (!ws.ok) { await sb.auth.signOut(); return ws; }
    return { ok: true, route: ws.superadmin && !ws.companyId ? 'portal' : 'dashboard' };
  }

  async function signUp(f) {
    const fullName = String(f.fullName || '').trim(), email = String(f.email || '').trim().toLowerCase();
    const company = String(f.company || '').trim(), password = String(f.password || '');
    if (!fullName) return fail('name', 'Укажите имя');
    if (!EMAIL_RE.test(email)) return fail('email', 'Проверьте email');
    if (password.length < 8) return fail('password', 'Пароль — не короче 8 символов');
    if (!company) return fail('company', 'Укажите название компании');

    if (mode() === 'demo') {
      const all = accounts();
      if (all[email]) return fail('exists', 'Этот email уже зарегистрирован. Войдите или восстановите пароль');
      let h; try { h = await hashPassword(password); } catch (e) { return fail('no_crypto', 'Браузер не поддерживает безопасное хранение пароля'); }
      const companyId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      all[email] = { salt: h.salt, hash: h.hash, fullName, companyId, companyName: company, role: 'Owner', active: true, created: new Date().toISOString() };
      ls.set(ACCOUNTS_KEY, all);
      startDemoSession({ companyId, companyName: company, role: 'Owner', fullName, email, mode: 'demo', fresh: true });
      return { ok: true, route: 'dashboard' };
    }

    let sb; try { sb = await client(); } catch (e) { return fail('network', 'Нет связи с сервером авторизации'); }
    const { data, error } = await sb.auth.signUp({ email, password, options: {
      data: { full_name: fullName, company_name: company },
      emailRedirectTo: location.href.split('#')[0] + '#/login'
    } });
    if (error) {
      if (/registered|exists/i.test(error.message)) return fail('exists', 'Этот email уже зарегистрирован. Войдите или восстановите пароль');
      if (/password/i.test(error.message)) return fail('password', 'Пароль слишком простой');
      return fail('network', 'Не удалось зарегистрироваться: ' + error.message);
    }
    // Если в проекте включено подтверждение email, сессии ещё нет.
    if (!data.session) return { ok: true, needsConfirm: true };
    const ws = await getWorkspace();
    return ws.ok ? { ok: true, route: 'dashboard' } : ws;
  }

  // Демо-аналог серверного POST /tenants: кабинет разработчика заводит владельца
  // с временным паролем, чтобы его можно было проверить на экране входа.
  async function createDemoAccount(o) {
    const email = String(o.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail('email', 'Проверьте email владельца');
    if (String(o.password || '').length < 8) return fail('password', 'Временный пароль — не короче 8 символов');
    const all = accounts();
    if (all[email]) return fail('exists', 'Пользователь с таким email уже есть');
    let h; try { h = await hashPassword(o.password); } catch (e) { return fail('no_crypto', 'Браузер не поддерживает безопасное хранение пароля'); }
    all[email] = { salt: h.salt, hash: h.hash, fullName: o.fullName || '', companyId: o.companyId, companyName: o.companyName,
      role: 'Owner', active: o.active !== false, created: new Date().toISOString() };
    ls.set(ACCOUNTS_KEY, all);
    return { ok: true };
  }
  function setDemoCompanyActive(companyId, active) {
    const all = accounts(); let n = 0;
    Object.keys(all).forEach(k => { if (all[k].companyId === companyId) { all[k].active = !!active; n++; } });
    if (n) ls.set(ACCOUNTS_KEY, all);
  }

  async function getWorkspace() {
    if (mode() === 'demo') {
      const exp = parseInt(ss.get(TOKEN_EXP_KEY) || '0', 10);
      if (!ss.get(TOKEN_KEY) || (exp && Date.now() > exp)) return fail('no_session', 'Войдите в кабинет');
      let ws = null; try { ws = JSON.parse(ss.get(WS_KEY) || 'null'); } catch (e) {}
      if (!ws) return fail('no_session', 'Войдите в кабинет');
      if (ws.email) {
        const acc = accounts()[ws.email];
        if (!acc || acc.active === false) { clearLocal(); return fail('inactive', 'Аккаунт отключён'); }
      }
      return Object.assign({ ok: true }, ws);
    }
    let sb; try { sb = await client(); } catch (e) { return fail('network', 'Нет связи с сервером авторизации'); }
    const { data: s } = await sb.auth.getSession();
    if (!s || !s.session) return fail('no_session', 'Войдите в кабинет');
    const { data, error } = await sb.rpc('my_workspace');
    if (error) return fail('network', 'Не удалось загрузить данные компании');
    if (data.access === 'inactive') return fail('inactive', 'Аккаунт или компания отключены. Обратитесь в поддержку');
    if (data.access === 'no_company') return fail('no_company', 'Аккаунт не привязан к компании');
    return { ok: true, mode: 'supabase', superadmin: !!data.superadmin, companyId: data.company_id || null,
      companyName: data.company_name || '', businessType: data.business_type || '', role: data.role || 'Owner',
      fullName: data.full_name || '', email: s.session.user.email, plan: data.plan, status: data.company_status };
  }

  function clearLocal() { ss.del(TOKEN_KEY); ss.del(TOKEN_EXP_KEY); ss.del(WS_KEY); ss.del('dentaline_crm_impersonation'); }

  async function signOut() {
    clearLocal();
    dropDevSession();
    if (mode() === 'supabase') { try { const sb = await client(); await sb.auth.signOut(); } catch (e) {} }
  }

  async function requestReset(email) {
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail('email', 'Проверьте email');
    if (mode() === 'demo') return fail('demo', 'В демо-режиме письма не отправляются. Зарегистрируйтесь заново или подключите сервер');
    let sb; try { sb = await client(); } catch (e) { return fail('network', 'Нет связи с сервером авторизации'); }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] + '#/reset' });
    // Ответ одинаковый для существующих и несуществующих адресов — не раскрываем базу.
    if (error && error.status === 429) return fail('rate_limited', 'Письмо уже отправлено. Подождите минуту');
    return { ok: true };
  }

  async function updatePassword(password) {
    if (String(password || '').length < 8) return fail('password', 'Пароль — не короче 8 символов');
    if (mode() === 'demo') return fail('demo', 'Недоступно в демо-режиме');
    const sb = await client();
    const { error } = await sb.auth.updateUser({ password });
    if (error) return fail('expired', 'Ссылка устарела. Запросите восстановление ещё раз');
    return { ok: true };
  }

  async function onRecovery(cb) {
    if (mode() !== 'supabase') return;
    try { const sb = await client(); sb.auth.onAuthStateChange((ev) => { if (ev === 'PASSWORD_RECOVERY') cb(); }); } catch (e) {}
  }

  // ---- данные компании (режим supabase) ----------------------------------
  async function loadState(companyId) {
    if (mode() !== 'supabase' || !companyId) return null;
    const sb = await client();
    const { data, error } = await sb.from('workspace_state').select('data').eq('company_id', companyId).maybeSingle();
    if (error) return null;
    return data && data.data && Object.keys(data.data).length ? data.data : null;
  }
  let saveT = null;
  function saveState(companyId, payload) {
    if (mode() !== 'supabase' || !companyId) return;
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try {
        const sb = await client();
        await sb.from('workspace_state').upsert({ company_id: companyId, data: payload, updated_at: new Date().toISOString() });
      } catch (e) {}
    }, 800);
  }

  function go(route, hash) {
    const file = route === 'portal' ? PORTAL : route === 'dashboard' ? APP : ENTRY;
    window.location.href = encodeURI(file) + (hash || '');
  }

  // Вызов Edge Function канала WhatsApp с токеном текущей сессии (режим supabase).
  async function callFunction(name, path, body) {
    if (mode() !== 'supabase') return fail('demo', 'Нужен сервер: заполните dentaline.config.js');
    const sb = await client();
    const { data } = await sb.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) return fail('no_session', 'Сессия истекла — войдите снова');
    try {
      const res = await fetch(CFG().supabaseUrl.replace(/\/$/, '') + '/functions/v1/' + name + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + token, apikey: CFG().supabaseAnonKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      return res.ok ? Object.assign({ ok: true }, out) : fail(out.code || 'http_' + res.status, out.message || 'Сервер ответил ошибкой ' + res.status);
    } catch (e) { return fail('network', 'Нет связи с сервером'); }
  }

  window.DentaAuth = { mode, signIn, signUp, signOut, getWorkspace, requestReset, updatePassword, onRecovery,
    loadState, saveState, go, clearLocal, createDemoAccount, setDemoCompanyActive, client, callFunction, ENTRY, APP, PORTAL };
})();
