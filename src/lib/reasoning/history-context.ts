import { generateText } from "ai";
import { LLM_PROVIDER_NAME, llmModel, llmSettings } from "@/lib/reasoning/provider";
import { HISTORY_LIMITS, planHistory, type HistoryLimits, type HistoryTurn, type ReasoningHistory } from "@/lib/reasoning/history";
import { historyMessagesForModel, summaryMessagesForModel } from "@/lib/reasoning/history-messages";
import { loadConversationContext, saveConversationSummary, type ConversationScope } from "@/lib/reasoning/conversations";

/**
 * 多轮上下文的**服务端**那一半：把这段对话的历史读出来，决定回放哪些、把更早的压成摘要。
 *
 * 消息本身不在这里拼 —— 拷回模型的一问一答（连工具调用与结果）由 `history-messages.ts` 交给
 * AI SDK 的 `convertToModelMessages()` + `pruneMessages()` 产出，这一层只做框架不管的三件事：
 * 读写对话记录、决定窗口、调一次模型压摘要。
 *
 * 三条不变量：
 * 1. **压缩是增量的**：摘要与"压到哪一条消息"一起存回 `reasoning_conversations`，下一轮只压新滚出窗口的那几轮；
 * 2. **压缩失败不推翻这一轮**：摘要保持老的那份（或空），上下文少一点，结论照常跑，warning 随 run 出去；
 * 3. **图片不重放**：只在回放的用户消息里注明张数（见 history.ts）。
 */

/** 没有任何历史时的返回值：所有调用点都不用判空。 */
export function emptyHistory(): ReasoningHistory {
  return { summary: "", messages: [], verbatimTurns: 0, compressedTurns: 0, chars: 0 };
}

/**
 * 压摘要的提示词。
 *
 * 要的是"下一轮接着聊必须知道的"，不要过程细节 —— 轨迹本来就会原样带给最近两轮，
 * 摘要再把过程抄一遍只是白烧 token。
 */
const SUMMARY_INSTRUCTION = `你在为同一段对话的后续轮次维护一份上文摘要。把给你的这几轮问答压成一段中文摘要，供后面接着聊。

必须保留：
1. 用户到底在问什么、口径是怎么定的（时间范围、过滤条件、统计维度、"在网/战客"这类业务口径取哪些值）；
2. 已经确认过的对象类型、关系类型，以及它们绑定的表名与字段名（表名写全「模式.表」）；
3. 已经给过的关键数字与结论（带单位与口径）；
4. 还没解决、下一轮要接着办的事。

不要写：工具调用的过程（调了几次、参数原文）、客套话、与后续无关的内容。
不要编造任何没出现过的数字、字段或表名。和上一版摘要冲突时，以新材料为准。`;

/** 把若干轮压成一段摘要；失败就抛，由调用方决定怎么退。 */
async function compress(previousSummary: string, turns: readonly HistoryTurn[], limits: HistoryLimits): Promise<string> {
  const settings = llmSettings();
  if (!settings) throw new Error("还没有配置推理模型。");
  // 只喂结论（轨迹与思考都裁掉）：摘要要的是口径与数字，不是"调了几次工具"。
  const messages = await summaryMessagesForModel(turns);
  if (!messages.length) throw new Error("这几轮里没有可压缩的内容。");
  // 材料就是框架产的那几条模型消息，这里只补一句"要干什么"（上一版摘要一并交代，好让它覆盖而不是叠加）。
  const ask = previousSummary.trim()
    ? `把上面的对话压成一段摘要。这是上一版摘要，要被这次的结果取代：\n${previousSummary.trim()}`
    : "把上面的对话压成一段摘要。";
  const result = await generateText({
    model: llmModel(settings),
    instructions: SUMMARY_INSTRUCTION,
    messages: [...messages, { role: "user", content: ask }],
    // 压缩是"重写"不是"推理"：关掉思考，快且省。
    providerOptions: { [LLM_PROVIDER_NAME]: { thinking: { type: "disabled" } } },
  });
  const text = result.text.trim();
  if (!text) throw new Error("压缩返回了空摘要。");
  return text.length > limits.summaryChars ? `${text.slice(0, limits.summaryChars)}…（摘要已截断）` : text;
}

export type PrepareHistoryInput = {
  scope: ConversationScope;
  userId: string;
  /** 没有就是新对话：没有历史可带。 */
  conversationId: string | null;
  /** 「问答配置」里的「历史轮数」；不传 = 默认 5，0 = 完全不带历史。 */
  verbatimTurns?: number;
  limits?: HistoryLimits;
  /** 真要压缩时回调一次（界面用它显示"正在整理上下文"）。 */
  onCompress?: (turns: number) => void;
};

export async function prepareHistory(input: PrepareHistoryInput): Promise<ReasoningHistory> {
  const limits = input.limits ?? HISTORY_LIMITS;
  if (!input.conversationId) return emptyHistory();

  const stored = await loadConversationContext(input.scope, input.userId, input.conversationId);
  // 读不到（别人的 / 已删掉）就当没有历史：真正该报错的是后面那句"这段对话不属于你"。
  if (!stored || !stored.turns.length) return { summary: stored?.summary ?? "", messages: [], verbatimTurns: 0, compressedTurns: 0, chars: 0 };

  // 已经把哪几轮压进摘要了？`history_summary_through` 之后的就是这次要处理的。
  const foldedIndex = stored.summaryThrough ? stored.turns.findIndex((turn) => turn.id === stored.summaryThrough) : -1;
  const foldedCount = foldedIndex >= 0 ? foldedIndex + 1 : 0;
  const plan = planHistory(stored.turns.slice(foldedCount), { limits, verbatimTurns: input.verbatimTurns });

  let summary = stored.summary;
  let compressedTurns = foldedCount;
  let warning = "";
  if (plan.compressed.length) {
    input.onCompress?.(plan.compressed.length);
    try {
      summary = await compress(summary, plan.compressed, limits);
      compressedTurns = foldedCount + plan.compressed.length;
      await saveConversationSummary(input.conversationId, summary, plan.compressed[plan.compressed.length - 1].id);
    } catch (reason) {
      // 压不动就少带一点上下文，别把这一轮问答搞挂：摘要保持老的那份，滚出去的那几轮这次就不带了。
      warning = `上下文压缩没能完成（${reason instanceof Error ? reason.message : "未知原因"}），本轮只带了最近 ${plan.verbatim.length} 轮。`;
      compressedTurns = foldedCount;
    }
  }

  return {
    summary,
    messages: await historyMessagesForModel(plan.verbatim),
    verbatimTurns: plan.verbatim.length,
    compressedTurns,
    chars: plan.verbatimChars,
    ...(warning ? { warning } : {}),
  };
}