import type { ReasoningContext, ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";

/**
 * 一轮推理对外的事件流（**纯类型 + 纯函数**，服务端与浏览器共用）。
 *
 * 为什么单独放一个文件：一轮推理现在由**服务端**跑（见 `run-registry.ts`），
 * 界面只是"接上这条流"。于是事件形状成了两边共同的契约：服务端往里写，
 * 浏览器按同一个 reducer 折成界面状态。谁都不该去 import 对方的实现。
 *
 * 折法是**可重放**的：`applyRunEvent` 只用事件本身算状态，因此
 * 「一开始就在看」和「切走一会儿再回来」得到的是同一份结果 —— 这正是后台运行要的东西。
 */

export type ReasoningRunEvent =
  | { type: "thinking"; text: string }
  | { type: "answer"; text: string }
  /** 这一段文字其实是"要调工具"的过渡语，界面要把它清掉，别和最终结论混在一起。 */
  | { type: "answerReset" }
  | { type: "step"; step: ReasoningStep }
  /** 多轮上下文这一步（读历史 / 压摘要）也要几秒，界面得先知道"在整理上下文"。 */
  | { type: "context"; phase: "start" | "compressing" | "ready"; turns?: number; history?: ReasoningContext }
  | { type: "done"; run: ReasoningRun }
  | { type: "saved"; conversationId: string | null; warning?: string }
  | { type: "error"; message: string };

/** 一轮推理的界面状态：由事件折出来，不含"什么时候开始的"这类本地信息。 */
export type RunViewState = {
  thinking: string;
  answer: string;
  steps: ReasoningStep[];
  context?: ReasoningContext;
  /** 正在整理上下文（读历史 / 压摘要）。 */
  preparing: boolean;
  run: ReasoningRun | null;
  error: string | null;
  /** 被用户叫停：不是失败，界面上要标出来。 */
  stopped: boolean;
  /** 这一轮落库后的对话 id；null = 还没落库（或没记上）。 */
  savedConversationId: string | null;
  savedWarning: string | null;
  /** 收尾事件（done / error）到过没有。 */
  finished: boolean;
};

export function emptyRunViewState(): RunViewState {
  return {
    thinking: "",
    answer: "",
    steps: [],
    preparing: false,
    run: null,
    error: null,
    stopped: false,
    savedConversationId: null,
    savedWarning: null,
    finished: false,
  };
}

/**
 * 折一个事件。**每次返回新对象**，方便 React 比较；不改入参。
 *
 * `answerReset` 的处理和界面过去的行为一致：那段过渡语**不能丢**（关掉思考时模型把旁白写在这里），
 * 挪进思考过程既保留过程，又不会让结论区闪出半句话。
 */
export function applyRunEvent(state: RunViewState, event: ReasoningRunEvent): RunViewState {
  switch (event.type) {
    case "thinking":
      return { ...state, thinking: state.thinking + event.text };
    case "answer":
      return { ...state, answer: state.answer + event.text };
    case "answerReset":
      return {
        ...state,
        thinking: state.thinking ? `${state.thinking}\n${state.answer}` : state.answer,
        answer: "",
      };
    case "step":
      return { ...state, steps: [...state.steps, event.step] };
    case "context":
      return event.phase === "ready"
        ? { ...state, preparing: false, context: event.history }
        : { ...state, preparing: true };
    case "done":
      return { ...state, run: event.run, stopped: event.run.stopped ?? false, preparing: false, finished: true };
    case "saved":
      return { ...state, savedConversationId: event.conversationId, savedWarning: event.warning ?? null };
    case "error":
      return { ...state, error: event.message, preparing: false, finished: true };
    default:
      return state;
  }
}

/** 折一串事件。 */
export function foldRunEvents(events: readonly ReasoningRunEvent[]): RunViewState {
  return events.reduce(applyRunEvent, emptyRunViewState());
}
