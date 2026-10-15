import { NextResponse, type NextRequest } from "next/server";
import { AUTH_EXPIRED_MESSAGE, PUBLIC_API_PREFIXES } from "@/lib/platform/public-routes";

/**
 * 文件名是 `proxy.ts`（不是 `middleware.ts`）：Next 16 把 middleware 这个约定改名成 proxy，
 * 行为完全一样，只是名字 —— 看到 "proxy" 别以为是反向代理配置。
 *
 * 粗筛：**只判"有没有带凭据"，一个权限点都不判**（2026-10-14）。
 *
 * 分工（对齐 PDP / PEP）：
 * - 这一层是**最外层的 PEP**：没带 `Authorization: Bearer` 的 `/api/**` 直接回 401，
 *   省掉一次路由调用与一次会话查询；
 * - **权限点在路由的 `withPermission(...)` 里判一次**（`lib/platform/route-guard.ts`）。
 *   中间件拿不到"这个请求要动哪个本体 / 哪个资源"，也拿不到 handler 的声明；
 *   在这里硬造一张"路径 → 权限点"表就是第二个真相，漂移的后果是权限洞或误拒。
 * - 所以这里**只认"有没有令牌"**：令牌对不对、有没有权限，都留给后面的层。
 *
 * 公开路径与那句提示语都来自 `@/lib/platform/public-routes`（Edge 安全的纯数据），
 * 覆盖测试会核对它没漏掉任何一个 `withPublic` / `withOwnAuth` 的路由。
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (!pathname.startsWith("/api")) return NextResponse.next();
  // CORS 预检**不带 Authorization**（浏览器规范如此），必须放行，否则跨源客户端一个都连不上。
  if (request.method === "OPTIONS") return NextResponse.next();
  if (PUBLIC_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) return NextResponse.next();
  const authorization = request.headers.get("authorization") ?? "";
  if (/^bearer\s+\S+/i.test(authorization)) return NextResponse.next();
  // 401 的响应体与 `route-guard` / `apiErrorStatus` 保持同一个形状与同一句话。
  return NextResponse.json({ error: AUTH_EXPIRED_MESSAGE }, { status: 401 });
}

export const config = { matcher: ["/api/:path*"] };
