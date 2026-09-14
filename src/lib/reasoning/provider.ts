import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * 模型接入层：把"OpenAI 兼容端点 + 三个环境变量"翻译成 AI SDK 的模型对象。
 *
 * 用 `@ai-sdk/openai-compatible` 而不是 `@ai-sdk/openai`，因为我们的端点是个代理：
 * baseURL 是自建的，思考走的是 DeepSeek 那套 `reasoning_content`，还有一个非标准参数
 * `thinking`（官方 provider 不认）。openai-compatible 三点都支持。
 */

/** provider 实例名。`providerOptions` 的 key 必须与它一致，非标准参数才能进请求体。 */
export const LLM_PROVIDER_NAME = "ontology";

export type LlmSettings = { baseUrl: string; apiKey: string; modelId: string };

function readEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** 三个环境变量缺一不可；缺了就在界面上明确说"没配模型"，而不是静默失败。 */
export function llmSettings(): LlmSettings | null {
  const baseUrl = readEnv("LLM_BASE_URL");
  const apiKey = readEnv("LLM_API_KEY");
  const modelId = readEnv("LLM_MODEL");
  if (!baseUrl || !apiKey || !modelId) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, modelId };
}

export function isLlmConfigured() {
  return llmSettings() !== null;
}

export function llmModel(settings: LlmSettings): LanguageModel {
  const provider = createOpenAICompatible({
    name: LLM_PROVIDER_NAME,
    baseURL: settings.baseUrl,
    apiKey: settings.apiKey,
    // 让服务端在流末尾补一块 usage，否则流式下统计不到 token。
    includeUsage: true,
  });
  return provider.chatModel(settings.modelId);
}

/**
 * 思考开关。走 providerOptions 透传：openai-compatible 会把这一层里不认识的自定义字段
 * 原样合并进请求体，所以 `thinking` 能到服务端（实测 `disabled` 会让 reasoning_content 变空）。
 * 不传就是服务端默认（本项目实测默认是开思考）。
 */
export function thinkingProviderOptions(thinking: boolean | undefined) {
  if (thinking === undefined) return undefined;
  return { [LLM_PROVIDER_NAME]: { thinking: { type: thinking ? "enabled" : "disabled" } } };
}
