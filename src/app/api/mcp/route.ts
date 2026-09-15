import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { loadToolPolicy, type ToolPolicy } from "@/lib/reasoning/tool-policy";
import { callMcpTool, findMcpTool, mcpTools, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@/lib/reasoning/mcp";

/**
 * MCP（Model Context Protocol）服务端：Streamable HTTP 传输，JSON 响应。
 *
 * 只实现 tools 能力（initialize / tools/list / tools/call），因为这正是本体的用法——
 * 外部 agent 拿到工具清单，自己规划，然后查这个本体。
 * 平台内的「MCP 调试」页和外部客户端走的是同一个端点、同一套语义。
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

/**
 * 两种鉴权：平台会话 Cookie（站内调试用），或 `Authorization: Bearer <MCP_API_TOKEN>`
 * （外部客户端用）。两个都没配就是未授权，不会静默放行。
 */
async function authorization(request: NextRequest) {
  const header = (request.headers.get("authorization") ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
  const expected = process.env.MCP_API_TOKEN?.trim() ?? "";
  if (bearer) {
    if (expected && bearer === expected) return { ok: true as const, via: "token" as const };
    return { ok: false as const, via: "token" as const, reason: expected ? "令牌不正确。" : "服务端没有配置 MCP_API_TOKEN，外部客户端暂时连不上。" };
  }
  const user = await currentUser();
  if (user) return { ok: true as const, via: "session" as const };
  return { ok: false as const, via: "none" as const, reason: "未授权：带上平台会话 Cookie，或 Authorization: Bearer <MCP_API_TOKEN>。" };
}

async function handleMessage(message: JsonRpcRequest, policy: ToolPolicy) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "不是合法的 JSON-RPC 2.0 请求。");
  }
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions: "这是本体平台的 MCP 服务。先调 list_ontologies 拿到 ontology_id，再用 search_schema 确认概念名，然后用 get_object_type / list_actions 读对象类型与动作的定义。本服务只覆盖本体定义这一层（对象类型、属性、关系类型、动作、数据来源绑定），不查实例数据；所有工具只读。",
      },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0" as const, id: id ?? null, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: {
        tools: mcpTools(policy.disabledTools).map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })),
      },
    };
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!name) return rpcError(id, -32602, "tools/call 需要 name。");
    if (!findMcpTool(name, policy.disabledTools)) return rpcError(id, -32602, policy.disabledTools.includes(name) ? `工具「${name}」已在平台的「MCP 调试」里被关闭，当前不可用。` : `没有叫「${name}」的工具。先调 tools/list。`);
    try {
      const outcome = await callMcpTool(name, args, policy.disabledTools);
      return {
        jsonrpc: "2.0" as const,
        id: id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(outcome.payload, null, 2) }],
          structuredContent: outcome.payload,
          isError: false,
        },
      };
    } catch (error) {
      // 工具内部错误按 MCP 约定放进 result.isError，而不是 JSON-RPC error —— 这样模型能看到原因并自我纠正。
      return {
        jsonrpc: "2.0" as const,
        id: id ?? null,
        result: {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        },
      };
    }
  }

  return isNotification ? null : rpcError(id, -32601, `不支持的方法：${method}`);
}

export async function POST(request: NextRequest) {
  const auth = await authorization(request);
  const headers = { ...CORS_HEADERS, ...(auth.ok ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}) };
  if (!auth.ok) {
    return NextResponse.json(rpcError(null, -32001, auth.reason), { status: 401, headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "请求体不是合法 JSON。"), { status: 400, headers });
  }

  // 工具开关是平台级设置：每次请求读一次，关了之后连 tools/list 都不再出现它。
  const policy = await loadToolPolicy();
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcRequest[];
  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await handleMessage(message, policy);
    if (response) responses.push(response);
  }

  // 全是通知时按 MCP 约定回 202，不带响应体。
  if (!responses.length) return new NextResponse(null, { status: 202, headers });
  return NextResponse.json(batch ? responses : responses[0], { headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/** MCP 的 GET 用于服务端主动推送；这个实现没有服务端推送，按规范回 405。 */
export async function GET() {
  return NextResponse.json(rpcError(null, -32601, "这个 MCP 服务端不支持服务端推送，请用 POST。"), { status: 405, headers: CORS_HEADERS });
}
