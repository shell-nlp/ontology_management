/**
 * 一个薄的 OpenAI 兼容 Chat Completions 客户端。
 *
 * 只做两件事：发一次带工具的对话请求、把响应归一成我们能用的形状。
 * 刻意不引第三方 SDK —— 这套接口太通用，直接 fetch 反而更容易看清边界。
 */

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type LlmToolCall = {
  id: string;
  name: string;
  /** 模型给的是 JSON 字符串，这里原样保留，由调用方决定怎么解析。 */
  argumentsText: string;
};

export type LlmToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LlmCompletion = {
  content: string;
  toolCalls: LlmToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};

type ChatMessagePayload = {
  role: string;
  content?: string | null;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
};

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export type LlmConfig = { baseUrl: string; apiKey: string; model: string };

/** 三个环境变量缺一不可；缺了就在界面上明确说"没配模型"，而不是静默失败。 */
export function llmConfig(): LlmConfig | null {
  const baseUrl = readEnv("LLM_BASE_URL");
  const apiKey = readEnv("LLM_API_KEY");
  const model = readEnv("LLM_MODEL");
  if (!baseUrl || !apiKey || !model) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model };
}

export function isLlmConfigured() {
  return llmConfig() !== null;
}

type CompleteOptions = {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** 超时保护：推理页是同步等待，不能让请求无限挂着。 */
  timeoutMs?: number;
};

export async function complete(config: LlmConfig, options: CompleteOptions): Promise<LlmCompletion> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: options.messages.map(toPayload),
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 4096,
  };
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = "auto";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "请求超时" : error instanceof Error ? error.message : "网络错误";
    throw new Error(`调用模型失败：${reason}。`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) throw new Error(`模型返回 ${response.status}：${text.slice(0, 300)}`);

  let parsed: { choices?: { message?: ChatMessagePayload }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`模型返回了非 JSON 内容：${text.slice(0, 200)}`);
  }

  const message = parsed.choices?.[0]?.message;
  if (!message) throw new Error("模型没有返回任何内容。");
  return {
    content: typeof message.content === "string" ? message.content : "",
    toolCalls: (message.tool_calls ?? []).flatMap((call) => {
      const name = call.function?.name;
      if (!name) return [];
      return [{ id: call.id ?? `call_${Math.random().toString(36).slice(2)}`, name, argumentsText: call.function?.arguments ?? "{}" }];
    }),
    usage: {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
      totalTokens: parsed.usage?.total_tokens ?? 0,
    },
  };
}

function toPayload(message: LlmMessage): ChatMessagePayload {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsText } })),
    };
  }
  return { role: message.role, content: message.content };
}
