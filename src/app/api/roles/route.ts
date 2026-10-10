import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { createRole, listRoles } from "@/lib/platform/users";
import { PERMISSIONS } from "@/lib/platform/permissions";

/**
 * 角色：`GET` 列清单，`POST` 新建。都要 `users.manage`。
 *
 * 内置三档（管理员 / 编辑者 / 查看者）由 `@/lib/permissions` 定义、启动时同步进库，
 * 界面上只读；要定制就复制一份自定义角色。库里就算存了不存在的权限点也没用 ——
 * `normalizePermissions` 会按代码里的权限表过滤掉。
 */
const roleCreateInput = z.object({
  name: z.string().trim().min(1).max(30),
  description: z.string().trim().max(200).optional(),
  permissions: z.array(z.string().trim().min(1).max(60)).optional(),
});

export async function GET() {
  try {
    await requirePermission("users.manage");
    return NextResponse.json({
      roles: await listRoles(),
      // 界面画权限矩阵要用：代码 / 分组 / 中文名 / 说明都从服务端来，别在前端再抄一份。
      permissions: PERMISSIONS,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取角色。") }, { status: apiErrorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission("users.manage");
    const input = roleCreateInput.parse(await request.json());
    const role = await createRole(input);
    await writeAuditEntry({
      action: "ROLE_CREATED",
      actorId: user.id,
      details: { roleId: role.id, name: role.name, permissions: role.permissions },
    });
    return NextResponse.json({ role, roles: await listRoles() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "新建角色失败。") }, { status: apiErrorStatus(error) });
  }
}