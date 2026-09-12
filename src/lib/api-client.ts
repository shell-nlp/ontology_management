/** 会话失效时统一给用户看的一句话；原始错误码（UNAUTHORIZED）不该出现在界面上。 */
export const AUTH_EXPIRED_MESSAGE = "登录已过期，请刷新页面重新登录。";

export function isAuthCode(value: unknown) {
  return typeof value === "string" && value.trim() === "UNAUTHORIZED";
}

/** 把 HTTP 状态与服务端消息翻成给用户看的一句话。 */
export function describeApiError(status: number, raw?: unknown) {
  if (status === 401 || isAuthCode(raw)) return AUTH_EXPIRED_MESSAGE;
  if (typeof raw === "string" && raw.trim()) return raw;
  return `请求失败 (${status})`;
}

/** 统一的 JSON 请求封装：把服务端返回的 { error } 变成异常，界面直接展示 message。 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(describeApiError(response.status, (data as { error?: unknown }).error));
  return data as T;
}
