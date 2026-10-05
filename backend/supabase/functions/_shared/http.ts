// Общие утилиты HTTP для admin-функций: CORS, JSON-ответы, типизированные ошибки.
// Никаких зависимостей кроме std — функция должна стартовать холодной за миллисекунды.

export const ALLOWED_ORIGINS: readonly string[] = (Deno.env.get("ADMIN_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0
    ? origin || "*"
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

export function json(req: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Ошибка с HTTP-кодом. Текст message уходит клиенту и показывается в toast.
 * headers — для ответов, которым нужен служебный заголовок (429 + Retry-After).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(req: Request, err: unknown): Response {
  if (err instanceof HttpError) {
    return json(req, { success: false, code: err.code, message: err.message }, err.status, err.headers);
  }
  // Внутренние детали наружу не отдаём, но пишем в лог функции.
  console.error("[admin] unhandled", err);
  return json(req, { success: false, code: "internal_error", message: "Внутренняя ошибка сервера" }, 500);
}

/** Замер длительности внешнего вызова: latency попадает в health-ответ. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error: string | null }> {
  const started = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - started), error: null };
  } catch (err) {
    return { value: null, ms: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Единый бюджет на любой внешний вызов (Graph API, Bot API, edge-probe).
 * DEFAULT — то, что используется, если вызывающий не указал таймаут;
 * MAX — жёсткий потолок: даже если кто-то передаст 30_000, будет 9_000.
 * Причина: admin-роут должен ответить, даже когда сторонний сервис висит.
 */
export const EXTERNAL_TIMEOUT_DEFAULT_MS = 5000;
export const EXTERNAL_TIMEOUT_MAX_MS = 9000;

/** fetch с жёстким AbortController — иначе зависший провайдер держит весь роут. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = EXTERNAL_TIMEOUT_DEFAULT_MS,
): Promise<Response> {
  const budget = Math.min(Math.max(500, timeoutMs), EXTERNAL_TIMEOUT_MAX_MS);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  // Уважаем и внешний signal вызывающего (если он есть), и свой таймаут.
  const upstream = init.signal;
  if (upstream) {
    if (upstream.aborted) ctrl.abort();
    else upstream.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    // AbortError без пояснения выглядит в UI как «неизвестная ошибка» —
    // подменяем на явный текст с бюджетом, он уходит в last_error и в toast.
    const name = (err as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      throw new Error(`Таймаут ${budget} мс: ${host} не ответил`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Потолок на группу операций (напр. все health-пробы) — Promise.race с таймером. */
export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: number | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
