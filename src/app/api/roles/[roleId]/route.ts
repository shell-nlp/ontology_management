import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { deleteRole, updateRole } from "@/lib/platform/users";

/**
 * 单个角色：`PATCH` 改（内置角色改不了），`DELETE` 删（内置角色删不了、还挂着人删不了）。
 * 规则都在 `@/lib/users` 里，这里只做入参校验 + 审计。
 */
const rolePatchInput = z.object({
  name: z.string().trim().min(1).max(30),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string().trim().min(1).max(60)).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const user = await requirePermission("users.manage");
    const { roleId } = await params;
    const input = rolePatchInput.parse(await request.json());
    const role = await updateRole(roleId, input);
    await writeAuditEntry({
      action: "ROLE_UPDATED",
      actorId: user.id,
      details: { roleId: role.id, name: role.name, permissions: role.permissions },
    });
    return NextResponse.json({ role });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存角色失败。") }, { status: apiErrorStatus(error) });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ roleId: string }> }) {
  try {
    const user = await requirePermission("users.manage");
    const { roleId } = await params;
    const role = await deleteRole(roleId);
    await writeAuditEntry({
      action: "ROLE_DELETED",
      actorId: user.id,
      details: { roleId: role.id, name: role.name },
    });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "删除角色失败。") }, { status: apiErrorStatus(error) });
  }
}