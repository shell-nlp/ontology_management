import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { deleteUser, updateUser } from "@/lib/platform/users";

/**
 * 单个账号：`PATCH` 改角色 / 重置密码 / 停用，`DELETE` 真删。
 *
 * 三条保护都在 `@/lib/users`：**最后一个能管用户的账号**不许被降级 / 停用 / 删除（否则平台锁死）；
 * 删除是真删，指向 users 的 4 条外键是 `ON DELETE SET NULL`，所以下面还要补一条 `USER_DELETED` 审计 ——
 * 那条里带着被删账号的邮箱，人删了、名字还追得回来。
 */
const userPatchInput = z.object({
  roleId: z.string().trim().min(1).max(60).optional(),
  password: z.string().min(1).max(200).optional(),
  disabled: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requirePermission("users.manage");
    const { userId } = await params;
    const input = userPatchInput.parse(await request.json());
    const user = await updateUser(userId, input);
    await writeAuditEntry({
      action: "USER_UPDATED",
      actorId: actor.id,
      details: {
        userId: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.roleName,
        // 密码写没写要说出来，但**不记内容**（哈希也不记）。
        passwordReset: input.password !== undefined,
        disabled: user.disabled,
      },
    });
    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存账号失败。") }, { status: apiErrorStatus(error) });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const actor = await requirePermission("users.manage");
    const { userId } = await params;
    const user = await deleteUser(userId);
    await writeAuditEntry({
      action: "USER_DELETED",
      actorId: actor.id,
      details: {
        userId: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.roleName,
        note: "账号已删除；他历史上的审计记录会保留，只是操作人变空。",
      },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "删除账号失败。") }, { status: apiErrorStatus(error) });
  }
}