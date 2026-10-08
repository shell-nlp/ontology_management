import { NextRequest } from "next/server";
import { handleMcpRequest, mcpGetNotAllowed, mcpOptionsResponse } from "@/lib/reasoning/mcp-endpoint";

/**
 * MCP 服务端的**本体级**端点：`/api/mcp/<ontologyId>`。
 *
 * 2026-10-08 用户口径：「不同的本体，mcp 工具查的内容也不同」—— 平台级端点 `/api/mcp`
 * 每次调用都要带 `ontology_id`，光看配置片段看不出这条 MCP 查的是谁。这个入口把本体钉在 URL 里：
 *
 * - `tools/list` 直接按**这个本体**生效的开关过滤（不是全局默认）；
 * - `tools/call` 自动注入 `ontology_id`，客户端不用也不该自己填（传了别的也以 URL 为准）；
 * - `initialize` 的说明里会写明绑定的本体名与 id，模型一接上就知道自己在查谁。
 *
 * 路径段与 `/api/mcp/info` 并存：Next 会优先匹配静态段 `info`，本体 id 是 UUID，不会撞。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  const { ontologyId } = await context.params;
  return handleMcpRequest(request, { pinnedOntologyId: ontologyId });
}

export async function OPTIONS() {
  return mcpOptionsResponse();
}

export async function GET() {
  return mcpGetNotAllowed();
}
