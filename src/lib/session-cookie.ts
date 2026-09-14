/**
 * 会话 cookie 的 Secure 标志该不该打开。
 *
 * **不能只看 `NODE_ENV === "production"`**：容器/服务器部署里 `NODE_ENV` 恒为 production，
 * 但很常见的两种形态是"直接用 http 暴露"和"前面挂一层做 TLS 终止的反向代理"。只看 NODE_ENV
 * 就会在 http 上发一个带 Secure 的 cookie，浏览器**直接丢掉** —— 表现是"登录成功了一下，
 * 马上又被踢回登录页"（2026-09-14 用户报的：用 localhost 能进，用机器 IP 就进不去，
 * 因为浏览器把 localhost 当安全源、机器 IP 不当）。
 *
 * 口径：看**这次请求实际是不是 https**（代理后面看 `x-forwarded-proto`），
 * 并允许 `AUTH_COOKIE_SECURE` 显式覆盖成 "true" / "false"（前端是 https、但代理没带头的场景）。
 */
export function sessionCookieSecure(input: {
  /** 反向代理传的 `x-forwarded-proto`，可能是一串（`https, http`），只看第一段。 */
  forwardedProto?: string | null;
  /** 请求本身的协议，形如 `http:` / `https:`。 */
  protocol?: string;
  /** `AUTH_COOKIE_SECURE`：填了就以它为准。 */
  override?: string | null;
}): boolean {
  const override = (input.override ?? "").trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  const forwarded = (input.forwardedProto ?? "").split(",")[0]?.trim().toLowerCase();
  return forwarded === "https" || input.protocol === "https:";
}
