import { NextRequest } from "next/server";
import { handleMcpRequest, mcpGetNotAllowed, mcpOptionsResponse } from "@/lib/reasoning/mcp-endpoint";

/**
 * MCP（Model Context Protocol）服务端 —— **平台级**端点：一个端点覆盖平台上所有本体。
 *
 * 只实现 tools 能力（initialize / tools/list / tools/call），因为这正是本体的用法 ——
 * 外部 agent 拿到工具清单，自己规划，然后查这个本体。平台内的「MCP 调试」页与外部客户端
 * 走的是同一个端点、同一套语义。
 *
 * **查哪个本体由每次调用的 `ontology_id` 参数决定**。想把它钉死在一个本体上
 * （配置片段一眼看出查的是谁、模型不用自己填 id），用本体级端点 `/api/mcp/<ontologyId>` ——
 * 见 `src/app/api/mcp/[ontologyId]/route.ts`。协议实现在 `@/lib/reasoning/mcp-endpoint`，两个入口共用一份。
 */
export async function POST(request: NextRequest) {
  return handleMcpRequest(request);
}

export async function OPTIONS() {
  return mcpOptionsResponse();
}

/** MCP 的 GET 用于服务端主动推送；这个实现没有服务端推送，按规范回 405。 */
export async function GET() {
  return mcpGetNotAllowed();
}
