import { authHeaders } from "@/lib/shared/client/session-token";

/** 会话失效时统一给用户看的一句话；原始错误码（UNAUTHORIZED）不该出现在界面上。 */
export const AUTH_EXPIRED_MESSAGE = "登录已过期，请刷新页面重新登录。";
export const API_READ_TIMEOUT_MS = 30_000;

export function isAuthCode(value: unknown) {
  return typeof value === "string" && value.trim() === "UNAUTHORIZED";
}

/** 把 HTTP 状态与服务端消息翻成给用户看的一句话。 */
export function describeApiError(status: number, raw?: unknown) {
  if (status === 401 || isAuthCode(raw)) return AUTH_EXPIRED_MESSAGE;
  if (typeof raw === "string" && raw.trim()) return raw;
  return `请求失败 (${status})`;
}

/**
 * 统一的 JSON 请求封装：每个请求都带上 `Authorization: Bearer <平台会话令牌>`
 * （2026-10-09 起不再用 cookie），并把服务端返回的 `{ error }` 变成异常。
 *
 * **这里刻意不在 401 时清令牌**：`requireRole("ADMIN")` 对"已登录但不是管理员"也回 401，
 * 清掉就等于把查看者踢下线。令牌该不该作废由 `/api/auth/session` 的 `user: null` 判定
 * （`functional-workbench` 的开机检查），那里才是"这个令牌真的不认了"的唯一信号。
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const read = (init?.method ?? "GET").toUpperCase() === "GET";
  const deadline = new AbortController();
  const timer = read ? setTimeout(() => deadline.abort(), API_READ_TIMEOUT_MS) : null;
  const signal = read ? (init?.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal) : init?.signal;
  try {
    const response = await fetch(url, { ...init, signal, headers: { "Content-Type": "application/json", ...authHeaders(), ...init?.headers } });
    const data = await response.json().catch(() => ({}));
    signal?.throwIfAborted();
    if (!response.ok) {
      const error = new Error(describeApiError(response.status, (data as { error?: unknown }).error)) as Error & { status?: number; payload?: unknown };
      /*
       * 失败也常常带着上下文（典型：写回被拒时逐条说明"哪一处、为什么写不回去"）。
       * 只把那一句话抛出去，界面就没法把明细摊开 —— 所以原样挂在错误上。
       */
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data as T;
  } catch (error) {
    if (deadline.signal.aborted && !init?.signal?.aborted) throw new Error("读取超时（30 秒），请重试。");
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
