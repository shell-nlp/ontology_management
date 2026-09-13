import { complete, llmConfig, type LlmMessage } from "@/lib/reasoning/llm";
import { REASONING_TOOLS, runReasoningTool, type ToolContext } from "@/lib/reasoning/tools";
import type { ReasoningEvidence, ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";

/**
 * 本体推理闭环的编排层。
 *
 * 模型只负责"下一步该查什么"，事实全部来自 tools.ts 的确定性查询；
 * 每一步都留痕（工具、入参、结果、耗时、引用的真实 id），
 * 界面上因此能展示"这个结论是怎么推出来的"，而不是一个黑箱答案。
 */

const DEFAULT_MAX_STEPS = 8;
const SCHEMA_RESULT_CAP = 14_000;
const DATA_RESULT_CAP = 9_000;
const SCHEMA_TOOLS = new Set(["search_schema", "get_object_type", "list_actions"]);

const SYSTEM_PROMPT = `你是本体（ontology）推理助手。平台里已经建好一个业务本体，并在图数据库中发布了实例数据。

工作方式：
1. 先理解问题涉及哪些业务概念，用 search_schema 确认本体里真实存在的对象类型与关系类型名字。
2. 需要字段、父类、可用动作时调 get_object_type 或 list_actions；需要对象时调 query_object_instance；需要看对象之间怎么连时调 query_instance_subgraph。
3. 复杂问题拆成多步：先定位对象，再顺着关系类型展开，最后再下结论。

硬性要求：
- 只能依据工具返回的真实数据回答。不要编造对象、属性、关系或统计数字。
- 引用对象时必须使用工具返回过的 object_id，不要自己构造 id。
- 对父类型查询时子类型的实例也会一起返回，注意看每个实例的 labels 判断它具体属于哪个类型。
- 如果本体或图库里确实没有这部分数据，直接说明"当前本体没有这部分数据"，并指出缺的是哪个对象类型、属性或关系类型，不要用常识猜测。
- 结果被截断（返回里出现 truncated 提示）时，不要当成完整数据；用更精确的条件再查一次。

输出要求：用中文回答，先给结论，再列依据（引用了哪些对象类型/关系类型/对象）。结论要能追溯到上面的工具结果。`;

export type RunReasoningOptions = {
  question: string;
  context: ToolContext;
  maxSteps?: number;
};

function parseArguments(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function capResult(text: string, tool: string) {
  const limit = SCHEMA_TOOLS.has(tool) ? SCHEMA_RESULT_CAP : DATA_RESULT_CAP;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[结果过长已截断，剩余 ${text.length - limit} 个字符。请用更精确的条件或更小的 limit 重新查询，不要把它当成完整数据。]`;
}

/** 给模型的"本体概览"：只要名字清单，字段细节让它自己按需查，省 token。 */
function schemaBrief(context: ToolContext) {
  const count = (name: string) => context.runtimeTypes?.labels.find((item) => item.name === name)?.count;
  const objects = context.definition.entityTypes.map((item) => {
    const amount = count(item.name);
    return amount == null ? item.name : `${item.name}(${amount})`;
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
  const config = llmConfig();
  if (!config) throw new Error("还没有配置推理模型：请在 .env.local 里填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，然后重启开发服务。");
  const question = options.question.trim();
  if (!question) throw new Error("问题不能为空。");

  const maxSteps = Math.min(16, Math.max(1, Math.floor(options.maxSteps ?? DEFAULT_MAX_STEPS)));
  const startedAt = Date.now();
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `当前本体的概念清单（括号里是对象数）：\n${schemaBrief(options.context)}` },
    { role: "user", content: question },
  ];

  const steps: ReasoningStep[] = [];
  const evidence: ReasoningEvidence[] = [];
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let answer = "";
  let truncated = false;

  for (let turn = 0; turn < maxSteps; turn += 1) {
    const completion = await complete(config, { messages, tools: REASONING_TOOLS, maxTokens: 4096, timeoutMs: 150_000 });
    usage.promptTokens += completion.usage.promptTokens;
    usage.completionTokens += completion.usage.completionTokens;
    usage.totalTokens += completion.usage.totalTokens;

    if (!completion.toolCalls.length) {
      answer = completion.content.trim();
      break;
    }

    messages.push({ role: "assistant", content: completion.content, toolCalls: completion.toolCalls });
    for (const call of completion.toolCalls) {
      const stepStarted = Date.now();
      const args = parseArguments(call.argumentsText);
      let ok = true;
      let result: string;
      let stepEvidence: Omit<ReasoningEvidence, "step">[] = [];
      try {
        const outcome = await runReasoningTool(call.name, args, options.context);
        result = capResult(JSON.stringify(outcome.payload), call.name);
        stepEvidence = outcome.evidence;
      } catch (error) {
        ok = false;
        result = `错误：${error instanceof Error ? error.message : String(error)}`;
      }
      const index = steps.length + 1;
      const recorded = stepEvidence.map((item) => ({ ...item, step: index }));
      steps.push({ index, tool: call.name, arguments: args, result, ok, elapsedMs: Date.now() - stepStarted, evidence: recorded });
      evidence.push(...recorded);
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }

    if (turn === maxSteps - 1) truncated = true;
  }

  if (!answer) answer = truncated ? "达到步数上限，结论可能不完整。可以缩小问题范围后重试。" : "模型没有给出结论。";

  const deduped = [...new Map(evidence.map((item) => [`${item.kind}\u0000${item.id}`, item])).values()];
  return {
    question,
    answer,
    steps,
    evidence: deduped,
    usage,
    elapsedMs: Date.now() - startedAt,
    model: config.model,
    truncated,
  };
}
