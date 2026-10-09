import { NextResponse } from "next/server";
import { apiErrorMessage, currentUser, requireRole } from "@/lib/auth";
import { createMcpToken, listMcpTokens, revealMcpToken, revokeMcpToken } from "@/lib/mcp-token";
import { writeAuditEntry } from "@/lib/platform-db";

/**
 * MCP 访问令牌的管理面。**可以有多条**（2026-10-08 用户口径：「token 应该能生成多个，
 * 可以管理 token，而不是现在的一个」）：
 *
 * - `GET`：列清单（**不含明文**）；`?reveal=<id>` 额外给这一条的明文。
 * - `POST { name }`：生成一条，明文只在这次响应里给一次。
 * - `DELETE ?id=<id>`：撤销一条。
 *
 * **只有 ADMIN 能动**：这是平台的对外凭据，拿到就能读所有本体的定义与数据（和工具开关同一档权限）。
 * 明文默认不发 —— 页面正常加载时浏览器内存里没有密钥，只有点了「查看」那一次才取。
 */
function errorResponse(error: unknown, fallback: string) {
  return NextResponse.json({ error: apiErrorMessage(error, fallback) }, { status: 400 });
}

export async function GET(request: Request) {
  try {
    await requireRole("ADMIN");
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
    const user = await currentUser();
    await requireRole("ADMIN");
    // 名字是可选的人话标签；不传就给个兜底名，别让清单里出现无名条目。
    const body = await request.json().catch(() => ({}));
    const { entry, token } = await createMcpToken((body as { name?: unknown })?.name, user?.id);
    const list = await listMcpTokens();
    await writeAuditEntry({
      action: "MCP_TOKEN_CREATED",
      actorId: user?.id,
      details: { scope: "PLATFORM", tokenId: entry.id, name: entry.name, hint: entry.hint, note: "在「MCP 调试 → MCP 接入」生成访问令牌。" },
    });
    return NextResponse.json({ tokens: list.entries, envConfigured: list.envConfigured, warning: list.warning, created: { ...entry, token } });
  } catch (error) {
    return errorResponse(error, "生成 MCP 访问令牌失败。");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await currentUser();
    await requireRole("ADMIN");
    const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!id) return NextResponse.json({ error: "撤销令牌要带 id。" }, { status: 400 });
    const removed = await revokeMcpToken(id, user?.id);
    if (!removed) {
      // 环境变量那条不在平台清单里，撤不掉 —— 明确说清，别让人以为操作成功了。
      return NextResponse.json({ error: "这条令牌不在平台里（`.env.local` 的 MCP_API_TOKEN 只能改配置文件撤销）。" }, { status: 400 });
    }
    const list = await listMcpTokens();
    await writeAuditEntry({
      action: "MCP_TOKEN_REVOKED",
      actorId: user?.id,
      details: { scope: "PLATFORM", tokenId: id, note: "撤销平台生成的 MCP 访问令牌。" },
    });
    return NextResponse.json({ tokens: list.entries, envConfigured: list.envConfigured, warning: list.warning });
  } catch (error) {
    return errorResponse(error, "撤销 MCP 访问令牌失败。");
  }
}