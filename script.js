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

console.log("Firebase Firestore + Storage connected");

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
        Toast.show('Storage переполнен', 'warn');
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
    Toast.show('Кэш очищен', 'warn');
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
  bady:      'БАДы',
  protein:   'Протеин',
  nootropic: 'Ноотропы',
  mushroom:  'Грибы',
  vitamin:   'Витамины',
  amino:     'Аминокислоты',
  fat:       'Жиросжигатели',
  clothes:   'Одежда',
  other:     'Прочее',
};

const CAT_NAMES = {
  all: 'BEST SELLERS',
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
      <div class="empty-ico">${isSearch ? '' : isAdmin ? '' : ''}</div>
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
          : `<div class="p-img-ph" aria-hidden="true"></div>`}
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
    Toast.show('Добавлено в корзину', 'success');
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
    if (!State.payMethod) { Toast.show('Выбери способ оплаты', 'warn'); return; }
    const total   = State.cart.reduce((a, b) => a + b.price * b.qty, 0);
    const methods = { sbp: 'СБП', sber: 'SberPay', visa: 'Visa' };
    alert(
      `✅ Заказ оформлен!\n\n` +
      `Способ: ${methods[State.payMethod]}\n` +
      `Сумма: ${total.toLocaleString('ru')} ₽\n\n` +
      `Свяжитесь с нами: @Mustafa_biohacking`
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
        <div class="cart-empty-ico"></div>
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
          : `<div class="ci-ph"></div>`}
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
    Toast.show('Режим администратора включён', 'info');
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
    if (!file.type.startsWith('image/')) { Toast.show('Только изображения', 'warn'); return; }
    if (file.size > 8 * 1024 * 1024)     { Toast.show('Файл слишком большой', 'warn'); return; }
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
      if (!ok) { Toast.show(msg, 'warn'); valid = false; }
    });
    return valid;
  }

  /* ── Save (add or update) → Firestore + Storage ── */
  async function save() {
    if (!validate()) return;

    const saveBtn = document.getElementById('btn-del') ? document.querySelector('.btn-save') : null;
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Сохранение…'; }

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
        Toast.show('Загрузка фото...', 'info', 4000);
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
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Сохранить'; }
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
      Toast.show('Товар удалён', 'warn');
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
      Toast.show('Удалено', 'warn');
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
    console.log(`Loaded ${State.products.length} products from Firestore`);
  } catch (err) {
    console.error('Firestore load error:', err);
    Toast.show('Не удалось загрузить товары', 'error', 5000);
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

/* ============================================================
   QUIZ — Подбор добавок по вопросам
============================================================ */
const Quiz = (() => {

  const QUESTIONS = [
    {
      id: 'goal',
      title: 'Какова ваша основная цель?',
      multi: false,
      options: [
        { icon: '', label: 'Энергия и бодрость',   value: 'energy',   cats: ['amino', 'bady'] },
        { icon: '', label: 'Фокус и концентрация', value: 'focus',    cats: ['nootropic', 'mushroom'] },
        { icon: '', label: 'Рост мышц и сила',     value: 'muscle',   cats: ['protein', 'amino'] },
        { icon: '', label: 'Иммунитет и здоровье', value: 'immunity', cats: ['vitamin', 'bady'] },
        { icon: '', label: 'Снижение веса',         value: 'fat',      cats: ['fat', 'amino'] },
        { icon: '', label: 'Сон и восстановление',  value: 'sleep',    cats: ['bady', 'mushroom'] },
      ],
    },
    {
      id: 'age',
      title: 'Ваш возраст?',
      multi: false,
      options: [
        { icon: '', label: 'До 25 лет',   value: 'u25',  cats: ['protein', 'amino'] },
        { icon: '', label: '25–35 лет',   value: '25-35',cats: ['nootropic', 'bady'] },
        { icon: '', label: '35–45 лет',   value: '35-45',cats: ['vitamin', 'bady'] },
        { icon: '', label: '45+ лет',     value: '45p',  cats: ['vitamin', 'mushroom'] },
      ],
    },
    {
      id: 'activity',
      title: 'Ваш уровень физической активности?',
      multi: false,
      options: [
        { icon: '', label: 'Минимальный (сидячая работа)', value: 'low',    cats: ['vitamin', 'bady'] },
        { icon: '', label: 'Умеренный (прогулки, йога)',   value: 'medium', cats: ['bady', 'amino'] },
        { icon: '', label: 'Высокий (3–5 тренировок)',     value: 'high',   cats: ['protein', 'amino'] },
        { icon: '', label: 'Профессиональный спорт',       value: 'pro',    cats: ['protein', 'amino', 'fat'] },
      ],
    },
    {
      id: 'problems',
      title: 'Что вас беспокоит больше всего?',
      multi: true,
      options: [
        { icon: '', label: 'Усталость и упадок сил',      value: 'tired',  cats: ['bady', 'amino'] },
        { icon: '', label: 'Снижение памяти и фокуса',    value: 'memory', cats: ['nootropic', 'mushroom'] },
        { icon: '', label: 'Частые простуды',              value: 'ill',    cats: ['vitamin', 'bady'] },
        { icon: '', label: 'Стресс и тревожность',        value: 'stress', cats: ['mushroom', 'bady'] },
        { icon: '', label: 'Проблемы со сном',             value: 'sleep',  cats: ['bady'] },
        { icon: '', label:  'Лишний вес',                  value: 'weight', cats: ['fat'] },
      ],
    },
    {
      id: 'diet',
      title: 'Как вы питаетесь?',
      multi: false,
      options: [
        { icon: '', label: 'Ем всё, включая мясо',        value: 'omni',   cats: ['bady'] },
        { icon: '', label: 'Стараюсь питаться правильно', value: 'healthy',cats: ['vitamin'] },
        { icon: '', label: 'Вегетарианец / веган',        value: 'vegan',  cats: ['vitamin', 'bady', 'protein'] },
        { icon: '', label: 'Спортивное питание',           value: 'sport',  cats: ['protein', 'amino'] },
      ],
    },
  ];

  let currentStep = 0;
  let answers     = {}; // { questionId: [selectedValues] }

  /* ── open / close ── */
  function open() {
    currentStep = 0;
    answers     = {};
    document.getElementById('overlay-quiz').classList.add('show');
    showQuestion();
  }

  function close() {
    document.getElementById('overlay-quiz').classList.remove('show');
  }

  function closeOuter(e) {
    if (e.target === document.getElementById('overlay-quiz')) close();
  }

  /* ── render question ── */
  function showQuestion() {
    const q     = QUESTIONS[currentStep];
    const total = QUESTIONS.length;

    // progress
    const pct = ((currentStep + 1) / total) * 100;
    document.getElementById('quiz-progress-bar').style.width  = pct + '%';
    document.getElementById('quiz-progress-label').textContent = `Шаг ${currentStep + 1} из ${total}`;

    document.getElementById('quiz-q-title').textContent = q.title;

    // options
    const container = document.getElementById('quiz-options');
    container.innerHTML = '';
    const selected = answers[q.id] || [];

    q.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'quiz-option' + (selected.includes(opt.value) ? ' selected' : '');
      btn.innerHTML = `${opt.icon ? `<span class="quiz-option-icon">${opt.icon}</span>` : ''}${opt.label}`;
      btn.onclick = () => toggleOption(q, opt.value, btn);
      container.appendChild(btn);
    });

    // nav
    document.getElementById('quiz-btn-back').disabled = currentStep === 0;
    const nextBtn = document.getElementById('quiz-btn-next');
    nextBtn.textContent = currentStep === total - 1 ? 'Показать результат →' : 'Далее →';

    // screens
    document.getElementById('quiz-questions-screen').style.display = '';
    document.getElementById('quiz-result-screen').style.display    = 'none';
  }

  function toggleOption(q, value, btn) {
    if (!answers[q.id]) answers[q.id] = [];
    const arr = answers[q.id];
    if (q.multi) {
      const idx = arr.indexOf(value);
      if (idx === -1) { arr.push(value); btn.classList.add('selected'); }
      else            { arr.splice(idx,1); btn.classList.remove('selected'); }
    } else {
      answers[q.id] = [value];
      document.querySelectorAll('.quiz-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    }
  }

  function next() {
    const q   = QUESTIONS[currentStep];
    const sel = answers[q.id] || [];
    if (!sel.length) {
      // pick first as default and continue
      answers[q.id] = [q.options[0].value];
    }
    if (currentStep < QUESTIONS.length - 1) {
      currentStep++;
      showQuestion();
    } else {
      showResult();
    }
  }

  function prev() {
    if (currentStep > 0) { currentStep--; showQuestion(); }
  }

  function restart() {
    currentStep = 0;
    answers     = {};
    showQuestion();
  }

  /* ── compute recommended categories ── */
  function getRecommendedCats() {
    const score = {}; // cat → weight
    QUESTIONS.forEach(q => {
      const sel = answers[q.id] || [];
      sel.forEach(val => {
        const opt = q.options.find(o => o.value === val);
        if (opt) {
          opt.cats.forEach(cat => { score[cat] = (score[cat] || 0) + 1; });
        }
      });
    });
    // sort by score descending, take top 3
    return Object.entries(score)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);
  }

  /* ── show results ── */
  function showResult() {
    document.getElementById('quiz-questions-screen').style.display = 'none';
    document.getElementById('quiz-result-screen').style.display    = '';
    document.getElementById('quiz-progress-bar').style.width       = '100%';
    document.getElementById('quiz-progress-label').textContent     = 'Результат готов!';

    const topCats = getRecommendedCats();
    const products = State.products;

    // pick up to 2 products per top category, max 6 total
    let picks = [];
    topCats.forEach(cat => {
      const inCat = products.filter(p => p.cat === cat && p.inStock !== false);
      picks = picks.concat(inCat.slice(0, 2));
    });
    // deduplicate
    const seen = new Set();
    picks = picks.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    picks = picks.slice(0, 6);

    // fallback — show any products
    if (!picks.length) picks = products.slice(0, 6);

    const grid = document.getElementById('quiz-result-grid');
    grid.innerHTML = '';

    if (!picks.length) {
      grid.innerHTML = '<div class="quiz-result-empty">Товары не найдены. Загляни в каталог!</div>';
      return;
    }

    picks.forEach(p => {
      const price = p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '';
      const card  = document.createElement('div');
      card.className = 'quiz-result-card';
      card.innerHTML = `
        <div class="quiz-result-card-img">
          ${p.imageUrl
            ? `<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">`
            : ''}
        </div>
        <div class="quiz-result-card-body">
          <div class="quiz-result-card-price">${price}</div>
          <div class="quiz-result-card-name">${p.name}</div>
          <button class="quiz-result-card-add" onclick="Quiz.addToCart('${p.id}')">+ В корзину</button>
        </div>`;
      card.onclick = e => {
        if (e.target.classList.contains('quiz-result-card-add')) return;
        close();
        ProductModal.open(p.id);
      };
      grid.appendChild(card);
    });
  }

  function addToCart(id) {
    Cart.add(id);
    CartUI.updateCount();
    Toast.show('Добавлено в корзину', 'success');
  }

  return { open, close, closeOuter, next, prev, restart, addToCart };
})();

window.Quiz = Quiz;


/* ============================================================
   INJECT — AI BIOHACKING SYSTEM · JS
   Add this as a <script> block at end of <body> (after
   the existing script.js module tag).

   Exposes global: BioQuiz
   Reads: window.State.products (from script.js)
         window.Cart, window.CartUI, window.Toast
============================================================ */

'use strict';



/* ────────────────────────────────────────────────────────────
   2. BIOQUIZ SYSTEM
──────────────────────────────────────────────────────────── */
const BioQuiz = (() => {

  /* ── Questions ── */
  const QUESTIONS = [
    {
      id: 'energy',
      meta: 'ПАРАМЕТР 01 · ЭНЕРГИЯ',
      title: 'Каков ваш уровень энергии в течение дня?',
      options: [
        { icon: '', text: 'Высокий — всегда в тонусе', value: 'high',    cats: ['nootropic','vitamin'] },
        { icon: '🔋', text: 'Средний — бывают спады',   value: 'medium',  cats: ['bady','vitamin'] },
        { icon: '', text: 'Низкий — постоянная усталость', value: 'low', cats: ['bady','amino'] },
        { icon: '☕', text: 'Только на кофеине',         value: 'caffeine',cats: ['nootropic','amino'] },
      ],
    },
    {
      id: 'sleep',
      meta: 'ПАРАМЕТР 02 · СОН',
      title: 'Есть ли у вас проблемы со сном?',
      options: [
        { icon: '', text: 'Сплю отлично',               value: 'great',   cats: ['vitamin'] },
        { icon: '🌙', text: 'Иногда сложно заснуть',      value: 'sometimes',cats: ['bady','mushroom'] },
        { icon: '', text: 'Хронические проблемы со сном',value: 'chronic', cats: ['bady','mushroom'] },
        { icon: '🔄', text: 'Сбитый режим',               value: 'irregular',cats: ['vitamin','bady'] },
      ],
    },
    {
      id: 'anxiety',
      meta: 'ПАРАМЕТР 03 · СТРЕСС',
      title: 'Бывает ли у вас тревожность или раздражительность?',
      options: [
        { icon: '😌', text: 'Нет, всё спокойно',          value: 'none',   cats: ['vitamin'] },
        { icon: '😤', text: 'Иногда',                     value: 'sometimes',cats: ['bady','mushroom'] },
        { icon: '', text: 'Часто, сложно расслабиться', value: 'often',  cats: ['bady','mushroom'] },
        { icon: '🌀', text: 'Хронический стресс',         value: 'chronic',cats: ['mushroom','nootropic'] },
      ],
    },
    {
      id: 'focus',
      meta: 'ПАРАМЕТР 04 · КОНЦЕНТРАЦИЯ',
      title: 'Есть ли проблемы с концентрацией и фокусом?',
      options: [
        { icon: '🎯', text: 'Отличный фокус',              value: 'great',  cats: ['vitamin'] },
        { icon: '🔍', text: 'Умеренные трудности',         value: 'moderate',cats: ['nootropic'] },
        { icon: '🌫️', text: 'Мозговой туман постоянно',   value: 'fog',    cats: ['nootropic','mushroom'] },
        { icon: '📱', text: 'Постоянно отвлекаюсь',       value: 'distracted',cats: ['nootropic','amino'] },
      ],
    },
    {
      id: 'sport',
      meta: 'ПАРАМЕТР 05 · ФИЗИЧЕСКАЯ АКТИВНОСТЬ',
      title: 'Насколько активно вы занимаетесь спортом?',
      options: [
        { icon: '🏃', text: 'Каждый день',                value: 'daily',  cats: ['protein','amino'] },
        { icon: '', text: '3–4 раза в неделю',          value: 'regular',cats: ['protein','amino'] },
        { icon: '', text: 'Иногда, 1–2 раза',           value: 'light',  cats: ['vitamin','bady'] },
        { icon: '💼', text: 'Практически не занимаюсь',   value: 'none',   cats: ['vitamin','fat'] },
      ],
    },
    {
      id: 'recovery',
      meta: 'ПАРАМЕТР 06 · ВОССТАНОВЛЕНИЕ',
      title: 'Как быстро вы восстанавливаетесь после нагрузок?',
      options: [
        { icon: '🚀', text: 'Очень быстро',               value: 'fast',   cats: ['protein'] },
        { icon: '👍', text: 'Нормально',                  value: 'ok',     cats: ['protein','amino'] },
        { icon: '🐢', text: 'Медленно, мышцы болят долго',value: 'slow',   cats: ['amino','bady'] },
        { icon: '❌', text: 'Почти не восстанавливаюсь',  value: 'poor',   cats: ['amino','bady','vitamin'] },
      ],
    },
    {
      id: 'morning',
      meta: 'ПАРАМЕТР 07 · УТРО',
      title: 'Как вы себя чувствуете утром после сна?',
      options: [
        { icon: '☀️', text: 'Бодро и свежо',              value: 'fresh',  cats: ['vitamin'] },
        { icon: '🥱', text: 'Нужно время проснуться',      value: 'slow',   cats: ['bady'] },
        { icon: '😩', text: 'Усталость не уходит',         value: 'tired',  cats: ['bady','mushroom'] },
        { icon: '🤕', text: 'Тяжело встать, всё болит',    value: 'awful',  cats: ['amino','bady','mushroom'] },
      ],
    },
    {
      id: 'weight',
      meta: 'ПАРАМЕТР 08 · МЕТАБОЛИЗМ',
      title: 'Есть ли у вас цели по контролю веса или составу тела?',
      options: [
        { icon: '', text: 'Хочу сжечь жир',             value: 'burn',   cats: ['fat','amino'] },
        { icon: '', text: 'Набрать мышечную массу',      value: 'muscle', cats: ['protein','amino'] },
        { icon: '⚖️', text: 'Поддержать текущий вес',     value: 'maintain',cats: ['protein','vitamin'] },
        { icon: '✨', text: 'Только здоровье, не вес',     value: 'health', cats: ['bady','vitamin','mushroom'] },
      ],
    },
    {
      id: 'immunity',
      meta: 'ПАРАМЕТР 09 · ИММУНИТЕТ',
      title: 'Как часто вы болеете или чувствуете снижение иммунитета?',
      options: [
        { icon: '🛡️', text: 'Редко болею',               value: 'strong', cats: ['vitamin'] },
        { icon: '🤧', text: 'Иногда, пару раз в год',     value: 'moderate',cats: ['vitamin','mushroom'] },
        { icon: '😷', text: 'Довольно часто',              value: 'weak',   cats: ['vitamin','mushroom','bady'] },
        { icon: '💊', text: 'Постоянно что-то беспокоит', value: 'poor',   cats: ['vitamin','mushroom','bady'] },
      ],
    },
  ];

  /* ── Static fallback product recommendations ── */
  const FALLBACK_RECS = [
    {
      cats: ['nootropic','mushroom'],
      name: 'Alpha GPC',
      why: 'Усиливает ацетилхолин — нейромедиатор памяти и фокуса',
      emoji: '🧠',
    },
    {
      cats: ['bady','mushroom'],
      name: 'Ashwagandha',
      why: 'Снижает кортизол, улучшает стрессоустойчивость и сон',
      emoji: '🌿',
    },
    {
      cats: ['bady','vitamin'],
      name: 'NAC (N-ацетил-цистеин)',
      why: 'Мощный антиоксидант, поддерживает синтез глутатиона',
      emoji: '⚗️',
    },
    {
      cats: ['protein','amino'],
      name: 'Магний глицинат',
      why: 'Улучшает сон, снижает мышечное напряжение',
      emoji: '💎',
    },
    {
      cats: ['fat','amino'],
      name: 'L-карнитин',
      why: 'Транспортирует жиры в митохондрии — топливо для энергии',
      emoji: '🔥',
    },
    {
      cats: ['vitamin'],
      name: 'Витамин D3+K2',
      why: 'Иммунитет, гормоны, здоровье костей и настроение',
      emoji: '☀️',
    },
  ];

  /* ── Biomarker profile (result cards) ── */
  const BIOMARKERS = [
    { key: 'cortisol',   label: 'Кортизол',         unit: '%', color: '#fb923c' },
    { key: 'energy',     label: 'Энергия',           unit: '%', color: '#a8ff3e' },
    { key: 'focus',      label: 'Фокус',             unit: '%', color: '#4f8cff' },
    { key: 'sleep',      label: 'Sleep Quality',     unit: '%', color: '#00e5c3' },
    { key: 'stress',     label: 'Stress Level',      unit: '%', color: '#f87171' },
    { key: 'recovery',   label: 'Recovery',          unit: '%', color: '#a8ff3e' },
    { key: 'cognitive',  label: 'Cognitive Perf.',   unit: '%', color: '#c084fc' },
  ];

  /* ── State ── */
  let currentStep = 0;
  let answers     = {};

  /* ── DOM refs ── */
  const overlay    = () => document.getElementById('bq-overlay');
  const quizScreen = () => document.getElementById('bq-quiz-screen');
  const resScreen  = () => document.getElementById('bq-result-screen');
  const progressFill = () => document.getElementById('bq-progress-fill');
  const stepLabel  = () => document.getElementById('bq-step-label');

  /* ── Open / Close ── */
  function open() {
    currentStep = 0;
    answers     = {};
    overlay().classList.add('open');
    document.body.style.overflow = 'hidden';
    showQuestion();
    spawnParticles();
  }

  function close() {
    overlay().classList.remove('open');
    document.body.style.overflow = '';
  }

  function closeOuter(e) {
    if (e.target === overlay()) close();
  }

  /* ── Progress ── */
  function updateProgress(step, total) {
    const pct = Math.round((step / total) * 100);
    progressFill().style.width = pct + '%';
    const padded = String(step + 1).padStart(2, '0');
    const tot    = String(total).padStart(2, '0');
    stepLabel().textContent = `ИНИЦИАЛИЗАЦИЯ · МОДУЛЬ ${padded}/${tot}`;
  }

  /* ── Render question ── */
  function showQuestion() {
    const q = QUESTIONS[currentStep];
    quizScreen().style.display = '';
    resScreen().style.display  = 'none';

    // meta + title
    document.getElementById('bq-q-meta').textContent  = q.meta;
    document.getElementById('bq-q-title').textContent = q.title;

    // trigger re-animation
    const titleEl = document.getElementById('bq-q-title');
    titleEl.style.animation = 'none';
    void titleEl.offsetWidth;
    titleEl.style.animation = '';

    // options
    const container = document.getElementById('bq-options');
    container.innerHTML = '';
    const saved = answers[q.id] || [];

    q.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'bq-option' + (saved.includes(opt.value) ? ' selected' : '');
      btn.innerHTML = `
        ${opt.icon ? `<span class="bq-opt-icon" aria-hidden="true">${opt.icon}</span>` : ''}
        <span>${opt.text}</span>
        <span class="bq-opt-check" aria-hidden="true"></span>
      `;
      btn.addEventListener('click', () => {
        // Single-select per question
        container.querySelectorAll('.bq-option').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        answers[q.id] = [opt.value];
      });
      container.appendChild(btn);
    });

    // Nav state
    const backBtn = document.getElementById('bq-nav-back');
    const nextBtn = document.getElementById('bq-nav-next');
    backBtn.disabled = (currentStep === 0);
    nextBtn.textContent = (currentStep === QUESTIONS.length - 1) ? 'Получить анализ ✓' : 'Далее';
    if (currentStep === QUESTIONS.length - 1) {
      nextBtn.insertAdjacentHTML('beforeend', '');
    }

    updateProgress(currentStep, QUESTIONS.length);
  }

  /* ── Navigation ── */
  function next() {
    if (currentStep < QUESTIONS.length - 1) {
      currentStep++;
      showQuestion();
    } else {
      showResults();
    }
  }

  function prev() {
    if (currentStep > 0) {
      currentStep--;
      showQuestion();
    }
  }

  function restart() {
    currentStep = 0;
    answers     = {};
    quizScreen().style.display = '';
    resScreen().style.display  = 'none';
    showQuestion();
  }

  /* ── Compute scores from answers ── */
  function computeBiomarkers() {
    // Base scores
    const scores = {
      cortisol:  50,
      energy:    50,
      focus:     50,
      sleep:     50,
      stress:    50,
      recovery:  50,
      cognitive: 50,
    };

    // Map answers → adjustments
    const rules = {
      energy: {
        high:     { energy:+30, cognitive:+15 },
        medium:   { energy:+10 },
        low:      { energy:-20, cortisol:+15, stress:+10 },
        caffeine: { energy:+5,  cortisol:+20 },
      },
      sleep: {
        great:    { sleep:+35, recovery:+15, stress:-15 },
        sometimes:{ sleep:+5 },
        chronic:  { sleep:-25, cortisol:+20, cognitive:-15, stress:+15 },
        irregular:{ sleep:-10, cortisol:+10 },
      },
      anxiety: {
        none:    { stress:-20, cortisol:-10 },
        sometimes:{ stress:+10 },
        often:   { stress:+25, cortisol:+20, cognitive:-10 },
        chronic: { stress:+35, cortisol:+30, cognitive:-20, sleep:-15 },
      },
      focus: {
        great:   { focus:+30, cognitive:+20 },
        moderate:{ focus:+5,  cognitive:+5 },
        fog:     { focus:-25, cognitive:-20, energy:-10 },
        distracted:{ focus:-15, cognitive:-10 },
      },
      sport: {
        daily:   { energy:+20, recovery:+25, cortisol:-10 },
        regular: { energy:+15, recovery:+15 },
        light:   { energy:+5  },
        none:    { energy:-10, recovery:-15 },
      },
      recovery: {
        fast: { recovery:+30, energy:+10 },
        ok:   { recovery:+10 },
        slow: { recovery:-20, energy:-10 },
        poor: { recovery:-30, energy:-20, cortisol:+15 },
      },
      morning: {
        fresh: { sleep:+20, energy:+15 },
        slow:  { sleep:-5  },
        tired: { sleep:-20, energy:-15, cortisol:+10 },
        awful: { sleep:-30, energy:-25, cortisol:+20, stress:+15 },
      },
      immunity: {
        strong:   { energy:+10 },
        moderate: {},
        weak:     { energy:-10, recovery:-10 },
        poor:     { energy:-20, recovery:-20 },
      },
    };

    QUESTIONS.forEach(q => {
      const sel = answers[q.id];
      if (!sel || !sel.length) return;
      const val = sel[0];
      const adj = rules[q.id]?.[val] || {};
      Object.entries(adj).forEach(([k, delta]) => {
        scores[k] = Math.max(5, Math.min(98, scores[k] + delta));
      });
    });

    return scores;
  }

  /* ── Status label helper ── */
  function statusLabel(score) {
    if (score >= 80) return { text: 'OPTIMAL',  color: '#a8ff3e' };
    if (score >= 60) return { text: 'GOOD',     color: '#00e5c3' };
    if (score >= 40) return { text: 'NORMAL',   color: '#4f8cff' };
    if (score >= 25) return { text: 'LOW',      color: '#fb923c' };
    return               { text: 'CRITICAL',  color: '#f87171' };
  }

  /* ── Show results ── */
  function showResults() {
    quizScreen().style.display = 'none';
    resScreen().style.display  = '';
    progressFill().style.width = '100%';
    stepLabel().textContent    = 'АНАЛИЗ ЗАВЕРШЁН · ПРОФИЛЬ ГОТОВ';

    const scores = computeBiomarkers();

    // Biomarker cards
    const bioGrid = document.getElementById('bq-bio-grid');
    bioGrid.innerHTML = '';
    BIOMARKERS.forEach((bm, idx) => {
      const val = Math.round(scores[bm.key] || 50);
      const st  = statusLabel(val);
      const card = document.createElement('div');
      card.className = 'bq-bio-card';
      card.style.setProperty('--ci', idx);
      card.innerHTML = `
        <div class="bq-bio-card-top">
          <div class="bq-bio-card-name">${bm.label}</div>
          <div class="bq-bio-card-status" style="color:${st.color};background:${st.color}18">${st.text}</div>
        </div>
        <div class="bq-bio-card-value" style="color:${st.color}">${val}<small style="font-size:14px;opacity:.6">${bm.unit}</small></div>
        <div class="bq-bio-bar-wrap">
          <div class="bq-bio-bar" data-val="${val}"
               style="background:${bm.color};box-shadow:0 0 8px ${bm.color}60"></div>
        </div>
      `;
      bioGrid.appendChild(card);
    });

    // Animate bars
    setTimeout(() => {
      bioGrid.querySelectorAll('.bq-bio-bar').forEach(bar => {
        bar.style.width = (bar.dataset.val || 50) + '%';
      });
    }, 120);

    // Recommendations
    renderRecommendations(scores);

    // Scroll to top of modal
    overlay().querySelector('.bq-modal').scrollTop = 0;
  }

  /* ── Render recommendations ── */
  function renderRecommendations(scores) {
    const grid = document.getElementById('bq-recs-grid');
    grid.innerHTML = '';

    // Try to get real products from State
    let picks = [];
    try {
      const products = (window.State && window.State.products) ? window.State.products : [];
      const topCats = getTopCats();
      topCats.forEach(cat => {
        const inCat = products.filter(p => p.cat === cat && p.inStock !== false);
        picks = picks.concat(inCat.slice(0, 2));
      });
      // deduplicate
      const seen = new Set();
      picks = picks.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
      picks = picks.slice(0, 6);
    } catch (e) { picks = []; }

    if (picks.length > 0) {
      // Real product cards
      picks.forEach((p, ri) => {
        const price = p.price ? p.price.toLocaleString('ru-RU') + ' ₽' : '';
        const card  = document.createElement('div');
        card.className = 'bq-rec-card';
        card.style.setProperty('--ri', ri);
        card.innerHTML = `
          <div class="bq-rec-card-img">
            ${p.imageUrl
              ? `<img src="${p.imageUrl}" alt="${p.name}" loading="lazy">`
              : ''}
          </div>
          <div class="bq-rec-card-body">
            <div class="bq-rec-card-tag">РЕКОМЕНДОВАНО AI</div>
            <div class="bq-rec-card-name">${p.name}</div>
            <div class="bq-rec-card-price">${price}</div>
            <button class="bq-rec-card-add"
                    onclick="BioQuiz.addToCart('${p.id}');event.stopPropagation()">
              + В корзину
            </button>
          </div>
        `;
        card.addEventListener('click', e => {
          if (e.target.classList.contains('bq-rec-card-add')) return;
          close();
          if (window.ProductModal) window.ProductModal.open(p.id);
        });
        grid.appendChild(card);
      });
    } else {
      // Fallback: static supplement recommendations
      // Choose top 3 based on low biomarker scores
      const lowKeys = Object.entries(scores)
        .sort((a,b) => a[1] - b[1])
        .slice(0, 3)
        .map(e => e[0]);

      // Map low keys to fallback supplement categories
      const keyToCat = {
        cortisol: ['bady','mushroom'],
        energy:   ['bady','amino'],
        focus:    ['nootropic','mushroom'],
        sleep:    ['bady','mushroom'],
        stress:   ['mushroom','bady'],
        recovery: ['amino','protein'],
        cognitive:['nootropic'],
      };

      const neededCats = new Set();
      lowKeys.forEach(k => {
        (keyToCat[k] || []).forEach(c => neededCats.add(c));
      });

      const filtered = FALLBACK_RECS.filter(r =>
        r.cats.some(c => neededCats.has(c))
      ).slice(0, 4);

      const shown = filtered.length ? filtered : FALLBACK_RECS.slice(0, 3);

      shown.forEach((r, ri) => {
        const card = document.createElement('div');
        card.className = 'bq-rec-default';
        card.style.setProperty('--ri', ri);
        card.style.animation = `fadeUp 0.5s var(--ease) ${ri*0.07}s both`;
        card.innerHTML = `
          <div class="bq-rec-default-name">${r.name}</div>
          <div class="bq-rec-default-why">${r.why}</div>
        `;
        grid.appendChild(card);
      });
    }
  }

  /* ── Compute top product categories from answers ── */
  function getTopCats() {
    const score = {};
    QUESTIONS.forEach(q => {
      const sel = answers[q.id] || [];
      sel.forEach(val => {
        const opt = q.options.find(o => o.value === val);
        if (opt) {
          opt.cats.forEach(cat => { score[cat] = (score[cat] || 0) + 1; });
        }
      });
    });
    return Object.entries(score)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(e => e[0]);
  }

  /* ── Add to cart helper ── */
  function addToCart(id) {
    if (window.Cart) {
      window.Cart.add(id);
      if (window.CartUI) window.CartUI.updateCount();
      if (window.Toast)  window.Toast.show('Добавлено в корзину', 'success');
    }
  }

  /* ── Particles ── */
  function spawnParticles() {
    const container = document.getElementById('bq-particles');
    if (!container) return;
    container.innerHTML = '';
    const count = 16;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'bq-particle';
      const size = Math.random() * 2.5 + 0.8;
      el.style.cssText = `
        left: ${Math.random() * 100}%;
        bottom: -10px;
        width: ${size}px;
        height: ${size}px;
        opacity: ${Math.random() * 0.5 + 0.15};
        animation-duration: ${Math.random() * 12 + 6}s;
        animation-delay: ${Math.random() * 8}s;
      `;
      container.appendChild(el);
    }
  }

  /* ── Close on Escape ── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay().classList.contains('open')) close();
  });

  /* ── Close on overlay click ── */
  document.addEventListener('click', e => {
    if (e.target === overlay()) close();
  });

  return { open, close, closeOuter, next, prev, restart, addToCart };
})();

window.BioQuiz = BioQuiz;
