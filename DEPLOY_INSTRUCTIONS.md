# 🔥 Переход на Firebase Firestore — Инструкция

## Что изменилось в архитектуре

```
БЫЛО:  Админка → localStorage/IndexedDB → только этот браузер
СТАЛО: Админка → Firestore + Storage → все браузеры, телефоны, инкогнито
```

---

## 1. Файлы для замены

Скопируй эти файлы в корень своего проекта:
- `script.js` — полностью переписан
- `firebase.json` — добавлены секции firestore + storage
- `firestore.rules` — правила безопасности Firestore
- `storage.rules` — правила безопасности Storage

---

## 2. Включить Firebase Storage в консоли

Обязательный шаг — без этого картинки не загрузятся:

1. Зайди на https://console.firebase.google.com
2. Выбери проект **bymustafa-store**
3. В левом меню → **Build → Storage**
4. Нажми **Get started** → выбери регион (europe-west1 рекомендуется)
5. Дождись активации

---

## 3. Создать коллекцию products в Firestore

1. В консоли Firebase → **Build → Firestore Database**
2. Если база ещё не создана → **Create database** → выбери **Production mode**
3. Регион: **europe-west1**
4. Коллекция создастся автоматически при первом добавлении товара из админки

Структура документа в Firestore:
```json
{
  "name":      "Магний бисглицинат",
  "price":     1200,
  "oldPrice":  2500,
  "cat":       "bady",
  "stock":     50,
  "desc":      "Описание товара...",
  "inStock":   true,
  "imageUrl":  "https://firebasestorage.googleapis.com/...",
  "createdAt": 1715000000000
}
```

---

## 4. Деплой

```bash
# Из корня проекта (где лежит firebase.json)

# Задеплоить всё (хостинг + правила Firestore + правила Storage)
firebase deploy

# Или по отдельности:
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only storage
```

---

## 5. Проверка после деплоя

Открой сайт и убедись что:
- [ ] Товары загружаются из Firestore (в консоли браузера: "Loaded N products from Firestore")
- [ ] В новом браузере — те же товары
- [ ] В режиме инкогнито — те же товары
- [ ] На телефоне — те же товары
- [ ] Добавление товара в админке → появляется после refresh у всех

---

## 6. Что осталось в localStorage

Только **корзина** (ключ `bm_cart`). Это правильно — у каждого пользователя своя корзина.
Старые ключи `bm_products` можно удалить вручную через DevTools → Application → localStorage → Clear.

---

## 7. Важные изменения в коде

| Было | Стало |
|------|-------|
| `p.id` — число (Date.now()) | `p.id` — строка (Firestore doc ID) |
| Изображения в IndexedDB | Изображения в Firebase Storage (HTTPS URL) |
| `Store.loadProducts()` из LS | `FirestoreDB.loadProducts()` из Firestore |
| `Store.saveProducts()` в LS | `FirestoreDB.addProduct()` / `updateProduct()` |
| `IDB.set()` / `IDB.get()` | `StorageUpload.uploadImage()` → URL |

---

## 8. Дальнейшее улучшение безопасности (опционально)

Сейчас правила разрешают запись всем. Для production рекомендуется:
1. Добавить Firebase Authentication (Email/Password)
2. Изменить правила:
```
allow write: if request.auth != null && request.auth.token.admin == true;
```
