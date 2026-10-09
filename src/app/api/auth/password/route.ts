import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireUser } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { changeOwnPassword } from "@/lib/users";

/**
 * 改**自己的**密码。任何登录用户都能改自己的，不需要 `users.manage`
 * —— 否则查看者连自己的密码都换不了，只能找管理员，那不合理。
 * 要验当前密码（`changeOwnPassword` 里做），所以拿到令牌的人也改不了别人的。
 */
const passwordChangeInput = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  try {
    const actor = await requireUser();
    const input = passwordChangeInput.parse(await request.json());
    await changeOwnPassword(actor.id, input.currentPassword, input.newPassword);
    await writeAuditEntry({ action: "PASSWORD_CHANGED", actorId: actor.id, details: { userId: actor.id, email: actor.email } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "改密码失败。") }, { status: apiErrorStatus(error) });
  }
}