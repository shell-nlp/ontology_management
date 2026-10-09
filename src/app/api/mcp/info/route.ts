import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listMcpTokens } from "@/lib/mcp-token";
import { publicOrigin } from "@/lib/public-origin";
import { mcpToolCatalog, MCP_PROTOCOL_VERSION, MCP_TOOL_GROUPS } from "@/lib/reasoning/mcp";
import { loadResolvedToolPolicy } from "@/lib/reasoning/tool-policy";

/** 「MCP 调试」页启动时读一次：连哪个地址、有哪些工具、令牌配没配。 */
export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission("reasoning.use");
    // 地址要跟着**用户实际访问的地址**走，不能落回服务端的 localhost（见 `@/lib/public-origin`）。
    const origin = publicOrigin(request);
    /*
     * 工具开关按本体分（2026-10-08）：带 ontologyId 时给"这个本体最终生效的那一份"，
     * 并把来源与两层原值一起带出去，界面才能显示「跟随全局 / 当前本体单独配置」。
     */
    const requested = request.nextUrl.searchParams.get("ontologyId")?.trim() || null;
    const resolved = await loadResolvedToolPolicy(requested);
    /*
     * 访问令牌（可以有多条）只报清单：名字 / 尾巴四位 / 谁生成的。**明文一律不给** ——
     * 要看明文去 `GET /api/mcp/token?reveal=<id>`（那个只有 ADMIN 能调）。
     */
    const token = await listMcpTokens();
    return NextResponse.json({
      endpoint: "/api/mcp",
      absoluteUrl: `${origin}/api/mcp`,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: "Streamable HTTP（JSON 响应）",
      tokenConfigured: token.configured,
      token: {
        configured: token.configured,
        envConfigured: token.envConfigured,
        tokens: token.entries,
        warning: token.warning,
        /** 管理令牌要 ADMIN（与工具开关同一档）；不是管理员时界面把按钮禁掉。 */
        canManage: can(user.permissions, "mcp.token.manage"),
      },
      groups: MCP_TOOL_GROUPS,
      // 给调试页的是全量目录（含暂时不用的工具），它会把那些灰着显示。
      tools: mcpToolCatalog(),
      // 被关掉的工具：调试页据此把它们灰掉，并给出开关状态。
      ontologyId: resolved.ontologyId,
      disabledTools: resolved.policy.disabledTools,
      toolPolicySource: resolved.source,
      globalDisabledTools: resolved.global.disabledTools,
      overrideDisabledTools: resolved.override?.disabledTools ?? null,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取 MCP 信息。") }, { status: apiErrorStatus(error) });
  }
}
