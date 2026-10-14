/**
 * 授权请求里那几项"说得对不对"的纯判断：回调地址、范围、client 名字。
 *
 * 抽成纯函数的理由和 PKCE 一样：**这些规则是安全边界**，
 * 必须能单测，不能埋在路由里靠手工点。
 */

/** MCP 只开放只读工具，所以只有一个范围。 */
export const MCP_SCOPE = "mcp.read";
export const SUPPORTED_SCOPES: readonly string[] = [MCP_SCOPE];

/** 回调地址必须是绝对地址，且只允许 https；本机回环允许 http（本地开发与桌面客户端要用）。 */
export function redirectUriShapeOk(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // 带 #fragment 的回调地址在 OAuth 里没有定义（码只能挂 query），直接拒。
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/**
 * 回调地址**一字不差**才算命中。
 *
 * 不做前缀匹配、不做通配 —— "以注册地址开头"就是开放重定向的经典写法，
 * 攻击者注册 `https://evil.com/x` 之后拿它去骗 `https://evil.com/x.attacker.io`。
 */
export function redirectUriAllowed(registered: readonly string[], candidate: string): boolean {
  return registered.includes(candidate);
}

/** 客户端名字：只用于展示，截断 + 兜底。 */
export function normalizeClientName(value: unknown, fallback = "未命名客户端"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 80);
}

/** 注册时给的 redirect_uris：必须是数组、每项形状合法、去重、上限 10 条。 */
export function normalizeRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text || !redirectUriShapeOk(text)) continue;
    seen.add(text);
    if (seen.size >= 10) break;
  }
  return [...seen];
}

/**
 * 请求里的 scope：空 = 默认给 mcp.read；给了就必须是支持的范围，否则整条请求拒掉
 * （不许"能认的认、不认的丢掉" —— 那样客户端会以为自己拿到了更大的权限）。
 */
export function normalizeScope(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return MCP_SCOPE;
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return MCP_SCOPE;
  if (parts.some((part) => !SUPPORTED_SCOPES.includes(part))) return null;
  return [...new Set(parts)].join(" ");
}
