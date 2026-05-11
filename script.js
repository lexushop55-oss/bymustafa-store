/* ============================================================
   SCRIPT.JS — by MUSTAFA Shop
   Architecture: Firebase Firestore (products) + Firebase Storage (images)
   + localStorage (cart only)
   Module-pattern IIFEs, no globals pollution.
============================================================ */

'use strict';

import { initializeApp }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc }
                                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject }
                                from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
/* ── Firebase config ── */
const firebaseConfig = {
  apiKey:            "AIzaSyC-LJMbKoQiavfBm6mS_ys1MVn9hK0YX4k",
  authDomain:        "bymustafa-store.firebaseapp.com",
  projectId:         "bymustafa-store",
  storageBucket:     "bymustafa-store.firebasestorage.app",
  messagingSenderId: "1073719464966",
  appId:             "1:1073719464966:web:411471b1f0a76d0a9f9f87",
  measurementId:     "G-8N5X6EVGZC",
};

const app     = initializeApp(firebaseConfig);
const db      = getFirestore(app);
const storage = getStorage(app);

console.log("✅ Firebase Firestore + Storage connected");

/* ============================================================
   LS — safe localStorage wrapper (cart + settings ONLY)
   Products are NEVER stored here anymore.
============================================================ */
const LS = (() => {
  function get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError' || e.code === 22) {
        Toast.show('⚠ Storage переполнен. Очисти кэш.', 'warn');
        return false;
      }
      return false;
    }
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  function usage() {
    try {
      return Object.keys(localStorage).reduce((total, k) => {
        return total + ((localStorage[k].length + k.length) * 2);
      }, 0);
    } catch { return 0; }
  }

  return { get, set, remove, usage };
})();

/* ============================================================
   Toast notifications
============================================================ */
const Toast = (() => {
  const ICONS  = { success: '✓', warn: '⚠', error: '✕', info: 'ℹ' };
  const COLORS = {
    success: 'var(--green)',
    warn:    'var(--amber)',
    error:   'var(--red)',
    info:    'var(--blue)',
  };

  function show(msg, type = 'success', duration = 2600) {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el    = document.createElement('div');
    el.className = 'toast';
    const color  = COLORS[type] || COLORS.info;
    el.style.borderColor = color + '33';
    el.innerHTML = `<span style="color:${color};font-size:15px">${ICONS[type] || ICONS.info}</span>`
                 + `<span style="color:${color}">${String(msg).slice(0, 120)}</span>`;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 280);
    }, duration);
  }

  return { show };
})();

/* ============================================================
   Store — cart persistence (products now live in Firestore)
============================================================ */
const Store = (() => {
  const CART_KEY = 'bm_cart';

  function loadCart() {
    const raw = LS.get(CART_KEY, []);
    return Array.isArray(raw)
      ? raw.filter(i => i && i.id && i.name && i.price > 0)
           .map(i => ({ id: i.id, name: String(i.name), price: Number(i.price), qty: Math.max(1, Number(i.qty) || 1) }))
      : [];
  }

  function saveCart(arr) {
    LS.set(CART_KEY, (arr || []).map(({ id, name, price, qty }) => ({ id, name, price, qty })));
  }

  async function clearAll() {
    if (!confirm('Очистить корзину и локальный кеш? Товары в Firestore НЕ удаляются.')) return;
    LS.remove(CART_KEY);
    State.cart = [];
    CartUI.render();
    CartUI.updateCount();
    Toast.show('🗑 Локальный кэш очищен', 'warn');
  }

  function storageUsage() {
    const bytes = LS.usage();
    return {
      kb:  (bytes / 1024).toFixed(1),
      pct: Math.min(100, (bytes / (5 * 1024 * 1024)) * 100).toFixed(0),
    };
  }

  return { loadCart, saveCart, clearAll, storageUsage };
})();

/* ============================================================
   FirestoreDB — all product CRUD via Firestore
============================================================ */
const FirestoreDB = (() => {
  const COLL = 'products';

  /* Sanitize incoming Firestore doc → local product object */
  function sanitize(docSnap) {
    const d = docSnap.data();
    return {
      id:        docSnap.id,               // Firestore document ID (string)
      name:      String(d.name      || '').trim().slice(0, 120),
      price:     Math.max(1, Number(d.price)    || 1),
      oldPrice:  d.oldPrice ? Math.max(1, Number(d.oldPrice)) : null,
      cat:       String(d.cat       || 'other'),
      stock:     d.stock != null ? Math.max(0, Number(d.stock)) : null,
      desc:      String(d.desc      || '').trim().slice(0, 1000),
      inStock:   d.inStock !== false,
      imageUrl:  String(d.imageUrl  || ''),   // Firebase Storage URL
      createdAt: Number(d.createdAt) || Date.now(),
    };
  }

  /* Load all products from Firestore */
  async function loadProducts() {
    const snap = await getDocs(collection(db, COLL));
    return snap.docs.map(sanitize);
  }

  /* Add new product, returns the created product with Firestore id */
  async function addProduct(data) {
    const ref = await addDoc(collection(db, COLL), {
      name:      data.name,
      price:     data.price,
      oldPrice:  data.oldPrice || null,
      cat:       data.cat,
      stock:     data.stock,
      desc:      data.desc,
      inStock:   data.inStock,
      imageUrl:  data.imageUrl || '',
      createdAt: Date.now(),
    });
    return { ...data, id: ref.id };
  }

  /* Update existing product by Firestore doc id */
  async function updateProduct(id, data) {
    const ref = doc(db, COLL, id);
    await updateDoc(ref, {
      name:     data.name,
      price:    data.price,
      oldPrice: data.oldPrice || null,
      cat:      data.cat,
      stock:    data.stock,
      desc:     data.desc,
      inStock:  data.inStock,
      imageUrl: data.imageUrl || '',
    });
  }

  /* Delete product doc from Firestore */
  async function deleteProduct(id) {
    await deleteDoc(doc(db, COLL, id));
  }

  return { loadProducts, addProduct, updateProduct, deleteProduct, sanitize };
})();

/* ============================================================
   StorageUpload — image upload to Firebase Storage
============================================================ */
const StorageUpload = (() => {
  async function uploadImage(productId, blob) {

    const formData = new FormData();
    formData.append('file', blob);

    formData.append('upload_preset', 'bymustafa');

    const response = await fetch(
      'https://api.cloudinary.com/v1_1/deqx8dgre/image/upload',
      {
        method: 'POST',
        body: formData
      }
    );

    const data = await response.json();

    return data.secure_url;
  }

  async function deleteImage(productId) {
    return true;
  }

  return {
    uploadImage,
    deleteImage
  };

})();

/* ============================================================
   State — application state
============================================================ */
const State = (() => {
  const _state = {
    products:    [],           // loaded from Firestore
    cart:        Store.loadCart(),
    adminMode:   false,
    editingId:   null,         // Firestore doc id string or null
    modalId:     null,
    curCat:      'all',
    searchQ:     '',
    sortMode:    '',
    payMethod:   null,
    pendingBlob: null,         // File blob waiting to be uploaded
    pendingURL:  '',           // ObjectURL for form preview only
    loading:     false,
  };
  return _state;
})();

/* ============================================================
   Constants
============================================================ */
// Пароль хранится как SHA-256 хеш — в коде нет открытого пароля
// Текущий пароль: mustafa2024 → чтобы сменить, запусти в консоли:
// hashPassword('новый_пароль').then(h => console.log(h))
const ADMIN_PASS_HASH = '3ca6f942ed4c734863c3f7b0dba0f0dd7bf4fe8ca562fd5afcecfaffab8d73ec';

async function hashPassword(pw) {
  const enc = new TextEncoder().encode(pw);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// Секретная комбинация Shift+M дважды — открывает скрытый вход в админку
let _mPress = 0, _mTimer = null;
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'M' && e.shiftKey) {
    _mPress++;
    clearTimeout(_mTimer);
    _mTimer = setTimeout(() => { _mPress = 0; }, 600);
    if (_mPress >= 2) { _mPress = 0; Admin.toggleOrLogin(); }
  }
});

const CAT_LABELS = {
  bady:      '💊 БАДы',
  protein:   '💪 Протеин',
  nootropic: '🧠 Ноотропы',
  mushroom:  '🍄 Грибы',
  vitamin:   '🛡 Витамины',
  amino:     '⚡ Аминокислоты',
  fat:       '🔥 Жиросжигатели',
  clothes:   '👕 Одежда',
  other:     '📦 Прочее',
};

const CAT_NAMES = {
  all: 'Все товары',
  ...Object.fromEntries(
    Object.entries(CAT_LABELS).map(([k, v]) => [k, v.replace(/^\S+\s/, '')])
  ),
};

const ALL_CATS = ['all', 'bady', 'protein', 'nootropic', 'mushroom', 'vitamin', 'amino', 'fat', 'clothes', 'other'];

/* ============================================================
   Helpers
============================================================ */
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plural(n, one, two, five) {
  const m = n % 10, h = n % 100;
  if (h >= 11 && h <= 19) return five;
  if (m === 1) return one;
  if (m >= 2 && m <= 4) return two;
  return five;
}

function stockInfo(p) {
  const can = p.inStock !== false && p.stock !== 0;
  if (!can) return { cls: 'no',  txt: 'Нет в наличии' };
  if (p.stock != null && p.stock < 10) return { cls: 'low', txt: `Осталось: ${p.stock} шт.` };
  return { cls: 'ok', txt: p.stock != null ? `В наличии: ${p.stock} шт.` : 'В наличии' };
}

function getFiltered() {
  let list = [...State.products];
  if (State.curCat !== 'all') list = list.filter(p => p.cat === State.curCat);
  if (State.searchQ) {
    const q = State.searchQ.toLowerCase();
    list = list.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.desc || '').toLowerCase().includes(q)
    );
  }
  switch (State.sortMode) {
    case 'price-asc':  list.sort((a, b) => a.price - b.price);                            break;
    case 'price-desc': list.sort((a, b) => b.price - a.price);                            break;
    case 'name':       list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));            break;
    case 'avail':      list.sort((a, b) => (b.inStock ? 1 : 0) - (a.inStock ? 1 : 0));   break;
    case 'new':        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));      break;
  }
  return list;
}

function canBuy(p) {
  return p.inStock !== false && p.stock !== 0;
}

function setEl(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showEl(id)  { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hideEl(id)  { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

function openOverlay(id)  {
  const el = document.getElementById(id);
  if (el) { el.classList.add('show'); document.body.style.overflow = 'hidden'; }
}
function closeOverlay(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('show'); document.body.style.overflow = ''; }
}

/* ============================================================
   UI — rendering layer
============================================================ */
const UI = (() => {

  function updateCounts() {
    ALL_CATS.forEach(cat => {
      const el = document.getElementById('cnt-' + cat);
      if (!el) return;
      el.textContent = cat === 'all'
        ? State.products.length
        : State.products.filter(p => p.cat === cat).length;
    });
  }

  function updateAdminStats() {
    const avail = State.products.filter(p => canBuy(p)).length;
    const { kb, pct } = Store.storageUsage();
    setEl('st-total',   State.products.length);
    setEl('st-avail',   avail);
    setEl('st-sold',    State.products.length - avail);
    setEl('st-storage', `${kb} KB (корзина)`);
    const bar = document.getElementById('st-storage');
    if (bar) bar.style.color = 'var(--t1)';
  }

  function renderEmpty() {
    const isSearch = Boolean(State.searchQ);
    const isAdmin  = State.adminMode;
    return `<div class="empty">
      <div class="empty-ico">${isSearch ? '🔍' : isAdmin ? '📦' : '🛍'}</div>
      <div class="empty-title">${isSearch ? 'Ничего не найдено' : isAdmin ? 'Нет товаров' : 'Каталог пуст'}</div>
      <p class="empty-desc">${
        isSearch
          ? `По запросу «${esc(State.searchQ)}» ничего нет. Попробуй другой запрос.`
          : isAdmin
            ? 'Нажми «+ Добавить» чтобы создать первый товар'
            : 'Скоро здесь появятся товары'
      }</p>
      ${isAdmin ? `<button class="empty-cta" onclick="Admin.openAdd()">+ Добавить товар</button>` : ''}
    </div>`;
  }

  function renderCard(p, idx) {
    const disc    = p.oldPrice ? Math.round((1 - p.price / p.oldPrice) * 100) : null;
    const buyable = canBuy(p);
    const qty     = (State.cart.find(c => c.id === p.id) || {}).qty || 0;
    const imgSrc  = p.imageUrl || '';
    const { cls, txt } = stockInfo(p);

    return `<div class="p-card" role="listitem" onclick="ProductModal.open('${esc(p.id)}')"
              style="animation-delay:${Math.min(idx * 30, 400)}ms">
      <div class="p-img">
        ${imgSrc
          ? `<img src="${esc(imgSrc)}" alt="${esc(p.name)}" loading="lazy">`
          : `<div class="p-img-ph" aria-hidden="true">💊</div>`}
        ${disc ? `<div class="p-disc">-${disc}%</div>` : ''}
        ${!buyable ? `<div class="p-sold">НЕТ В НАЛИЧИИ</div>` : ''}
      </div>

      <div class="p-admin-bar">
        <button class="p-btn-edit" onclick="event.stopPropagation();Admin.openEdit('${esc(p.id)}')">✏ Изменить</button>
        <button class="p-btn-del"  onclick="event.stopPropagation();Admin.quickDel('${esc(p.id)}')">🗑</button>
      </div>

      <div class="p-body">
        <div class="p-price-row">
          <span class="p-price">${p.price.toLocaleString('ru')} ₽</span>
          ${p.oldPrice ? `<span class="p-oldp">${p.oldPrice.toLocaleString('ru')} ₽</span>` : ''}
        </div>
        <div class="p-name">${esc(p.name)}</div>
        <div class="p-stock ${cls}">${esc(txt)}</div>
        <div class="p-action">
          <button class="p-add-btn${buyable ? '' : ' sold'}${qty > 0 ? ' hide' : ''}"
            onclick="event.stopPropagation();${buyable ? `Cart.add('${esc(p.id)}')` : ''}"
            ${!buyable ? 'disabled' : ''}>
            ${buyable ? '+ Добавить' : 'Нет в наличии'}
          </button>
          <div class="p-qty${qty > 0 ? ' show' : ''}" id="pqty-${p.id}">
            <button class="q-btn minus" onclick="event.stopPropagation();Cart.dec('${esc(p.id)}')" aria-label="Убрать">−</button>
            <div class="q-val" id="pqv-${p.id}">${qty}</div>
            <button class="q-btn plus"  onclick="event.stopPropagation();Cart.add('${esc(p.id)}')" aria-label="Добавить">+</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function render() {
    const list = getFiltered();
    const grid = document.getElementById('grid');
    if (!grid) return;

    const name  = CAT_NAMES[State.curCat] || 'Каталог';
    const count = list.length;
    setEl('page-title', name);
    setEl('page-sub',   `${count} ${plural(count, 'товар', 'товара', 'товаров')}${State.searchQ ? ` · «${State.searchQ}»` : ''}`);

    if (!count) {
      grid.innerHTML = renderEmpty();
      updateCounts();
      return;
    }

    grid.innerHTML = list.map((p, i) => renderCard(p, i)).join('');
    updateCounts();
    if (State.adminMode) updateAdminStats();
  }

  function showSkeleton() {
    const grid = document.getElementById('grid');
    if (grid) {
      grid.innerHTML = Array.from({ length: 6 }, () => `
        <div class="skel">
          <div class="skel-img"></div>
          <div class="skel-body">
            <div class="skel-line skel-w60"></div>
            <div class="skel-line skel-w80"></div>
            <div class="skel-line skel-w40"></div>
          </div>
        </div>`).join('');
    }
  }

  function syncCard(id) {
    const qty     = (State.cart.find(c => c.id === id) || {}).qty || 0;
    const qtyEl   = document.getElementById('pqv-' + id);
    const qtyWrap = document.getElementById('pqty-' + id);
    const addBtn  = qtyWrap ? qtyWrap.previousElementSibling : null;
    if (qtyEl)   qtyEl.textContent = qty;
    if (qtyWrap) qtyWrap.classList.toggle('show', qty > 0);
    if (addBtn)  addBtn.classList.toggle('hide', qty > 0);
  }

  return { render, syncCard, updateCounts, updateAdminStats, showSkeleton };
})();

/* ============================================================
   Cart — cart state + actions
   Note: product id is now a Firestore string, not a number
============================================================ */
const Cart = (() => {

  function add(id) {
    const p = State.products.find(x => x.id === id);
    if (!p || !canBuy(p)) return;
    const existing = State.cart.find(x => x.id === id);
    if (existing) {
      existing.qty++;
    } else {
      State.cart.push({ id: p.id, name: p.name, price: p.price, qty: 1 });
    }
    Store.saveCart(State.cart);
    CartUI.updateCount();
    Toast.show('✓ Добавлено в корзину', 'success');
    UI.syncCard(id);
    if (document.getElementById('overlay-cart').classList.contains('show')) CartUI.render();
    if (State.adminMode) UI.updateAdminStats();
    const pill = document.getElementById('cart-count');
    if (pill) { pill.classList.add('bump'); setTimeout(() => pill.classList.remove('bump'), 320); }
  }

  function dec(id) {
    const item = State.cart.find(x => x.id === id);
    if (!item) return;
    item.qty--;
    if (item.qty <= 0) State.cart = State.cart.filter(x => x.id !== id);
    Store.saveCart(State.cart);
    CartUI.updateCount();
    UI.syncCard(id);
    if (document.getElementById('overlay-cart').classList.contains('show')) CartUI.render();
    if (State.adminMode) UI.updateAdminStats();
  }

  function remove(id) {
    State.cart = State.cart.filter(x => x.id !== id);
    Store.saveCart(State.cart);
    CartUI.updateCount();
    UI.syncCard(id);
    CartUI.render();
    if (State.adminMode) UI.updateAdminStats();
  }

  function changeQty(id, delta) {
    delta > 0 ? add(id) : dec(id);
  }

  function reset() {
    State.cart = [];
    Store.saveCart(State.cart);
    CartUI.updateCount();
  }

  return { add, dec, remove, changeQty, reset };
})();

/* ============================================================
   CartUI — cart panel rendering
============================================================ */
const CartUI = (() => {

  function updateCount() {
    setEl('cart-count', State.cart.reduce((a, b) => a + b.qty, 0));
  }

  function open()  { openOverlay('overlay-cart'); render(); }
  function close() { closeOverlay('overlay-cart'); }
  function closeOuter(e) { if (e.target === document.getElementById('overlay-cart')) close(); }

  function selectPay(method, el) {
    State.payMethod = method;
    document.querySelectorAll('.pay-opt').forEach(b => b.classList.remove('sel'));
    if (el) el.classList.add('sel');
  }

  function checkout() {
    if (!State.payMethod) { Toast.show('⚠ Выбери способ оплаты', 'warn'); return; }
    const total   = State.cart.reduce((a, b) => a + b.price * b.qty, 0);
    const methods = { sbp: 'СБП', sber: 'SberPay', visa: 'Visa' };
    alert(
      `✅ Заказ оформлен!\n\n` +
      `Способ: ${methods[State.payMethod]}\n` +
      `Сумма: ${total.toLocaleString('ru')} ₽\n\n` +
      `Свяжитесь с нами: @xnoxce`
    );
    document.querySelectorAll('.p-qty').forEach(el => {
      el.classList.remove('show');
      const btn = el.previousElementSibling;
      if (btn) btn.classList.remove('hide');
    });
    document.querySelectorAll('.q-val').forEach(el => el.textContent = '0');
    State.payMethod = null;
    Cart.reset();
    render();
    close();
  }

  function render() {
    const wrap   = document.getElementById('cart-items');
    const footer = document.getElementById('cart-footer');
    if (!wrap || !footer) return;

    if (!State.cart.length) {
      wrap.innerHTML = `<div class="cart-empty">
        <div class="cart-empty-ico">🛒</div>
        <p>Корзина пуста<br><small style="color:var(--t4)">Добавьте товары из каталога</small></p>
      </div>`;
      footer.classList.add('hidden');
      return;
    }

    const total = State.cart.reduce((a, b) => a + b.price * b.qty, 0);
    wrap.innerHTML = State.cart.map(item => {
      // Try to find product image from loaded products
      const prod   = State.products.find(p => p.id === item.id);
      const imgSrc = prod ? (prod.imageUrl || '') : '';
      return `<div class="ci">
        ${imgSrc
          ? `<img class="ci-thumb" src="${esc(imgSrc)}" alt="${esc(item.name)}" loading="lazy">`
          : `<div class="ci-ph">💊</div>`}
        <div class="ci-info">
          <div class="ci-name">${esc(item.name)}</div>
          <div class="ci-price">${(item.price * item.qty).toLocaleString('ru')} ₽</div>
          <div class="ci-ctrl">
            <button class="ci-qb" onclick="Cart.changeQty('${item.id}', -1)" aria-label="Убрать">−</button>
            <span class="ci-q">${item.qty}</span>
            <button class="ci-qb" onclick="Cart.changeQty('${item.id}',  1)" aria-label="Добавить">+</button>
          </div>
        </div>
        <button class="ci-rm" onclick="Cart.remove('${item.id}')" aria-label="Удалить">✕</button>
      </div>`;
    }).join('');

    setEl('cart-total', total.toLocaleString('ru') + ' ₽');
    footer.classList.remove('hidden');
  }

  return { updateCount, open, close, closeOuter, selectPay, checkout, render };
})();

/* ============================================================
   ProductModal — product detail overlay
============================================================ */
const ProductModal = (() => {

  function open(id) {
    const p = State.products.find(x => x.id === id);
    if (!p) return;
    State.modalId = id;

    // Image (Firebase Storage URL)
    const imgSrc = p.imageUrl || '';
    const imgEl  = document.getElementById('modal-img');
    const phEl   = document.getElementById('modal-img-ph');
    if (imgEl && phEl) {
      if (imgSrc) { imgEl.src = imgSrc; imgEl.style.display = 'block'; phEl.style.display = 'none'; }
      else        { imgEl.style.display = 'none'; phEl.style.display = 'block'; }
    }

    // Discount
    const disc   = p.oldPrice ? Math.round((1 - p.price / p.oldPrice) * 100) : null;
    const discEl = document.getElementById('modal-disc');
    if (discEl) { discEl.textContent = disc ? `-${disc}%` : ''; discEl.style.display = disc ? 'block' : 'none'; }

    // Text fields
    setEl('modal-cat',   CAT_LABELS[p.cat] || '');
    setEl('modal-name',  p.name);
    setEl('modal-price', p.price.toLocaleString('ru') + ' ₽');

    const oldpEl = document.getElementById('modal-oldp');
    const pctEl  = document.getElementById('modal-pct');
    if (p.oldPrice) {
      if (oldpEl) { oldpEl.textContent = p.oldPrice.toLocaleString('ru') + ' ₽'; oldpEl.classList.remove('hidden'); }
      if (pctEl)  { pctEl.textContent = `-${disc}%`; pctEl.classList.remove('hidden'); }
    } else {
      if (oldpEl) oldpEl.classList.add('hidden');
      if (pctEl)  pctEl.classList.add('hidden');
    }

    // Stock pill
    const { cls, txt } = stockInfo(p);
    const pillEl = document.getElementById('modal-stock');
    if (pillEl) {
      pillEl.className = `modal-stock ${cls}`;
      setEl('modal-stock-txt', txt);
    }

    // Description
    const descEl = document.getElementById('modal-desc');
    if (descEl) {
      if (p.desc && p.desc.trim()) {
        descEl.textContent = p.desc;
        descEl.className   = 'modal-desc';
      } else {
        descEl.textContent = 'Описание не указано';
        descEl.className   = 'modal-desc empty';
      }
    }

    // Add button
    const addBtn = document.getElementById('modal-add-btn');
    if (addBtn) {
      const buyable       = canBuy(p);
      addBtn.className    = 'btn-modal-add' + (buyable ? '' : ' sold');
      addBtn.textContent  = buyable ? '+ В корзину' : 'Нет в наличии';
      addBtn.disabled     = !buyable;
    }

    // Edit button visibility
    const editBtn = document.getElementById('modal-edit-btn');
    if (editBtn) {
      if (State.adminMode) editBtn.classList.remove('hidden');
      else                 editBtn.classList.add('hidden');
    }

    openOverlay('overlay-product');
  }

  function close() {
    closeOverlay('overlay-product');
    State.modalId = null;
  }

  function closeOuter(e) {
    if (e.target === document.getElementById('overlay-product')) close();
  }

  function add() {
    if (State.modalId) { Cart.add(State.modalId); close(); }
  }

  function edit() {
    const id = State.modalId;
    close();
    Admin.openEdit(id);
  }

  return { open, close, closeOuter, add, edit };
})();

/* ============================================================
   Admin — admin panel, CRUD via Firestore + Storage
============================================================ */
const Admin = (() => {

  /* ── Auth ── */
  function toggleOrLogin() {
    if (State.adminMode) { disable(); return; }
    openOverlay('overlay-login');
    const pw = document.getElementById('login-pw');
    if (pw) { pw.value = ''; pw.focus(); }
    const err = document.getElementById('login-err');
    if (err) err.classList.add('hidden');
  }

  async function login() {
    const pw    = (document.getElementById('login-pw') || {}).value || '';
    const errEl = document.getElementById('login-err');
    const inp   = document.getElementById('login-pw');
    const hash  = await hashPassword(pw);
    if (hash === ADMIN_PASS_HASH) {
      closeOverlay('overlay-login');
      enable();
    } else {
      if (errEl) errEl.classList.remove('hidden');
      if (inp)   {
        inp.classList.add('invalid');
        setTimeout(() => inp.classList.remove('invalid'), 400);
      }
    }
  }

  function closeLogin()       { closeOverlay('overlay-login'); }
  function closeLoginOuter(e) { if (e.target === document.getElementById('overlay-login')) closeLogin(); }

  function enable() {
    State.adminMode = true;
    document.body.classList.add('admin-mode');
    const toggle = document.getElementById('btn-admin');
    const dot    = document.getElementById('admin-dot');
    if (toggle) { toggle.classList.remove('hidden'); toggle.classList.add('active'); }
    if (dot)    dot.classList.add('on');
    showEl('btn-add');
    showEl('stats-bar');
    const badge    = document.getElementById('admin-badge');
    const badgeDot = document.getElementById('adm-dot');
    const badgeTxt = document.getElementById('adm-badge-txt');
    if (badge)    { badge.classList.remove('hidden'); badge.classList.add('on'); }
    if (badgeDot) badgeDot.classList.add('on');
    if (badgeTxt) badgeTxt.textContent = 'Admin: ВКЛ';

    UI.render();
    UI.updateAdminStats();
    Toast.show('⚙ Режим администратора включён', 'info');
  }

  function disable() {
    State.adminMode = false;
    document.body.classList.remove('admin-mode');
    const toggle = document.getElementById('btn-admin');
    const dot    = document.getElementById('admin-dot');
    if (toggle) { toggle.classList.add('hidden'); toggle.classList.remove('active'); }
    if (dot)    dot.classList.remove('on');
    hideEl('btn-add');
    hideEl('stats-bar');
    const badge    = document.getElementById('admin-badge');
    const badgeDot = document.getElementById('adm-dot');
    const badgeTxt = document.getElementById('adm-badge-txt');
    if (badge)    { badge.classList.add('hidden'); badge.classList.remove('on'); }
    if (badgeDot) badgeDot.classList.remove('on');
    if (badgeTxt) badgeTxt.textContent = 'Admin';
    UI.render();
  }

  /* ── Form helpers ── */
  function resetForm() {
    if (State.pendingURL) { URL.revokeObjectURL(State.pendingURL); State.pendingURL = ''; }
    State.pendingBlob = null;

    ['f-name', 'f-price', 'f-oldp', 'f-stock', 'f-desc'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.remove('invalid'); }
    });
    const cat = document.getElementById('f-cat');
    if (cat) cat.value = 'bady';
    const ins = document.getElementById('f-instock');
    if (ins) ins.checked = true;
    const prev = document.getElementById('img-preview');
    if (prev) { prev.src = ''; prev.style.display = 'none'; }
    const fileIn = document.getElementById('f-file');
    if (fileIn) fileIn.value = '';
    const inner = document.getElementById('upload-inner');
    if (inner) inner.style.display = 'flex';
  }

  function openAdd() {
    State.editingId = null;
    resetForm();
    setEl('form-title', 'Новый товар');
    setEl('form-sub',   'Заполни информацию о товаре');
    hideEl('btn-del');
    openOverlay('overlay-form');
    setTimeout(() => { const el = document.getElementById('f-name'); if (el) el.focus(); }, 60);
  }

  function openEdit(id) {
    const p = State.products.find(x => x.id === id);
    if (!p) return;
    State.editingId = id;
    resetForm();
    setEl('form-title', 'Редактировать товар');
    setEl('form-sub',   p.name.slice(0, 50));

    const set = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val ?? ''; };
    set('f-name',  p.name);
    set('f-price', p.price);
    set('f-oldp',  p.oldPrice || '');
    set('f-stock', p.stock ?? '');
    set('f-desc',  p.desc);
    const cat = document.getElementById('f-cat');
    if (cat) cat.value = p.cat || 'bady';
    const ins = document.getElementById('f-instock');
    if (ins) ins.checked = p.inStock !== false;

    // Show existing image from Firebase Storage URL
    const prev  = document.getElementById('img-preview');
    const inner = document.getElementById('upload-inner');
    if (prev && p.imageUrl) {
      prev.src           = p.imageUrl;
      prev.style.display = 'block';
      if (inner) inner.style.display = 'none';
    }

    showEl('btn-del');
    openOverlay('overlay-form');
  }

  function closeForm()       { closeOverlay('overlay-form'); State.editingId = null; }
  function closeFormOuter(e) { if (e.target === document.getElementById('overlay-form')) closeForm(); }

  function handleFile(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { Toast.show('⚠ Только изображения', 'warn'); return; }
    if (file.size > 8 * 1024 * 1024)     { Toast.show('⚠ Файл слишком большой (макс. 8 MB)', 'warn'); return; }
    if (State.pendingURL) URL.revokeObjectURL(State.pendingURL);
    State.pendingBlob = file;
    State.pendingURL  = URL.createObjectURL(file);
    const prev  = document.getElementById('img-preview');
    const inner = document.getElementById('upload-inner');
    if (prev)  { prev.src = State.pendingURL; prev.style.display = 'block'; }
    if (inner) inner.style.display = 'none';
  }

  function validate() {
    let valid = true;
    const rules = [
      { id: 'f-name',  test: v => v.trim().length > 0, msg: 'Введи название товара' },
      { id: 'f-price', test: v => Number(v) > 0,       msg: 'Введи корректную цену' },
    ];
    rules.forEach(({ id, test, msg }) => {
      const el = document.getElementById(id);
      if (!el) return;
      const ok = test(el.value);
      el.classList.toggle('invalid', !ok);
      if (!ok) { Toast.show('⚠ ' + msg, 'warn'); valid = false; }
    });
    return valid;
  }

  /* ── Save (add or update) → Firestore + Storage ── */
  async function save() {
    if (!validate()) return;

    const saveBtn = document.getElementById('btn-del') ? document.querySelector('.btn-save') : null;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ Сохранение…'; }

    try {
      const isNew   = !State.editingId;
      const name    = document.getElementById('f-name').value.trim();
      const price   = Math.max(1, Number(document.getElementById('f-price').value) || 1);
      const oldPrice = Number(document.getElementById('f-oldp').value) || null;
      const cat     = document.getElementById('f-cat').value || 'other';
      const stockV  = document.getElementById('f-stock').value;
      const stock   = stockV !== '' ? Math.max(0, Number(stockV)) : null;
      const desc    = document.getElementById('f-desc').value.trim();
      const inStock = document.getElementById('f-instock').checked;

      const existing   = State.products.find(x => x.id === State.editingId) || {};
      let   imageUrl   = existing.imageUrl || '';

      // Upload new image to Firebase Storage if provided
      if (State.pendingBlob) {
        // Use a temporary ID for new products to upload before creating doc
        const tempId = isNew ? ('tmp_' + Date.now()) : State.editingId;
        Toast.show('📤 Загрузка фото…', 'info', 4000);
        imageUrl = await StorageUpload.uploadImage(tempId, State.pendingBlob);
      }

      const productData = {
        name, price, oldPrice, cat, stock, desc, inStock, imageUrl,
        createdAt: isNew ? Date.now() : (existing.createdAt || Date.now()),
      };

      if (isNew) {
        // addDoc → Firestore generates the ID
        const newProd = await FirestoreDB.addProduct(productData);

        // If we uploaded image with tempId, rename it under real Firestore id
        if (State.pendingBlob && imageUrl) {
          try {
            const realUrl = await StorageUpload.uploadImage(newProd.id, State.pendingBlob);
            await FirestoreDB.updateProduct(newProd.id, { ...productData, imageUrl: realUrl });
            newProd.imageUrl = realUrl;
            // Clean up temp
            await StorageUpload.deleteImage('tmp_' + Date.now());
          } catch { /* non-critical, keep temp url */ }
        }

        State.products.unshift(newProd);
      } else {
        // updateDoc → existing Firestore document
        await FirestoreDB.updateProduct(State.editingId, productData);
        const idx = State.products.findIndex(x => x.id === State.editingId);
        if (idx >= 0) State.products[idx] = { ...existing, ...productData, id: State.editingId };
      }

      closeForm();
      UI.render();
      Toast.show(isNew ? '✓ Товар добавлен в Firestore' : '✓ Изменения сохранены в Firestore', 'success');
      if (State.adminMode) UI.updateAdminStats();

    } catch (err) {
      console.error('Save error:', err);
      Toast.show('✕ Ошибка сохранения: ' + err.message, 'error', 4000);
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 Сохранить'; }
    }
  }

  /* ── Delete product → Firestore + Storage ── */
  async function deleteProduct() {
    if (!State.editingId || !confirm('Удалить этот товар? Действие необратимо.')) return;
    const id = State.editingId;
    try {
      await FirestoreDB.deleteProduct(id);
      await StorageUpload.deleteImage(id);
      State.products = State.products.filter(x => x.id !== id);
      closeForm();
      UI.render();
      Toast.show('🗑 Товар удалён из Firestore', 'warn');
      if (State.adminMode) UI.updateAdminStats();
    } catch (err) {
      console.error('Delete error:', err);
      Toast.show('✕ Ошибка удаления: ' + err.message, 'error', 4000);
    }
  }

  /* ── Quick delete from card ── */
  async function quickDel(id) {
    if (!confirm('Удалить товар?')) return;
    try {
      await FirestoreDB.deleteProduct(id);
      await StorageUpload.deleteImage(id);
      State.products = State.products.filter(x => x.id !== id);
      UI.render();
      Toast.show('🗑 Удалено из Firestore', 'warn');
      if (State.adminMode) UI.updateAdminStats();
    } catch (err) {
      console.error('Quick delete error:', err);
      Toast.show('✕ Ошибка: ' + err.message, 'error', 4000);
    }
  }

  return {
    toggleOrLogin, login, closeLogin, closeLoginOuter,
    openAdd, openEdit, closeForm, closeFormOuter,
    handleFile, save, deleteProduct, quickDel,
  };
})();

/* ============================================================
   App — top-level navigation / search / filter
============================================================ */
const App = (() => {

  function filterCat(cat, el) {
    State.curCat = cat;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    if (el) {
      el.classList.add('active');
    } else {
      const btn = document.querySelector(`[data-cat="${cat}"]`);
      if (btn) btn.classList.add('active');
    }
    UI.render();
  }

  function search(val) {
    State.searchQ = (val || '').trim();
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.classList.toggle('visible', State.searchQ.length > 0);
    UI.render();
  }

  function clearSearch() {
    State.searchQ = '';
    const inp = document.getElementById('search-input');
    if (inp) inp.value = '';
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.classList.remove('visible');
    UI.render();
  }

  function setSort(val) {
    State.sortMode = val;
    UI.render();
  }

  function goHome() {
    filterCat('all', document.querySelector('[data-cat="all"]'));
    clearSearch();
  }

  return { filterCat, search, clearSearch, setSort, goHome };
})();

/* ============================================================
   Drag & drop on upload zone
============================================================ */
(function setupDragDrop() {
  const zone = document.getElementById('upload-zone');
  if (!zone) return;
  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    const file = (e.dataTransfer.files || [])[0];
    if (file && file.type.startsWith('image/')) {
      Admin.handleFile({ target: { files: [file] } });
    }
  });
})();

/* ============================================================
   Keyboard shortcuts
============================================================ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeOverlay('overlay-product');
    closeOverlay('overlay-form');
    closeOverlay('overlay-login');
    closeOverlay('overlay-cart');
    State.modalId = null;
  }
  if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    const inp = document.getElementById('search-input');
    if (inp) inp.focus();
  }
});

/* ============================================================
   INIT — skeleton → loadProducts() from Firestore → render
============================================================ */
(async function init() {
  // Show skeleton while loading from Firestore
  UI.showSkeleton();
  CartUI.updateCount();

  try {
    // ─── MAIN CLOUD LOAD ───────────────────────────────────────
    State.products = await FirestoreDB.loadProducts();
    console.log(`✅ Loaded ${State.products.length} products from Firestore`);
  } catch (err) {
    console.error('Firestore load error:', err);
    Toast.show('⚠ Не удалось загрузить товары. Проверь подключение.', 'error', 5000);
    State.products = [];
  }

  UI.render();
})();

/* ── Expose globals for inline HTML onclick handlers ── */
window.App          = App;
window.Admin        = Admin;
window.CartUI       = CartUI;
window.State        = State;
window.ProductModal = ProductModal;
window.Cart         = Cart;
window.Store        = Store;
