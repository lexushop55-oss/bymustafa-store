// Настройки подключения. Заполняется при деплое; anon-ключ публичный по замыслу
// Supabase (доступ ограничивает RLS). Ключ service_role сюда НЕ кладётся никогда.
// Пустые значения = демо-режим: данные и учётные записи живут в этом браузере.
window.DENTALINE_CONFIG = Object.assign({
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Адрес admin-функции для кабинета разработчика (POST /tenants и т.д.).
  adminApiBase: ''
}, window.DENTALINE_CONFIG || {});
