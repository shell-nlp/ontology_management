import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";
import { llmModel, llmSettings, thinkingProviderOptions } from "@/lib/reasoning/provider";
import { buildInstructions } from "@/lib/reasoning/prompt";
import { reasoningToolSet, type ToolContext } from "@/lib/reasoning/tools";
import { toolResultSummary } from "@/lib/reasoning/tool-summary";
import type { ReasoningEvidence, ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";

/**
 * 本体推理闭环的编排层。
 *
 * 循环本身交给 AI SDK 的 ToolLoopAgent（模型选工具 → 执行 → 结果回灌 → 再选），
 * 这一层只做三件事：
 * 1. 把本体的概念清单塞进 instructions，省掉模型一次"先看看有什么"的往返；
 * 2. 把工具集装配起来，并按 toolCallId 回收每一步引用了哪些真实对象（证据）；
 * 3. 把 SDK 的 fullStream 翻译成我们自己的事件（思考 / 正文 / 步 / 收尾），
 *    上层 SSE 与前端界面因此完全不感知换过框架。
 */

/**
 * 步数兜底上限。**这不是产品意义上的"限制"**：界面上「工具步数上限」留空就等于不限制，
 * 实际用的是这个数；只有防止模型卡在循环里把连接和服务跑穿这一层意思。
 * 正常情况下模型不需要工具时自己就停了，这个数字平时根本碰不到。
 */
const MAX_STEPS_CEILING = 100;

/** 流式事件：SSE 接口把它原样转成帧，前端按 type 分发。 */
export type AgentEvent =
  | { type: "thinking"; text: string }
  | { type: "answer"; text: string }
  /** 这一轮的文字其实是"要调工具"的过渡语，界面要把它清掉，别和最终结论混在一起。 */
  | { type: "answerReset" }
  | { type: "step"; step: ReasoningStep }
  | { type: "done"; run: ReasoningRun };

export type RunReasoningOptions = {
  question: string;
  context: ToolContext;
  /** 被用户关掉的工具名；不传 = 全开（平台自己停用的那几个仍然不放开）。 */
  disabledTools?: string[];
  /** 步数上限；不传就是"不限制"，服务端兜到 MAX_STEPS_CEILING。 */
  maxSteps?: number;
  /** 是否让模型先思考。默认交给服务端（实测默认开启）；false 会显式下发 thinking.type=disabled。 */
  thinking?: boolean;
  /**
   * 自定义系统提示词（「问答配置」里改的那段）。空白或没传 = 用 prompt.ts 的默认提示词。
   * 不管用哪一段，**本体概念清单都由 buildInstructions 自动接在后面**。
   */
  systemPrompt?: string;
  /** 客户端断开时把整个运行也停掉。 */
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};
export async function runReasoning(options: RunReasoningOptions): Promise<ReasoningRun> {
  const settings = llmSettings();
  if (!settings) throw new Error("还没有配置推理模型：请在 .env.local 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，然后重启开发服务。");
  const question = options.question.trim();
  if (!question) throw new Error("问题不能为空。");

  const emit = options.onEvent ?? (() => {});
  const maxSteps = Math.min(MAX_STEPS_CEILING, Math.max(1, Math.floor(options.maxSteps ?? MAX_STEPS_CEILING)));
  const startedAt = Date.now();

  // 工具执行时按 toolCallId 把证据记在旁边，读流时再取回来 —— 不放进给模型看的返回值里。
  const evidenceByCall = new Map<string, ReasoningEvidence[]>();
  const running = new Map<string, { tool: string; args: Record<string, unknown>; startedAt: number }>();
  const steps: ReasoningStep[] = [];
  const evidence: ReasoningEvidence[] = [];
  let reasoning = "";
  let answer = "";
  /** 当前这一轮已经流出去的文字；模型若在这一轮调工具，它就是过渡语。 */
  let stepText = "";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  /**
   * 推理步数：一次「模型调用」算一步（AI SDK 的 step），一步里模型可以并发调多个工具。
   * 必须和 stopWhen 用同一个单位，否则"工具调用次数"会被当成"步数"提前报上限。
   */
  let stepCount = 0;

  const agent = new ToolLoopAgent({
    model: llmModel(settings),
    // 提示词可由用户在「问答配置」里改；本体概念清单永远由 buildInstructions 接在后面。
    instructions: buildInstructions(options.systemPrompt, options.context),
    tools: reasoningToolSet(options.context, (toolCallId, items) => {
      evidenceByCall.set(toolCallId, items.map((item) => ({ ...item, step: 0 })));
    }, options.disabledTools ?? []),
    stopWhen: stepCountIs(maxSteps),
    // 思考开关必须放在构造层：AgentCallParameters（stream()/generate() 的入参）没有 providerOptions。
    providerOptions: thinkingProviderOptions(options.thinking),
  });

  const messages: ModelMessage[] = [{ role: "user", content: question }];
  const result = await agent.stream({
    messages,
    abortSignal: options.abortSignal,
  });

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "reasoning-delta":
        reasoning += part.text;
        emit({ type: "thinking", text: part.text });
        break;

      case "text-delta":
        stepText += part.text;
        answer += part.text;
        emit({ type: "answer", text: part.text });
        break;

      case "start-step":
        stepCount += 1;
        stepText = "";
        break;

      case "tool-call": {
        // 模型要调工具了：刚流出去的那段文字是过渡语，不算结论。
        if (stepText.trim()) {
          emit({ type: "answerReset" });
          answer = answer.slice(0, answer.length - stepText.length);
        }
        stepText = "";
        running.set(part.toolCallId, { tool: part.toolName, args: (part.input ?? {}) as Record<string, unknown>, startedAt: Date.now() });
        break;
      }

      case "tool-result": {
        const current = running.get(part.toolCallId);
        running.delete(part.toolCallId);
        const index = steps.length + 1;
        const recorded = (evidenceByCall.get(part.toolCallId) ?? []).map((item) => ({ ...item, step: index }));
        const step: ReasoningStep = {
          index,
          tool: part.toolName,
          arguments: current?.args ?? {},
          result: JSON.stringify(part.output, null, 1).slice(0, 8000),
          ok: true,
          elapsedMs: Date.now() - (current?.startedAt ?? Date.now()),
          evidence: recorded,
          // 行上的摘要取"这一步拿到了什么"，与证据数是两回事（查数据类的工具没有证据）。
          summary: toolResultSummary(part.toolName, part.output),
        };
        steps.push(step);
        evidence.push(...recorded);
        emit({ type: "step", step });
        break;
      }

      case "tool-error": {
        const current = running.get(part.toolCallId);
        running.delete(part.toolCallId);
        const step: ReasoningStep = {
          index: steps.length + 1,
          tool: part.toolName,
          arguments: current?.args ?? {},
          result: `错误：${part.error instanceof Error ? part.error.message : String(part.error)}`,
          ok: false,
          elapsedMs: Date.now() - (current?.startedAt ?? Date.now()),
          evidence: [],
        };
        steps.push(step);
        emit({ type: "step", step });
        break;
      }

      case "finish":
        usage = {
          promptTokens: part.totalUsage.inputTokens ?? 0,
          completionTokens: part.totalUsage.outputTokens ?? 0,
          totalTokens: part.totalUsage.totalTokens ?? 0,
        };
        break;

      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));

      default:
        break;
    }
  }

  const exhausted = stepCount >= maxSteps;
  const finalAnswer = answer.trim() || (exhausted ? "达到步数上限，结论可能不完整。可以缩小问题范围后重试。" : "模型没有给出结论。");
  const deduped = [...new Map(evidence.map((item) => [`${item.kind}\u0000${item.id}`, item])).values()];
  const run: ReasoningRun = {
    question,
    answer: finalAnswer,
    reasoning,
    steps,
    evidence: deduped,
    usage,
    elapsedMs: Date.now() - startedAt,
    model: settings.modelId,
    stepCount,
    maxSteps,
    truncated: exhausted,
  };
  emit({ type: "done", run });
  return run;
}
