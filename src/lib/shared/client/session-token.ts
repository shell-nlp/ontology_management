/**
 * 登录令牌在浏览器这边**存哪儿、怎么带走**。
 *
 * 2026-10-09 用户口径：「完全改为 Authorization」。所以登录态从 HttpOnly Cookie 换成
 * `Authorization: Bearer <平台会话 JWT>` —— 浏览器不会自动带这个头，前端得自己保存、自己附加。
 * 服务端那一半在 `@/lib/auth`（`currentUser()` 只认这个头，不再读 cookie）。
 *
 * **存 localStorage，不存内存**：这个平台是开着多个标签页用的，内存方案一刷新就掉线，
 * 代价太大。要清楚的代价是：**XSS 能读走它**。cookie 的 HttpOnly 是唯一能把凭据从 JS
 * 里藏起来的手段，换成 Bearer 就是拿这一点换 CSRF 免疫 + 调试方便（已经跟用户确认过）。
 * 缓解手段有两条，别拆掉：
 * 1. 令牌仍然 **8 小时过期**（`createSession` 里写死），不是长期有效的 key；
 * 2. 服务端每次请求都回平台库核对用户（`userFromToken`），删用户 / 改权限立刻生效。
 *
 * 这个模块只给浏览器用（`localStorage`），服务端 import 进来会拿到空令牌、不会炸，
 * 但没有任何意义 —— 服务端请用 `@/lib/auth` 的 `bearerToken()`。
 */
const KEY = "ontology.session.token";

/** 当前会话令牌；没登录（或不在浏览器里）就是空串。 */
export function sessionToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    // 隐私模式 / 存储被禁用：当作没登录，别把界面搞崩。
    return "";
  }
}

export function setSessionToken(token: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    // 存不进去就只在本次内存会话里有效不了 —— 这种情况只能提示用户换浏览器，不在这里静默兜底。
  }
}

export function clearSessionToken() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* 同上 */
  }
}

/** 附加到请求上的鉴权头；没登录就返回空对象（服务端会照常回 401）。 */
export function authHeaders(): Record<string, string> {
  const token = sessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** `fetch(url, withAuth({ method: "POST" }))`：在保留调用方自有头的前提下补上鉴权头。 */
export function withAuth(init?: RequestInit): RequestInit {
  return { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...authHeaders() } };
}