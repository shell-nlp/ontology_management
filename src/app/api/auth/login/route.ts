import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { createSession, findUserByEmail, SESSION_COOKIE } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    if (!body.email || !body.password) return NextResponse.json({ error: "邮箱和密码不能为空。" }, { status: 400 });
    const user = await findUserByEmail(body.email);
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) return NextResponse.json({ error: "邮箱或密码不正确。" }, { status: 401 });
    const response = NextResponse.json({ id: user.id, email: user.email, role: user.role });
    response.cookies.set(SESSION_COOKIE, await createSession(user), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 60 * 60 * 8, path: "/" });
    return response;
  } catch {
    return NextResponse.json({ error: "登录请求无效。" }, { status: 400 });
  }
}
