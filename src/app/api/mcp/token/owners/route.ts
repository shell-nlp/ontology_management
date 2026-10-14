import { NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/platform/auth";
import { listUserIdentities } from "@/lib/platform/platform-db";

/**
 * 生成访问令牌时"这条令牌代表谁"的候选账号。
 *
 * 为什么不直接复用 `GET /api/users`：那个接口归 `users.manage` 管，而"把令牌绑到某个账号"
 * 是**令牌管理**的事 —— 自定义角色可以只有 `mcp.token.manage`，那种情况下他也该能选归属，
 * 但不需要看到用户管理的全部内容。这里只回答"谁是谁"，不给权限点。
 *
 * `me` 是当前登录账号的 id：界面据此把新令牌默认绑给操作者自己。
 */
export async function GET() {
  try {
    const user = await requirePermission("mcp.token.manage");
    const users = await listUserIdentities();
    return NextResponse.json({
      me: user.id,
      users: users.map((item) => ({ id: item.id, email: item.email, roleName: item.roleName, disabled: item.disabled })),
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取账号清单。") }, { status: apiErrorStatus(error) });
  }
}
