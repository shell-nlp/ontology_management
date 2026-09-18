import { describe, expect, it } from "vitest";
import { STOPPED_ANSWER_FALLBACK, worthKeepingTurn } from "@/lib/reasoning/agent";
import type { ReasoningRun } from "@/lib/reasoning/types";

/**
 * "这一轮值不值得进对话历史"的判定。
 *
 * 背景：用户点「停止」时客户端断开连接，编排层照样把已经跑出来的部分收尾成一份运行记录
 * （`stopped: true`），落库前要在这里过一道 —— 有东西可看才记，什么都没跑出来不记。
 * 这一条规则以前只写在路由里，改起来看不见；抽成纯函数就是为了能在这里钉住。
 */

function run(patch: Partial<ReasoningRun> = {}): ReasoningRun {
  return {
    question: "本体里有哪些对象类型？",
    answer: "有 19 个对象类型。",
    reasoning: "",
    steps: [],
    evidence: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    elapsedMs: 1200,
    model: "test-model",
    stepCount: 1,
    maxSteps: 100,
    truncated: false,
    ...patch,
  };
}

describe("worthKeepingTurn", () => {
  it("跑完的一律记，哪怕一句结论都没有", () => {
    expect(worthKeepingTurn(run({ answer: "", reasoning: "", steps: [] }))).toBe(true);
  });

  it("步数用满被拦停的一轮照样记（那是被上限拦的，不是用户叫停的）", () => {
    expect(worthKeepingTurn(run({ answer: "", truncated: true, stepCount: 100 }))).toBe(true);
  });

  it("被叫停但跑出过步骤：记下来，回看时能看到停在哪一步", () => {
    const stopped = run({ stopped: true, answer: STOPPED_ANSWER_FALLBACK, steps: [
      { index: 1, tool: "run_sql", arguments: {}, result: "…", ok: true, elapsedMs: 12, evidence: [] },
    ] });
    expect(worthKeepingTurn(stopped)).toBe(true);
  });

  it("被叫停但只留下思考过程：也记", () => {
    expect(worthKeepingTurn(run({ stopped: true, answer: STOPPED_ANSWER_FALLBACK, reasoning: "先看概念清单…" }))).toBe(true);
  });

  it("被叫停但写了半截结论：记", () => {
    expect(worthKeepingTurn(run({ stopped: true, answer: "目前查到 3 张表…" }))).toBe(true);
  });

  it("被叫停且什么都没跑出来：不记，免得历史里多一条空条目", () => {
    expect(worthKeepingTurn(run({ stopped: true, answer: STOPPED_ANSWER_FALLBACK, reasoning: "", steps: [] }))).toBe(false);
    expect(worthKeepingTurn(run({ stopped: true, answer: "", reasoning: "   ", steps: [] }))).toBe(false);
  });
});