import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { createUser, listUsers } from "@/lib/platform/users";
import { withPermission } from "@/lib/platform/route-guard";

/**
 * 用户：`GET` 列清单，`POST` 建账号。都要 `users.manage`。
 *
 * 建号时管理员**直接给一个初始密码**（2026-10-09 用户口径：不做"首登强制改密"、不做密码强度策略）——
 * 所以这里只挡空密码，界面会提示"平台不校验强度，请自己用足够长的密码"。
 */
const userCreateInput = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  roleId: z.string().trim().min(1).max(60),
});

export const GET = withPermission("users.manage", async () => {
  try {
    return NextResponse.json({ users: await listUsers() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取用户。") }, { status: apiErrorStatus(error) });
  }
});

export const POST = withPermission("users.manage", async (request: NextRequest, _context, actor) => {
  try {
    const input = userCreateInput.parse(await request.json());
    const created = await createUser(input);
    await writeAuditEntry({
      action: "USER_CREATED",
      actorId: actor.id,
      details: { userId: created.id, email: created.email, roleId: created.roleId, roleName: created.roleName },
    });
    return NextResponse.json({ user: created, users: await listUsers() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "新建账号失败。") }, { status: apiErrorStatus(error) });
  }
});