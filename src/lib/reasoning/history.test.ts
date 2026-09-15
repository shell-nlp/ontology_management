import { describe, expect, it } from "vitest";
import { HISTORY_LIMITS, historyLabel, planHistory, summaryBlock, turnChars, turnUIMessages, type HistoryTurn } from "@/lib/reasoning/history";
import { historyMessagesForModel, summaryMessagesForModel } from "@/lib/reasoning/history-messages";

/** 一轮历史：一问一答 + 两条轨迹（一成功一失败）。 */
function turn(index: number, overrides: Partial<HistoryTurn> = {}): HistoryTurn {
  return {
    id: `m${index}`,
    question: `第 ${index} 问：专线用户有多少？`,
    answer: `第 ${index} 答：共 ${index} 条。`,
    steps: [
      { index: 1, tool: "search_schema", arguments: { query: "专线" }, result: '{"matches":3}', ok: true, elapsedMs: 20, evidence: [] },
      { index: 2, tool: "run_sql", arguments: { sql: "SELECT 1" }, result: "boom", ok: false, elapsedMs: 10, evidence: [] },
    ],
    ...overrides,
  };
}

type ModelMessages = Awaited<ReturnType<typeof historyMessagesForModel>>;
/** 只用于断言的宽松 part 视图：模型消息的 content 是一堆联合类型，逐条 narrow 太啰嗦。 */
type AnyPart = { type: string } & Record<string, unknown>;

/** 取所有 part（system 的 content 是字符串，跳过）。 */
function partsOf(messages: ModelMessages): AnyPart[] {
  const parts: AnyPart[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) parts.push(...(message.content as unknown as AnyPart[]));
  }
  return parts;
}

/** 把消息里的文本拼起来，用来断言"结论还在"。 */
function textOf(messages: ModelMessages) {
  return partsOf(messages)
    .map((part) => (part.type === "text" ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n");
}

describe("多轮上下文：窗口", () => {
  it("从最近一轮往回取，超出的进压缩", () => {
    const turns = [turn(1), turn(2), turn(3)];
    const plan = planHistory(turns, { verbatimTurns: 2 });
    expect(plan.verbatim.map((item) => item.id)).toEqual(["m2", "m3"]);
    expect(plan.compressed.map((item) => item.id)).toEqual(["m1"]);
  });

  it("至少留最近一轮；轮数填 0 = 完全不带历史（也不压缩）", () => {
    const turns = [turn(1), turn(2)];
    expect(planHistory(turns, { verbatimTurns: 1 }).verbatim.map((item) => item.id)).toEqual(["m2"]);
    const none = planHistory(turns, { verbatimTurns: 0 });
    expect(none.verbatim).toEqual([]);
    expect(none.compressed).toEqual([]);
    expect(none.verbatimChars).toBe(0);
  });

  it("字符预算兜底：一轮特别长时不把前面几轮一起塞进去", () => {
    const huge = turn(2, { answer: "答".repeat(HISTORY_LIMITS.verbatimChars + 10) });
    const plan = planHistory([turn(1), huge], { verbatimTurns: 5 });
    expect(plan.verbatim.map((item) => item.id)).toEqual(["m2"]);
    expect(plan.compressed.map((item) => item.id)).toEqual(["m1"]);
    expect(turnChars(huge)).toBeGreaterThan(HISTORY_LIMITS.verbatimChars);
  });
});

describe("多轮上下文：回放成框架消息", () => {
  it("一轮还原成 user + assistant，轨迹是框架的 tool-* part（成功 output-available、失败 output-error）", () => {
    const [user, assistant] = turnUIMessages(turn(1, { images: 2 }));
    expect(user).toMatchObject({ id: "m1:user", role: "user" });
    expect(user.parts[0]).toMatchObject({ type: "text" });
    // 图片只记张数，不把像素塞回上下文
    expect((user.parts[0] as { text: string }).text).toContain("2 张图片");
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts[0]).toMatchObject({ type: "tool-search_schema", toolCallId: "m1:1", state: "output-available", input: { query: "专线" } });
    expect(assistant.parts[1]).toMatchObject({ type: "tool-run_sql", state: "output-error", errorText: "boom" });
    // 思考过程不回放，只有结论
    expect(assistant.parts[2]).toMatchObject({ type: "text", text: "第 1 答：共 1 条。" });
    expect(assistant.parts).toHaveLength(3);
  });

  it("交给模型的是框架产的 tool-call / tool-result：只留最近一轮的轨迹，更早的留结论", async () => {
    const messages = await historyMessagesForModel([turn(1), turn(2)]);
    const callIds = partsOf(messages).filter((part) => part.type === "tool-call").map((part) => String(part.toolCallId));
    // 最近一轮（m2）的两条轨迹在，m1 的没了
    expect(callIds).toEqual(["m2:1", "m2:2"]);
    // 结论不受裁剪影响
    const text = textOf(messages);
    expect(text).toContain("第 1 答：共 1 条。");
    expect(text).toContain("第 2 答：共 2 条。");
  });

  it("压摘要用的是只有结论的那一份：轨迹一条都不带", async () => {
    const messages = await summaryMessagesForModel([turn(1), turn(2)]);
    const types = partsOf(messages).map((part) => part.type);
    expect(types).not.toContain("tool-call");
    expect(types).not.toContain("tool-result");
    const text = textOf(messages);
    expect(text).toContain("第 1 问");
    expect(text).toContain("第 2 答：共 2 条。");
  });
});

describe("多轮上下文：摘要与界面文案", () => {
  it("摘要标注写清只作线索，空摘要不占位", () => {
    expect(summaryBlock("   ")).toBe("");
    const block = summaryBlock("口径：最新周期；结论 32 条。");
    expect(block).toContain("只作线索");
    expect(block).toContain("重新核对");
    expect(block).toContain("口径：最新周期；结论 32 条。");
  });

  it("界面文案：带没带压缩分开说", () => {
    expect(historyLabel(undefined)).toBe("");
    expect(historyLabel({ verbatimTurns: 2, compressedTurns: 0, summaryChars: 0, chars: 0 })).toBe("上下文 2 轮");
    expect(historyLabel({ verbatimTurns: 5, compressedTurns: 3, summaryChars: 120, chars: 900 })).toBe("上下文 5 轮 · 已压缩 3 轮");
  });
});