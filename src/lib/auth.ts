import { SignJWT, jwtVerify } from "jose";
import { headers } from "next/headers";
import { findSessionUser, findUserByEmail as findUserRow, type PlatformUser, type Role } from "@/lib/platform-db";

/** 会话失效的哨兵值：路由用它判断状态码，不要把它当消息回给用户。 */
const UNAUTHORIZED = "UNAUTHORIZED";

export const AUTH_EXPIRED_MESSAGE = "登录已过期，请刷新页面重新登录。";

export function isUnauthorized(error: unknown) {
  return error instanceof Error && error.message === UNAUTHORIZED;
}

/** 服务端把异常转成给用户看的一句话：会话过期不外泄错误码，其余如实透出。 */
export function apiErrorMessage(error: unknown, fallback: string) {
  if (isUnauthorized(error)) return AUTH_EXPIRED_MESSAGE;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

/** 会话失效一律 401，其余按业务错误走调用方给的状态码。 */
export function apiErrorStatus(error: unknown, fallback = 400) {
  return isUnauthorized(error) ? 401 : fallback;
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
 * - 验签通过**不等于**用户还有效 —— 换过平台库、删过用户、改过权限之后，旧令牌不能继续当身份用，
 *   所以还要拿 `sub` 回库核对（`findSessionUser`）。这一步不能省，否则审计表的 `actor_id` 外键会被旧 id 拦下。
 */
export const SESSION_AUDIENCE = "ontology-platform";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(value);
}

export async function createSession(user: Pick<PlatformUser, "id" | "email" | "role">) {
  return new SignJWT({ email: user.email, role: user.role })
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
 * 验一个令牌并回查到用户；任何一步不过都返回 null（调用方只关心"有没有这个人"）。
 *
 * 单独抽出来是因为有两个调用方：`currentUser()`（读当前请求的头）与 MCP 端点
 * （站内调试页把平台 JWT 当 Bearer 发过来）。
 */
export async function userFromToken(token: string): Promise<{ id: string; email: string; role: Role } | null> {
  if (!token) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secret(), { audience: SESSION_AUDIENCE }));
  } catch {
    return null;
  }
  if (!payload.sub || typeof payload.email !== "string") return null;
  const user = await findSessionUser(payload.sub);
  if (!user || user.email !== payload.email) return null;
  return { id: user.id, email: user.email, role: user.role };
}

export async function currentUser() {
  return userFromToken(bearerToken((await headers()).get("authorization")));
}

export async function requireRole(role: Role) {
  const user = await currentUser();
  if (!user || (role === "ADMIN" && user.role !== "ADMIN")) throw new Error(UNAUTHORIZED);
  return user;
}

export async function findUserByEmail(email: string) {
  return findUserRow(email);
}