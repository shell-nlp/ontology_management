import { NextResponse, type NextRequest } from "next/server";
import { apiErrorMessage, apiErrorStatus, requirePermission, requireUser, type CurrentUser } from "@/lib/platform/auth";
import type { Permission } from "@/lib/platform/permissions";

/**
 * 路由守卫：**PEP 的收口处**（2026-10-14）。
 *
 * 为什么要这一层：以前每个 route 在自己的 `try` 里手写 `await requirePermission("...")` —— 74 个文件、
 * 近百处调用。那是"每个入口各自声明一次"，漏一个就是权限洞（`tests/lib/authz-coverage.test.ts` 就是为了兜它）。
 * 现在改成：**权限点只在导出处声明一次，判与拦只在这个文件里**；覆盖测试按**方法粒度**扫
 * `export const GET|POST|... = withXxx(...)`，漏包当场红。
 *
 * 分工（对齐 PDP / PEP）：
 * - **决策仍是 `can()`**（PDP，纯函数，住在 `permissions.ts`，前端 `may()` 与 MCP 端点共用同一份）；
 * - **这里是 PEP**：拦下来、判完、把未登录 / 无权映射成 401 / 403；
 * - **handler 自己的 `try/catch` 不动**：业务错误的兜底文案与状态码仍归各路由，
 *   所以这里只处理"守卫本身失败"，业务异常原样交给 handler。
 *
 * 前端的 `may()` 是**同源的另一个 PEP**（UI 侧，只决定按钮可见性，不构成安全边界）。
 */

/** 需要权限点 / 需要登录的 handler：第三个参数是**已认证的用户**，handler 里不用再取一次。 */
type GuardedHandler<C> = (request: NextRequest, context: C, user: CurrentUser) => Promise<Response> | Response;
/** 公开或自带鉴权的 handler：拿不到注入的用户。 */
type PlainHandler<C> = (request: NextRequest, context: C) => Promise<Response> | Response;

/** 守卫失败的统一出口：未登录 401、登录了但没权限 403（语义与 `apiErrorStatus` 一致）。 */
function guardFailed(error: unknown, fallback: string) {
  return NextResponse.json({ error: apiErrorMessage(error, fallback) }, { status: apiErrorStatus(error, 401) });
}

/**
 * 必须拥有某个权限点。**这是平台里唯一执行权限判断的地方** —— 新增路由就用它，别再手写 requirePermission。
 */
export function withPermission<C = unknown>(code: Permission, handler: GuardedHandler<C>) {
  return async (request: NextRequest, context: C): Promise<Response> => {
    let user: CurrentUser;
    try {
      user = await requirePermission(code);
    } catch (error) {
      return guardFailed(error, `当前账号没有「${code}」这个权限。`);
    }
    return handler(request, context, user);
  };
}

/** 只要求登录、不挑权限点。 */
export function withUser<C = unknown>(handler: GuardedHandler<C>) {
  return async (request: NextRequest, context: C): Promise<Response> => {
    let user: CurrentUser;
    try {
      user = await requireUser();
    } catch (error) {
      return guardFailed(error, "请先登录。");
    }
    return handler(request, context, user);
  };
}

/**
 * **明确公开**的路由：登录 / 登出 / 首次初始化 / OAuth 按规范必须匿名可达的两个端点 /
 * 免令牌的技能 MCP / 授权页那个只读预览。
 *
 * 写成包装器而不是"测试里的豁免名单"，是为了让"这个路由故意不鉴权"**出现在代码里**，
 * 评审时一眼能看见，也免得名单和源码两处各说各话。
 */
export function withPublic<C = unknown>(handler: PlainHandler<C>) {
  return handler;
}

/**
 * **自带鉴权**的路由：MCP 端点同一个 `Authorization` 头上要认两套凭据（平台会话 JWT 与 MCP 访问令牌），
 * 走 `mcp-endpoint.ts` 的 `authorization()`。别把这条当成"可以随便加"的口子。
 */
export function withOwnAuth<C = unknown>(handler: PlainHandler<C>) {
  return handler;
}