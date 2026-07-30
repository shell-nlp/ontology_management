import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { platformQuery, type PlatformUser, type Role } from "@/lib/platform-db";

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
  if (!user || (role === "ADMIN" && user.role !== "ADMIN")) throw new Error("UNAUTHORIZED");
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
