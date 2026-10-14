import { NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/platform/auth";
import { createMcpToken, listMcpTokens, revealMcpToken, revokeMcpToken } from "@/lib/mcp/token";
import { writeAuditEntry } from "@/lib/platform/platform-db";

/**
 * MCP 访问令牌的管理面。**可以有多条**（2026-10-08 用户口径：「token 应该能生成多个，
 * 可以管理 token，而不是现在的一个」）：
 *
 * - `GET`：列清单（**不含明文**）；`?reveal=<id>` 额外给这一条的明文。
 * - `POST { name, ownerUserId }`：生成一条，明文只在这次响应里给一次。
 * - `DELETE ?id=<id>`：撤销一条。
 *
 * **只有 ADMIN 能动**：这是平台的对外凭据，拿着它就能读本体的定义与数据（和工具开关同一档权限）。
 * 明文默认不发 —— 页面正常加载时浏览器内存里没有密钥，只有点了「查看」那一次才取。
 *
 * **每条令牌都代表一个账号**（2026-10-14）：`ownerUserId` 决定它的权限上限，界面默认选当前登录的人。
 * 令牌自己不带权限 —— 每次调用都回库取那个账号**当前**的角色与权限点，
 * 所以停用账号 / 改角色立刻生效（见 `@/lib/mcp/token` 的 `resolveMcpToken`）。
 */
function errorResponse(error: unknown, fallback: string) {
  return NextResponse.json({ error: apiErrorMessage(error, fallback) }, { status: apiErrorStatus(error) });
}

export async function GET(request: Request) {
  try {
    await requirePermission("mcp.token.manage");
    const revealId = new URL(request.url).searchParams.get("reveal")?.trim() ?? "";
    const list = await listMcpTokens();
    const token = revealId ? await revealMcpToken(revealId) : null;
    return NextResponse.json({
      tokens: list.entries,
      envConfigured: list.envConfigured,
      warning: list.warning,
      /** 只有真取到明文才带这一项，界面据此判断"这条能看到"。 */
      revealed: token ? { id: revealId, token } : null,
    });
  } catch (error) {
    return errorResponse(error, "无法读取 MCP 访问令牌。");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requirePermission("mcp.token.manage");
    // 名字是可选的人话标签；不传就给个兜底名，别让清单里出现无名条目。
    const body = (await request.json().catch(() => ({}))) as { name?: unknown; ownerUserId?: unknown };
    /*
     * 令牌**代表哪个账号**（2026-10-14）：界面会传，缺省就绑定生成者本人。
     * 令牌的权限上限就是这个账号的角色权限，所以它不能留空。
     */
    const { entry, token } = await createMcpToken(body?.name, { actorId: actor.id, ownerUserId: body?.ownerUserId ?? actor.id });
    const list = await listMcpTokens();
    await writeAuditEntry({
      action: "MCP_TOKEN_CREATED",
      actorId: actor.id,
      details: {
        scope: "PLATFORM",
        tokenId: entry.id,
        name: entry.name,
        hint: entry.hint,
        ownerUserId: entry.ownerUserId,
        ownerEmail: entry.ownerEmail,
        note: "在「MCP 调试 → MCP 接入」生成访问令牌（代表上面这个账号）。",
      },
    });
    return NextResponse.json({ tokens: list.entries, envConfigured: list.envConfigured, warning: list.warning, created: { ...entry, token } });
  } catch (error) {
    return errorResponse(error, "生成 MCP 访问令牌失败。");
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await requirePermission("mcp.token.manage");
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return NextResponse.json({ error: "撤销令牌要带 id。" }, { status: 400 });
    const removed = await revokeMcpToken(id, actor.id);
    if (!removed) {
      // 环境变量那条不在平台清单里，撤不掉 —— 明确说清，别让人以为操作成功了。
      return NextResponse.json({ error: "这条令牌不在平台里（`.env.local` 的 MCP_API_TOKEN 只能改配置文件撤销）。" }, { status: 400 });
    }
    const list = await listMcpTokens();
    await writeAuditEntry({
      action: "MCP_TOKEN_REVOKED",
      actorId: actor.id,
      details: { scope: "PLATFORM", tokenId: id, note: "撤销平台生成的 MCP 访问令牌。" },
    });
    return NextResponse.json({ tokens: list.entries, envConfigured: list.envConfigured, warning: list.warning });
  } catch (error) {
    return errorResponse(error, "撤销 MCP 访问令牌失败。");
  }
}