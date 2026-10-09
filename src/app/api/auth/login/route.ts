import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { createSession, findUserByEmail } from "@/lib/auth";

/**
 * 登录：验密码，发一枚**平台会话 JWT**。
 *
 * 令牌放在响应体里（`token`），由前端自己存、自己加到 `Authorization: Bearer` 上
 * —— 2026-10-09 起不再下发 Cookie（见 `@/lib/session-token` 的说明）。
 * 所以这个接口是**公开**的：除了邮箱密码，没有任何前置凭据。
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    if (!body.email || !body.password) return NextResponse.json({ error: "邮箱和密码不能为空。" }, { status: 400 });
    const user = await findUserByEmail(body.email);
    if (!user || !(await bcrypt.compare(body.password, user.password_hash))) return NextResponse.json({ error: "邮箱或密码不正确。" }, { status: 401 });
    return NextResponse.json({
      id: user.id,
      email: user.email,
      role: user.role,
      /** 前端存这个（`setSessionToken`）。 */
      token: await createSession(user),
      /** 有效期秒数，与 `createSession` 里的 "8h" 对应；界面不需要倒计时，给调试的人看的。 */
      expiresInSeconds: 8 * 60 * 60,
    });
  } catch {
    return NextResponse.json({ error: "登录请求无效。" }, { status: 400 });
  }
}