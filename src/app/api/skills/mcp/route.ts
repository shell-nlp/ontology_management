import { NextRequest, NextResponse } from "next/server";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp-protocol";
import {
  callSkillMcpTool,
  findSkillMcpTool,
  listSkillPrompts,
  readSkillPrompt,
  SKILLS_MCP_INSTRUCTIONS,
  SKILLS_MCP_SERVER_NAME,
  SKILLS_MCP_SERVER_VERSION,
  SKILL_MCP_TOOLS,
} from "@/lib/skills-mcp";

/**
 * 「本体技能」的 MCP 服务端：Streamable HTTP 传输，JSON 响应。
 *
 * 与 `/api/mcp` 的分工要说清楚 —— 这是**两个独立的服务端**，别混：
 *
 * | | `/api/mcp` | `/api/skills/mcp`（这里） |
 * | --- | --- | --- |
 * | 发什么 | 本体数据（对象类型 / 关系类型 / 动作…） | 建模方法（三套技能的 Markdown） |
 * | 鉴权 | 平台会话 或 `Bearer <MCP_API_TOKEN>` | **无**（免令牌） |
 *
 * 免令牌是有依据的：技能是随仓库下发的公开文档，不含凭据、不含本体数据，读的也只是 `skills/`
 * 目录里的文件。外部 Agent 在 MCP 配置里填一个地址就能用，不用先去下载 zip 再配技能目录。
 *
 * 能力：`tools`（`list_ontology_build_skills` / `get_ontology_build_skill` / `get_ontology_build_skill_file`）
 * 与 `prompts`（每套技能一个提示词）。
 *
 * 工具名带 `ontology_build_skill` 是刻意的：客户端的工具列表里会同时出现两个服务端的工具，
 * 名字要能自己说清"这是本体构建技能"，且与 `/api/mcp` 的 `list_ontologies` / `get_object_type` 分得开。
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

async function handleMessage(message: JsonRpcRequest) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "不是合法的 JSON-RPC 2.0 请求。");
  }
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: SKILLS_MCP_SERVER_NAME, version: SKILLS_MCP_SERVER_VERSION },
        instructions: SKILLS_MCP_INSTRUCTIONS,
      },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0" as const, id: id ?? null, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: { tools: SKILL_MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })) },
    };
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!name) return rpcError(id, -32602, "tools/call 需要 name。");
    if (!findSkillMcpTool(name)) return rpcError(id, -32602, `没有叫「${name}」的工具。先调 tools/list。`);
    try {
      const payload = await callSkillMcpTool(name, args);
      return {
        jsonrpc: "2.0" as const,
        id: id ?? null,
        result: {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
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

  if (method === "prompts/list") {
    return { jsonrpc: "2.0" as const, id: id ?? null, result: { prompts: await listSkillPrompts() } };
  }

  if (method === "prompts/get") {
    const name = typeof params.name === "string" ? params.name : "";
    if (!name) return rpcError(id, -32602, "prompts/get 需要 name。");
    const prompt = await readSkillPrompt(name);
    if (!prompt) return rpcError(id, -32602, `没有叫「${name}」的提示词。先调 prompts/list。`);
    return { jsonrpc: "2.0" as const, id: id ?? null, result: prompt };
  }

  return isNotification ? null : rpcError(id, -32601, `不支持的方法：${method}`);
}

export async function POST(request: NextRequest) {
  const headers = { ...CORS_HEADERS, "MCP-Protocol-Version": MCP_PROTOCOL_VERSION };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "请求体不是合法 JSON。"), { status: 400, headers });
  }

  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcRequest[];
  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await handleMessage(message);
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
