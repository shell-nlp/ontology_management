import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { mcpToolCatalog, MCP_PROTOCOL_VERSION, MCP_TOOL_GROUPS } from "@/lib/reasoning/mcp";
import { loadToolPolicy } from "@/lib/reasoning/tool-policy";

/** 「MCP 调试」页启动时读一次：连哪个地址、有哪些工具、令牌配没配。 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const origin = request.nextUrl.origin;
    return NextResponse.json({
      endpoint: "/api/mcp",
      absoluteUrl: `${origin}/api/mcp`,
      protocolVersion: MCP_PROTOCOL_VERSION,
      transport: "Streamable HTTP（JSON 响应）",
      tokenConfigured: Boolean(process.env.MCP_API_TOKEN?.trim()),
      groups: MCP_TOOL_GROUPS,
      // 给调试页的是全量目录（含暂时不用的工具），它会把那些灰着显示。
      tools: mcpToolCatalog(),
      // 被关掉的工具：调试页据此把它们灰掉，并给出开关状态。
      disabledTools: (await loadToolPolicy()).disabledTools,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取 MCP 信息。") }, { status: 400 });
  }
}
