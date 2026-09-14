import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";
import { llmModel, llmSettings, thinkingProviderOptions } from "@/lib/reasoning/provider";
import { reasoningToolSet, type ToolContext } from "@/lib/reasoning/tools";
import { entitySources } from "@/lib/ontology-sources";
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

const DEFAULT_MAX_STEPS = 8;

const SYSTEM_PROMPT = `你是本体（ontology）推理助手。平台里已经建好一个业务本体，并在图数据库中发布了实例数据。

工作方式：
1. 先理解问题涉及哪些业务概念，用 search_schema 确认本体里真实存在的对象类型与关系类型名字。
2. 需要字段、父类、可用动作、数据来源绑定（这个对象类型绑了哪张表）时调 get_object_type 或 list_actions；需要对象时调 query_object_instance；需要看对象之间怎么连时调 query_instance_subgraph。
3. 复杂问题拆成多步：先定位对象，再顺着关系类型展开，最后再下结论。

硬性要求：
- 只能依据工具返回的真实数据回答。不要编造对象、属性、关系或统计数字。
- 引用对象时必须使用工具返回过的 object_id，不要自己构造 id。
- 对父类型查询时子类型的实例也会一起返回，注意看每个实例的 labels 判断它具体属于哪个类型。
- 如果本体或图库里确实没有这部分数据，直接说明"当前本体没有这部分数据"，并指出缺的是哪个对象类型、属性或关系类型，不要用常识猜测。
- 结果被截断（返回里出现 truncated 提示）时，不要当成完整数据；用更精确的条件再查一次。

输出要求：用中文回答，先给结论，再列依据（引用了哪些对象类型/关系类型/对象）。结论要能追溯到上面的工具结果。`;

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
  maxSteps?: number;
  /** 是否让模型先思考。默认交给服务端（实测默认开启）；false 会显式下发 thinking.type=disabled。 */
  thinking?: boolean;
  /** 客户端断开时把整个运行也停掉。 */
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

/**
 * 给模型的"本体概览"：名字清单 + 绑定的表名，字段细节让它自己按需查，省 token。
 * 表名要带上：用户常问"某个对象类型绑了哪张表"，提前给到就省掉一次 get_object_type 往返。
 */
function schemaBrief(context: ToolContext) {
  const count = (name: string) => context.runtimeTypes?.labels.find((item) => item.name === name)?.count;
  const objects = context.definition.entityTypes.map((item) => {
    const amount = count(item.name);
    const tables = entitySources(item).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const notes = [amount == null ? "" : String(amount), tables.length ? `绑定 ${tables.join(" + ")}` : ""].filter(Boolean).join("，");
    return notes ? `${item.name}(${notes})` : item.name;
  });
  const relations = context.definition.relationshipTypes.map((item) => item.name);
  const actions = context.definition.actionTypes.map((item) => item.name);
  return [
    `对象类型：${objects.join("、") || "无"}`,
    `关系类型：${relations.join("、") || "无"}`,
    `动作：${actions.join("、") || "无"}`,
  ].join("\n");
}

export async function runReasoning(options: RunReasoningOptions): Promise<ReasoningRun> {
  const settings = llmSettings();
  if (!settings) throw new Error("还没有配置推理模型：请在 .env.local 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，然后重启开发服务。");
  const question = options.question.trim();
  if (!question) throw new Error("问题不能为空。");

  const emit = options.onEvent ?? (() => {});
  const maxSteps = Math.min(16, Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_STEPS)));
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
    instructions: `${SYSTEM_PROMPT}\n\n当前本体的概念清单（括号里是对象数）：\n${schemaBrief(options.context)}`,
    tools: reasoningToolSet(options.context, (toolCallId, items) => {
      evidenceByCall.set(toolCallId, items.map((item) => ({ ...item, step: 0 })));
    }),
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
