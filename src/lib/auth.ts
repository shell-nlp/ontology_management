import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { platformQuery, type PlatformUser, type Role } from "@/lib/platform-db";

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

const SESSION_COOKIE = "ontology_session";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
  return new TextEncoder().encode(value);
}

export async function createSession(user: Pick<PlatformUser, "id" | "email" | "role">) {
  return new SignJWT({ email: user.email, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(secret());
}

export async function currentUser() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || typeof payload.email !== "string" || (payload.role !== "ADMIN" && payload.role !== "VIEWER")) return null;
    return { id: payload.sub, email: payload.email, role: payload.role as Role };
  } catch {
    return null;
  }
}

export async function requireRole(role: Role) {
  const user = await currentUser();
  if (!user || (role === "ADMIN" && user.role !== "ADMIN")) throw new Error(UNAUTHORIZED);
  return user;
}

export async function findUserByEmail(email: string) {
  const result = await platformQuery<PlatformUser>(
    "SELECT id, email, password_hash, role FROM ontology_platform.users WHERE email = $1",
    [email.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export { SESSION_COOKIE };
