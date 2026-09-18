/**
 * 这次请求**对外**的地址（协议 + 主机），用来拼给用户复制的绝对 URL。
 *
 * 为什么不直接用 `request.nextUrl.origin`：它落回的是**服务端自己认的** localhost:port，
 * 而用户是从机器 IP、主机名或反向代理后面的域名访问的。于是界面上给出的"MCP 服务地址"
 * 复制出来是 `http://localhost:3001/...` —— 换台机器、发给同事就废了
 * （2026-09-18 用户报的：「不能只是 localhost，要根据前端 url 变化才对」）。
 *
 * 口径与 `sessionCookieSecure` 一致：代理后面看 `x-forwarded-host` / `x-forwarded-proto`
 * （可能是一串，只看第一段），没有就退回这次请求自己的 `host` 与协议。
 * 两者都没有（极少见）才退回 `nextUrl.origin`。
 *
 * 这是**展示/复制用**的地址，不参与任何鉴权判断 —— 别拿它当可信来源做安全决策。
 */
export type OriginRequest = {
  headers: { get(name: string): string | null };
  url: string;
  nextUrl?: { origin: string };
};

function first(value: string | null): string {
  return (value ?? "").split(",")[0]?.trim() ?? "";
}

export function publicOrigin(request: OriginRequest): string {
  const host = first(request.headers.get("x-forwarded-host")) || first(request.headers.get("host"));
  if (!host) return request.nextUrl?.origin ?? new URL(request.url).origin;
  const forwardedProto = first(request.headers.get("x-forwarded-proto")).toLowerCase();
  const protocol = forwardedProto === "https" || forwardedProto === "http"
    ? forwardedProto
    : new URL(request.url).protocol.replace(":", "");
  return `${protocol}://${host}`;
}
