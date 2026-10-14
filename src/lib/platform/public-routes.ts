/**
 * 与鉴权有关的两份**纯数据**，放在这里是为了让 Edge 中间件也能读 —— 它跑在 Edge runtime，
 * 不能 import `@/lib/platform/auth`（那里拖着 typeorm / 驱动）。
 *
 * 之所以单独放一份而不是各写一份，是因为"哪些路径不需要令牌"这件事**只能有一处说法**：
 * 中间件按它放行、覆盖测试按它核对，漂移当场红（见 `tests/lib/authz-coverage.test.ts`）。
 */

/** 会话失效时统一给用户看的一句话。`auth.ts` 从这里取，别再定义第二份。 */
export const AUTH_EXPIRED_MESSAGE = "登录已过期，请刷新页面重新登录。";

/**
 * **不需要平台会话令牌**的 API 路径前缀（粗筛名单，只用于"有没有带凭据"这一层）。
 *
 * 注意它**不是权限清单**：这份名单只决定"没有 Authorization 头时要不要直接 401"。
 * "这个接口要哪个权限点"永远只在路由的 `withPermission(...)` 声明一次
 * （中间件拿不到本体/资源，硬判权限点就是第二个真相）。
 *
 * 漏一个的后果是"公开接口被挡成 401"，所以覆盖测试会拿 `withPublic` / `withOwnAuth`
 * 的方法逐个核对这里；多一个的后果只是少了一层提前拒绝，安全上由包装器兜住（fail-safe 的方向是故意选的）。
 */
export const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/bootstrap",
  // OAuth 里按规范必须匿名可达的两个端点（注册不发权限、令牌靠授权码 + PKCE）
  "/api/oauth/authorize",
  "/api/oauth/register",
  "/api/oauth/token",
  // 免令牌的技能 MCP
  "/api/skills/mcp",
  // MCP 端点自带鉴权：同一个 Authorization 头要认两套凭据，交给 mcp-endpoint 判
  "/api/mcp",
] as const;