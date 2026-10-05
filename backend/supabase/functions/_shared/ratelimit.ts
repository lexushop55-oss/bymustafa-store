// Rate limiting для критических admin-методов (impersonate, reconnect).
//
// Двухуровневая схема:
//   1) in-memory — отсекает флуд внутри одного изолята бесплатно, без обращения к БД;
//   2) Postgres — единый счётчик для всех изолятов/регионов (Edge Functions
//      масштабируются горизонтально, поэтому память одного инстанса не защита).
//
// Политика fail-closed для мутирующих методов: если БД-счётчик недоступен,
// решение принимает in-memory лимит, и запрос НЕ пропускается автоматически
// при явном превышении локального окна.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { HttpError } from "./http.ts";

export interface LimitRule {
  /** Стабильный ключ: действие + актор (+ цель). Не содержит секретов. */
  key: string;
  /** Максимум вызовов в окне. */
  max: number;
  /** Длина окна, сек. */
  windowSeconds: number;
  /** Минимальный интервал между двумя вызовами, сек (антидребезг кнопки). */
  minIntervalSeconds?: number;
  /** Текст для toast. */
  message?: string;
}

interface LocalEntry {
  windowStart: number;
  hits: number;
  lastHit: number;
}

const local = new Map<string, LocalEntry>();

function localCheck(rule: LimitRule, now = Date.now()): { allowed: boolean; retryAfter: number } {
  const windowMs = rule.windowSeconds * 1000;
  const minMs = (rule.minIntervalSeconds ?? 0) * 1000;
  let e = local.get(rule.key);
  if (!e || now - e.windowStart >= windowMs) {
    e = { windowStart: now, hits: 0, lastHit: 0 };
    local.set(rule.key, e);
  }
  if (minMs && e.lastHit && now - e.lastHit < minMs) {
    return { allowed: false, retryAfter: Math.ceil((minMs - (now - e.lastHit)) / 1000) };
  }
  if (e.hits >= rule.max) {
    return { allowed: false, retryAfter: Math.ceil((e.windowStart + windowMs - now) / 1000) };
  }
  e.hits += 1;
  e.lastHit = now;
  // Карта не должна расти бесконечно в долгоживущем изоляте.
  if (local.size > 500) {
    for (const [k, v] of local) if (now - v.windowStart > windowMs * 2) local.delete(k);
  }
  return { allowed: true, retryAfter: 0 };
}

/**
 * Проверяет и сразу инкрементирует счётчик. Бросает HttpError 429
 * с Retry-After, если лимит или минимальный интервал нарушены.
 */
export async function enforceRateLimit(db: SupabaseClient, rule: LimitRule): Promise<void> {
  const localRes = localCheck(rule);
  if (!localRes.allowed) throw tooMany(rule, localRes.retryAfter);

  const { data, error } = await db.rpc("admin_rate_limit_hit", {
    p_key: rule.key,
    p_max: rule.max,
    p_window_seconds: rule.windowSeconds,
    p_min_interval_seconds: rule.minIntervalSeconds ?? 0,
  });

  if (error) {
    // БД-счётчик недоступен: не блокируем работу админа полностью,
    // но фиксируем — локальное окно уже отработало выше.
    console.error("[admin] rate limit rpc failed", rule.key, error.message);
    return;
  }

  const res = (data ?? {}) as { allowed?: boolean; retry_after?: number };
  if (res.allowed === false) throw tooMany(rule, Math.max(1, Number(res.retry_after ?? 1)));
}

function tooMany(rule: LimitRule, retryAfter: number): HttpError {
  const msg = rule.message ?? `Слишком часто. Повторите через ${retryAfter} с`;
  return new HttpError(429, `${msg} (повтор через ${retryAfter} с)`, "rate_limited", {
    "retry-after": String(retryAfter),
    "x-ratelimit-limit": String(rule.max),
    "x-ratelimit-window": String(rule.windowSeconds),
  });
}
