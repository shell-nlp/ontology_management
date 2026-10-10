import { NextRequest, NextResponse } from "next/server";
import { bearerToken, userFromToken } from "@/lib/platform/auth";
import { verifyMcpToken } from "@/lib/mcp/token";
import { stripOntologyId } from "@/lib/mcp/schema";
import { getOntology } from "@/lib/ontology/ontologies";
import { callMcpTool, findMcpTool, mcpTools, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "@/lib/reasoning/mcp";
import { loadToolPolicy, type ToolPolicy } from "@/lib/reasoning/tool-policy";

/**
 * MCP 服务端的协议实现（JSON-RPC 2.0 / Streamable HTTP 的 JSON 响应形态）。
 *
 * 单独抽出来是因为有**两个入口**，它们共用同一套语义：
 * - `/api/mcp`：**平台级**端点。一个端点覆盖平台上所有本体，查哪个由每次调用的
 *   `ontology_id` 参数决定（客户端连接时还不知道要查谁，所以 `tools/list` 按全局默认给）。
 * - `/api/mcp/<ontologyId>`：**本体级**端点（2026-10-08 用户口径：「不同的本体，mcp 工具查的内容也不同」）。
 *   绑定到一个本体：`tools/list` 就按这个本体的策略过滤，`tools/call` 自动注入它的 `ontology_id`，
 *   客户端**不用也不该**自己填 —— 配置片段因此能一眼看出"这条 MCP 是查哪个本体的"。
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
 * 两个参数都可能是"没带"：单条请求是对象，批量是数组。返回 null 表示这次是通知（不该有响应体）。
 */
async function handleMessage(
  message: JsonRpcRequest,
  options: { listPolicy: ToolPolicy; pinned: { id: string; name: string } | null },
): Promise<unknown> {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "不是合法的 JSON-RPC 2.0 请求。");
  }
  const { id, method } = message;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method.startsWith("notifications/")) return null;

  if (method === "initialize") {
    const instructions = options.pinned
      ? `这是本体平台的 MCP 服务，已经绑定到本体「${options.pinned.name}」（id ${options.pinned.id}）：所有工具都会自动用这个本体，你不必自己填 ontology_id，也不要改它。用 search_schema 确认概念名，再用 get_object_type / list_actions / get_table_ddl / run_sql 读定义与数据。只读，且只覆盖本体定义这一层（不查实例数据）。`
      : "这是本体平台的 MCP 服务，一个端点覆盖平台上所有本体：每次调用由参数 ontology_id 决定查谁；也可以改用本体级端点 /api/mcp/<本体 id>，那里地址已把本体钉死，无需自己填。用 search_schema 确认概念名，再用 get_object_type / list_actions 读对象类型与动作的定义。本服务只覆盖本体定义这一层（对象类型、属性、关系类型、动作、数据来源绑定），不查实例数据；所有工具只读。";
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: options.pinned ? `${MCP_SERVER_NAME}:${options.pinned.id}` : MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions,
      },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0" as const, id: id ?? null, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0" as const,
      id: id ?? null,
      result: {
        // 本体级端点：ontology_id 恒被 URL 钉死，参数表里不暴露它（见 stripOntologyId）。
        tools: mcpTools(options.listPolicy.disabledTools).map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: options.pinned ? stripOntologyId(tool.inputSchema) : tool.inputSchema,
        })),
      },
    };
  }

  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : "";
    const raw = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!name) return rpcError(id, -32602, "tools/call 需要 name。");
    const args = applyPinnedOntology(raw, options.pinned?.id ?? null);
    /*
     * 工具开关按本体分：这次调用查哪个本体，就按那个本体的策略判。
     * 平台级端点请求里没带 ontology_id 时退回全局默认（例如只调 list_ontologies）。
     */
    const ontologyId = typeof args.ontology_id === "string" ? args.ontology_id.trim() : "";
    const policy = ontologyId ? await loadToolPolicy(ontologyId) : options.listPolicy;
    if (!findMcpTool(name, policy.disabledTools)) {
      const scope = ontologyId ? `在本体 ${ontologyId} 上被关闭` : "已在平台的「MCP 调试」里被关闭";
      return rpcError(id, -32602, policy.disabledTools.includes(name) ? `工具「${name}」${scope}，当前不可用。` : `没有叫「${name}」的工具。先调 tools/list。`);
    }
    try {
      const outcome = await callMcpTool(name, args, policy.disabledTools);
      return {
        jsonrpc: "2.0" as const,
        id: id ?? null,
        result: {
          /*
           * 紧凑 JSON，不缩进：工具结果是喂给模型的，缩进只占 token 不含信息。
           * 实测 get_table_ddl 一张 36 列的表：缩进版 16,276 字符、紧凑版 10,536 —— 白多 35%。
           */
          content: [{ type: "text", text: JSON.stringify(outcome.payload) }],
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

/**
 * 本体级端点：把 `ontology_id` 钉死在这个本体上。
 *
 * 客户端自己传了别的 ontology_id 也**以 URL 为准** —— 一条 MCP 配置对应一个本体，
 * 这是"配置片段能一眼看出查的是谁"的前提；真要查别的本体，就再配一条。
 */
export function applyPinnedOntology(args: Record<string, unknown>, pinnedOntologyId: string | null): Record<string, unknown> {
  if (!pinnedOntologyId) return args;
  return { ...args, ontology_id: pinnedOntologyId };
}

/**
 * 同一个 `Authorization` 头上有**两套凭据**，都要认，一个都不能少：
 *
 * - **平台会话 JWT**：站内「MCP 调试」页发的。2026-10-09 起登录态统一走请求头（不再有 cookie），
 *   所以站内调这个端点也得带头 —— 靠 `aud` 标记认（`@/lib/auth` 的 `SESSION_AUDIENCE`）。
 * - **MCP 访问令牌**：外部客户端用的 `mcp_…` 随机串，可多条、可逐条撤销（`@/lib/mcp-token`）。
 *
 * **先试 JWT**：令牌不是 JWT 时验签立刻失败、不查库；反过来先试 MCP 令牌则要对清单里每一条解密再比较。
 * 两个都不认就是 401，绝不静默放行。
 */
async function authorization(request: NextRequest) {
  const bearer = bearerToken(request.headers.get("authorization"));
  if (!bearer) {
    return {
      ok: false as const,
      via: "none" as const,
      reason: "未授权：带上 Authorization: Bearer <平台会话令牌>（站内）或 <MCP 访问令牌>（外部客户端）。",
    };
  }
  if (await userFromToken(bearer)) return { ok: true as const, via: "session" as const };
  /*
   * MCP 令牌由 `@/lib/mcp-token` 解析：**平台库里那条优先**（「MCP 调试 → MCP 接入」里生成/撤销的），
   * 其次才是 `.env.local` 的 `MCP_API_TOKEN`。比较走恒定时间，不用 `===`。
   */
  const { ok, configured } = await verifyMcpToken(bearer);
  if (ok) return { ok: true as const, via: "token" as const };
  return {
    ok: false as const,
    via: "token" as const,
    reason: configured
      ? "令牌不正确：平台会话可能已过期，MCP 访问令牌可能已被撤销。到「MCP 调试 → MCP 接入」核对现在有效的令牌。"
      : "既没有有效的平台会话，服务端也还没有配置 MCP 访问令牌：站内请重新登录；外部客户端到「MCP 调试 → MCP 接入」生成一条。",
  };
}

export async function handleMcpRequest(request: NextRequest, options: { pinnedOntologyId?: string | null } = {}) {
  const pinnedId = (options.pinnedOntologyId ?? "").trim();
  const auth = await authorization(request);
  const headers = { ...CORS_HEADERS, ...(auth.ok ? { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION } : {}) };
  if (!auth.ok) return NextResponse.json(rpcError(null, -32001, auth.reason), { status: 401, headers });

  // 本体级端点：先把本体解析出来（顺便校验它存不存在），后面 tools/list 与 tools/call 都用它。
  let pinned: { id: string; name: string } | null = null;
  if (pinnedId) {
    const ontology = await getOntology(pinnedId).catch(() => null);
    if (!ontology) {
      return NextResponse.json(rpcError(null, -32602, `这个 MCP 地址里绑定的本体不存在：${pinnedId}。请到「MCP 调试 → MCP 接入」复制当前本体的地址。`), { status: 404, headers });
    }
    pinned = { id: ontology.id, name: ontology.name };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "请求体不是合法 JSON。"), { status: 400, headers });
  }

  /*
   * 列表用的策略：本体级端点按**这个本体**生效的那一份（覆盖优先），平台级端点按**全局默认**。
   * 平台级端点不按本体过滤列表，是因为客户端在连接时还没有任何 ontology 上下文 ——
   * 真正能不能用由 tools/call 按目标本体的策略判定，关掉的会明确回一句原因。
   */
  const listPolicy = await loadToolPolicy(pinned?.id ?? null);
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcRequest[];
  const responses: unknown[] = [];
  for (const message of messages) {
    const response = await handleMessage(message, { listPolicy, pinned });
    if (response) responses.push(response);
  }

  // 全是通知时按 MCP 约定回 202，不带响应体。
  if (!responses.length) return new NextResponse(null, { status: 202, headers });
  return NextResponse.json(batch ? responses : responses[0], { headers });
}

export function mcpOptionsResponse() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function mcpGetNotAllowed() {
  return NextResponse.json(rpcError(null, -32601, "这个 MCP 服务端不支持服务端推送，请用 POST。"), { status: 405, headers: CORS_HEADERS });
}

export { CORS_HEADERS };
