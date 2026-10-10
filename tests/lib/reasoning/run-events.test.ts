import { describe, expect, it } from "vitest";
import { applyRunEvent, emptyRunViewState, foldRunEvents } from "@/lib/reasoning/run-events";

/**
 * 事件流 → 界面状态。
 *
 * 这个 reducer 是"后台运行"能成立的关键：一轮推理跑在服务端，界面只是**接上这条流**，
 * 所以「一开始就在看」和「切走一会儿再回来（从游标处补看）」必须折出同一份状态。
 * 它同时被服务端（写事件）和浏览器（折状态）引用，改之前先看这里。
 */
describe("run-events 折叠", () => {
  it("文字是按增量累加的（服务端会把连续的增量并成一条，界面拼出来的结果不变）", () => {
    const state = foldRunEvents([
      { type: "thinking", text: "先" },
      { type: "thinking", text: "看看" },
      { type: "answer", text: "结" },
      { type: "answer", text: "论" },
    ]);
    expect(state.thinking).toBe("先看看");
    expect(state.answer).toBe("结论");
  });

  it("answerReset 把过渡语挪进思考过程，不要丢（关掉思考时模型把旁白写在结论里）", () => {
    const state = foldRunEvents([
      { type: "thinking", text: "想：" },
      { type: "answer", text: "我先查一下" },
      { type: "answerReset" },
    ]);
    expect(state.thinking).toBe("想：\n我先查一下");
    expect(state.answer).toBe("");
  });

  it("上下文、步骤、收尾与落库都按顺序落进状态", () => {
    const state = foldRunEvents([
      { type: "context", phase: "start" },
      { type: "context", phase: "compressing", turns: 6 },
      { type: "context", phase: "ready", history: { verbatimTurns: 5, compressedTurns: 6, summaryChars: 12, chars: 34 } },
      { type: "step", step: { index: 1, tool: "search_schema", arguments: { queries: ["专线"] }, ok: true, summary: "命中", elapsedMs: 12, result: "{}", evidence: [] } },
      { type: "saved", conversationId: "c-1" },
      { type: "done", run: { question: "q", answer: "a", reasoning: "", steps: [], evidence: [], usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 }, elapsedMs: 5, model: "m", stepCount: 1, maxSteps: 8, truncated: false } },
    ]);
    expect(state.preparing).toBe(false);
    expect(state.context?.verbatimTurns).toBe(5);
    expect(state.steps).toHaveLength(1);
    expect(state.savedConversationId).toBe("c-1");
    expect(state.run?.answer).toBe("a");
    expect(state.finished).toBe(true);
  });

  it("被叫停的一轮标 stopped：是停了，不是错了", () => {
    const state = foldRunEvents([
      { type: "done", run: { question: "q", answer: "半截", reasoning: "", steps: [], evidence: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, elapsedMs: 9, model: "m", stepCount: 1, maxSteps: 8, truncated: false, stopped: true } },
    ]);
    expect(state.stopped).toBe(true);
    expect(state.error).toBeNull();
  });

  it("每次折叠都返回新对象，不改入参（React 靠引用比较）", () => {
    const before = emptyRunViewState();
    const after = applyRunEvent(before, { type: "answer", text: "x" });
    expect(after).not.toBe(before);
    expect(before.answer).toBe("");
    expect(after.answer).toBe("x");
  });
});
