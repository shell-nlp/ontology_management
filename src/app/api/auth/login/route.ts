import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { createSession, findUserByEmail, SESSION_COOKIE } from "@/lib/auth";
import { sessionCookieSecure } from "@/lib/session-cookie";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    if (!body.email || !body.password) return NextResponse.json({ error: "邮箱和密码不能为空。" }, { status: 400 });
    const user = await findUserByEmail(body.email);
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) return NextResponse.json({ error: "邮箱或密码不正确。" }, { status: 401 });
    const response = NextResponse.json({ id: user.id, email: user.email, role: user.role });
    // Secure 看这次请求实际是不是 https，不看 NODE_ENV：容器里 NODE_ENV 恒为 production，
    // 直接用 http（localhost 之外的地址）访问时发 Secure cookie 会被浏览器丢掉，等于登录不上。
    response.cookies.set(SESSION_COOKIE, await createSession(user), {
      httpOnly: true,
      sameSite: "lax",
      secure: sessionCookieSecure({
        forwardedProto: request.headers.get("x-forwarded-proto"),
        protocol: request.nextUrl.protocol,
        override: process.env.AUTH_COOKIE_SECURE,
      }),
      maxAge: 60 * 60 * 8,
      path: "/",
    });
    return response;
  } catch {
    return NextResponse.json({ error: "登录请求无效。" }, { status: 400 });
  }
}
