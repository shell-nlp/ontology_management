import { convertToModelMessages, pruneMessages, type ModelMessage } from "ai";
import { turnUIMessages, type HistoryTurn } from "@/lib/reasoning/history";

/**
 * 历史 → 模型消息，**这一层全是框架的活**：
 *
 * 1. `convertToModelMessages()`：把我们还原出来的 `UIMessage`（assistant 的 parts 里有 `tool-*` 调用与结果）
 *    转成模型消息 —— tool-call 与 tool-result 的配对、错误结果、附件都在框架里处理，
 *    比自己拼一段"轨迹文本"可靠得多（也不会因为少一条 tool-result 就被服务端拒掉）；
 * 2. `pruneMessages()`：决定哪些内容值得带回。这是框架给的裁剪口子，两个原则：
 *    - **思考过程一律不回放**（`reasoning: 'all'`）：一轮就有几千字，回放它最贵、信息量最低；
 *    - **轨迹只留最近一轮**（`toolCalls: 'before-last-message'`）：追问基本都是接着上一轮问的，
 *      更早的轮次留结论就够（结论是 assistant 的文本，不受裁剪影响），轨迹全留只是烧 token。
 *      框架会按 toolCallId 成对保留/裁剪，不会留下找不到调用的 tool-result。
 *
 * 压摘要用的是**去掉轨迹只留结论**的那一份（`toolCalls: 'all'`）：
 * 摘要要的是口径与数字，不是"调了几次工具"。
 */

/** 原样回放的那几轮 → 模型消息（含最近两轮的工具调用与结果）。 */
export async function historyMessagesForModel(turns: readonly HistoryTurn[]): Promise<ModelMessage[]> {
  if (!turns.length) return [];
  const uiMessages = turns.flatMap((turn) => turnUIMessages(turn));
  const converted = await convertToModelMessages(uiMessages, { ignoreIncompleteToolCalls: true });
  return pruneMessages({
    messages: converted,
    reasoning: "all",
    toolCalls: "before-last-message",
    emptyMessages: "remove",
  });
}

/** 压摘要时喂给模型的那一份：只要结论（轨迹与思考都去掉）。 */
export async function summaryMessagesForModel(turns: readonly HistoryTurn[]): Promise<ModelMessage[]> {
  if (!turns.length) return [];
  const uiMessages = turns.flatMap((turn) => turnUIMessages(turn));
  const converted = await convertToModelMessages(uiMessages, { ignoreIncompleteToolCalls: true });
  return pruneMessages({ messages: converted, reasoning: "all", toolCalls: "all", emptyMessages: "remove" });
}