import { SignJWT, jwtVerify } from "jose";
import { headers } from "next/headers";
import { findSessionUser, findUserByEmail as findUserRow, type PlatformUser, type PlatformUserView } from "@/lib/platform/platform-db";
import { can, type Permission } from "@/lib/platform/permissions";

/** 会话失效的哨兵值：路由用它判断状态码，不要把它当消息回给用户。 */
const UNAUTHORIZED = "UNAUTHORIZED";
/** 登录了但权限不够。**和 UNAUTHORIZED 分开**：401 是"令牌不认"，403 是"你没有这个权限"。 */
const FORBIDDEN = "FORBIDDEN";

export const AUTH_EXPIRED_MESSAGE = "登录已过期，请刷新页面重新登录。";
export const FORBIDDEN_MESSAGE = "当前账号没有这个权限。";

export function isUnauthorized(error: unknown) {
  return error instanceof Error && error.message === UNAUTHORIZED;
}

export function isForbidden(error: unknown) {
  return error instanceof Error && error.message === FORBIDDEN;
}

/** 服务端把异常转成给用户看的一句话：会话过期不外泄错误码，其余如实透出。 */
export function apiErrorMessage(error: unknown, fallback: string) {
  if (isUnauthorized(error)) return AUTH_EXPIRED_MESSAGE;
  if (isForbidden(error)) return FORBIDDEN_MESSAGE;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/** 会话 401、权限 403，其余按业务错误走调用方给的状态码。 */
export function apiErrorStatus(error: unknown, fallback = 400) {
  if (isUnauthorized(error)) return 401;
  if (isForbidden(error)) return 403;
  return fallback;
}

/**
 * 登录态：**`Authorization: Bearer <平台会话 JWT>`**。
 *
 * 2026-10-09 用户口径「完全改为 Authorization」—— 以前用 HttpOnly Cookie，现在一律走请求头。
 * 这样 Postman / curl / 脚本能直接调（cookie 那种方式得先去浏览器里抄 value，跨机器很别扭），
 * 代价是没有 httpOnly 的保护，令牌由前端的 `@/lib/session-token` 存在 localStorage 里、
 * 每次请求自己带上（**别在这里加回 cookie 兜底**：两种来源会让"为什么这个客户端能调、那个不能"变得不可解释）。
 *
 * 令牌是**无状态 JWT**（HS256，密钥 `AUTH_SECRET`，8 小时过期），所以：
 * - 服务端**不保存**会话，登出只是前端把令牌丢掉（`/api/auth/logout` 因此是空操作）；
 * - 验签通过**不等于**用户还有效 —— 换过平台库、删过用户、**停用过账号**、改过角色之后，
 *   旧令牌不能继续当身份用，所以还要拿 `sub` 回库核对（`findSessionUser`，它连角色与权限一起取）。
 *   这一步不能省：它同时是"停用立刻生效"和"改权限立刻生效"的机制。
 */
export const SESSION_AUDIENCE = "ontology-platform";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(value);
}

export async function createSession(user: Pick<PlatformUser, "id" | "email" | "roleId">) {
  return new SignJWT({ email: user.email, roleId: user.roleId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    // 受众标记：MCP 端点同时收"平台 JWT"和"MCP 访问令牌"，靠它把两者区分开（见 mcp-endpoint 的 authorization）。
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

/** 从 `Authorization` 头的值里取出令牌；不是 `Bearer <x>` 的形状就返回空串。 */
export function bearerToken(headerValue: string | null | undefined) {
  return /^Bearer\s+(.+)$/i.exec((headerValue ?? "").trim())?.[1]?.trim() ?? "";
}

/**
 * 验一个令牌并回查到用户 + 角色 + 权限；任何一步不过都返回 null（调用方只关心"这个人还能不能用"）。
 *
 * 单独抽出来是因为有两个调用方：`currentUser()`（读当前请求的头）与 MCP 端点
 * （站内调试页把平台 JWT 当 Bearer 发过来）。
 */
export async function userFromToken(token: string): Promise<PlatformUserView | null> {
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { audience: SESSION_AUDIENCE }));
  } catch {
    return null;
  }
  if (!payload.sub || typeof payload.email !== "string") return null;
  // 回库这一步拿到的是**当前**的角色与权限：停用、删号、改角色都在这里立刻生效。
  const user = await findSessionUser(payload.sub);
  if (!user || user.email !== payload.email) return null;
  return user;
}

export type CurrentUser = PlatformUserView;

export async function currentUser(): Promise<PlatformUserView | null> {
  return userFromToken(bearerToken((await headers()).get("authorization")));
}

/** 必须登录（不看权限点）。 */
export async function requireUser(): Promise<PlatformUserView> {
  const user = await currentUser();
  if (!user) throw new Error(UNAUTHORIZED);
  return user;
}

/**
 * 必须拥有某个权限点（RBAC 的守卫）。
 *
 * 未登录 → 401；登录了但没有这个权限 → **403**（不是 401：401 现在只表示"令牌不认"，
 * 混在一起会让"权限不足"显示成"登录已过期"）。
 */
export async function requirePermission(code: Permission): Promise<PlatformUserView> {
  const user = await requireUser();
  if (!can(user.permissions, code)) throw new Error(FORBIDDEN);
  return user;
}

export async function findUserByEmail(email: string) {
  return findUserRow(email);
}