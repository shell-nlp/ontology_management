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

/**
 * 步数兜底上限。**这不是产品意义上的"限制"**：界面上「工具步数上限」留空就等于不限制，
 * 实际用的是这个数；只有防止模型卡在循环里把连接和服务跑穿这一层意思。
 * 正常情况下模型不需要工具时自己就停了，这个数字平时根本碰不到。
 */
const MAX_STEPS_CEILING = 100;

const SYSTEM_PROMPT = `你是本体（ontology）推理助手。平台里已经建好一个业务本体，你可以读它的**定义**。

工作方式：
1. 先理解问题涉及哪些业务概念，用 search_schema 确认本体里真实存在的对象类型与关系类型名字。
2. 需要字段、父类、一跳的关系类型、可用动作、数据来源绑定（这个对象类型绑了哪张表）时调 get_object_type 或 list_actions。
3. 问"某对象类型一圈都和什么有关""隔两跳能到哪些类型""A 和 B 之间怎么连"时用 traverse_object_types（默认 3 跳、最多 5 跳，可用 object_types / relationship_types 限定范围，不填就是不限定）。一跳的细节就在 get_object_type 里，不必重复调。
4. **概念分组（业务域）和每组包含的对象类型已经写在下面的概念清单里**，直接据此回答；要看"哪些类型还没归组"这类完整清单才需要 list_concept_groups。
5. 要具体数据时走"对象类型 → 它绑定的表"：先 get_table_ddl 看表结构，再 run_sql 只读查数。
6. 复杂问题拆成多步：先定位涉及哪几个对象类型，再逐个读它们的定义与关系，最后再下结论。

硬性要求：
- 只能依据工具返回的真实数据回答。不要编造对象类型、属性、关系类型、动作或数据来源。
- **本体这一层只到定义**：不查图库里的对象与关系（本体实例）。要真实数据就走源表 —— get_table_ddl 看结构、run_sql 只读查数，两者都用对象类型绑定的那张表。
- 被问到"本体里有哪些对象""某个具体对象是什么"这类实例问题时，说明这一版不提供实例推理，并给出可行的替代：查它绑定的表，或到平台的「对象」「图谱」页看。**不要凭空编一个对象。**
- 写操作一律不做：run_sql 只能读，动作只描述不执行。
- 如果本体里确实没有这个概念，直接说明"当前本体没有这个对象类型 / 关系类型 / 动作"，并指出缺的是哪一项，不要用常识猜测。
- 结果被截断（返回里出现 truncated 提示）时，不要当成完整数据；用更精确的条件再查一次。

输出要求：用中文回答，先给结论，再列依据（引用了哪些对象类型 / 关系类型 / 动作）。结论要能追溯到上面的工具结果。`;

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
  /** 步数上限；不传就是"不限制"，服务端兜到 MAX_STEPS_CEILING。 */
  maxSteps?: number;
  /** 是否让模型先思考。默认交给服务端（实测默认开启）；false 会显式下发 thinking.type=disabled。 */
  thinking?: boolean;
  /** 客户端断开时把整个运行也停掉。 */
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
};

/**
 * 给模型的"本体概览"：概念分组（含每组有哪些对象类型）+ 类型清单 + 绑定的表名。
 *
 * 概念分组**把成员直接写在这里**：用户问"某业务域里有什么"是最常见的一类问题，
 * 提前给到就不必再调一次 list_concept_groups，也不至于出现"分组明明建了、模型说没有"。
 * 表名同样要带上：用户常问"某个对象类型绑了哪张表"。
 * **不带对象数**：这一层不推理实例，给了数字模型就会拿它下实例层面的结论。
 */
export function schemaBrief(context: ToolContext) {
  const groups = context.definition.groups ?? [];
  const groupIds = new Set(groups.map((item) => item.id));
  const membersByGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const item of context.definition.entityTypes) {
    const groupId = item.groupId ?? "";
    if (!groupId || !groupIds.has(groupId)) { ungrouped.push(item.name); continue; }
    const bucket = membersByGroup.get(groupId);
    if (bucket) bucket.push(item.name);
    else membersByGroup.set(groupId, [item.name]);
  }
  const groupsLine = groups.map((group) => {
    const members = membersByGroup.get(group.id) ?? [];
    return `${group.name}（${members.length} 个：${members.join("、") || "还没有对象类型"}）`;
  }).join("；");
  const objects = context.definition.entityTypes.map((item) => {
    const tables = entitySources(item).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    return tables.length ? `${item.name}(绑定 ${tables.join(" + ")})` : item.name;
  });
  const relations = context.definition.relationshipTypes.map((item) => item.name);
  const actions = context.definition.actionTypes.map((item) => item.name);
  // 数据资源名要带上：run_sql / get_table_ddl 的 data_source 就用这里的名字，模型猜不出来。
  const sources = (context.dataSources ?? []).map((item) => `${item.name}（${item.kind}${item.schema_name ? ` · ${item.schema_name}` : ""}）`);
  return [
    `概念分组：${groupsLine || "无"}${ungrouped.length ? `；未归组：${ungrouped.join("、")}` : ""}`,
    `对象类型：${objects.join("、") || "无"}`,
    `关系类型：${relations.join("、") || "无"}`,
    `动作：${actions.join("、") || "无"}`,
    `数据资源：${sources.join("、") || "无"}（run_sql / get_table_ddl 的 data_source 用这里的名字）`,
  ].join("\n");
}

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
    instructions: `${SYSTEM_PROMPT}\n\n当前本体的概念清单（括号里是它绑定的表）：\n${schemaBrief(options.context)}`,
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
