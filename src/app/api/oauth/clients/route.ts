import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { deleteClient, listClients } from "@/lib/oauth/store";
import { withPermission } from "@/lib/platform/route-guard";

/**
 * 已注册的 OAuth 客户端清单：`GET` 看、`DELETE` 删。要 `mcp.token.manage`（和管访问令牌同一档）。
 *
 * 为什么只在界面里"看 + 删"、不做"新建"：客户端是**自助注册**进来的（MCP 客户端第一次连接时自己注册），
 * 管理员要做的是**发现不认识的、把它删掉**。删的时候会把它的授权码与刷新令牌一起作废 —— 删了还能用就等于没删。
 */
function errorResponse(error: unknown, fallback: string) {
  return NextResponse.json({ error: apiErrorMessage(error, fallback) }, { status: apiErrorStatus(error) });
}

export const GET = withPermission("mcp.token.manage", async () => {
  try {
    return NextResponse.json({ clients: await listClients() });
  } catch (error) {
    return errorResponse(error, "无法读取 OAuth 客户端清单。");
  }
});

export const DELETE = withPermission("mcp.token.manage", async (request: NextRequest, _context, actor) => {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return NextResponse.json({ error: "删除客户端要带 id。" }, { status: 400 });
    const removed = await deleteClient(id);
    if (!removed) return NextResponse.json({ error: "没有这个客户端（可能已经被删了）。" }, { status: 404 });
    await writeAuditEntry({
      action: "OAUTH_CLIENT_DELETED",
      actorId: actor.id,
      details: { clientId: id, note: "删除 OAuth 客户端，并作废它的授权码与刷新令牌。" },
    });
    return NextResponse.json({ clients: await listClients() });
  } catch (error) {
    return errorResponse(error, "删除 OAuth 客户端失败。");
  }
});
