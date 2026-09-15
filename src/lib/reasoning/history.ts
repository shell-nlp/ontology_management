import type { ModelMessage, UIMessage } from "ai";
import type { ReasoningContext, ReasoningStep } from "@/lib/reasoning/types";

/**
 * 多轮上下文：窗口怎么取、消息怎么拼、摘要怎么标注（纯函数，有单测）。
 *
 * **消息本身交给 AI SDK**：历史回放不是我们拼文本，而是把每一轮还原成框架自己的 `UIMessage`
 * （assistant 的 parts 里是 `tool-*` 调用与结果 + 结论文本），再交给 `convertToModelMessages()` 转成
 * 模型消息、`pruneMessages()` 决定哪些轨迹留 —— 见 history-messages.ts。
 * 这一层只管三件框架不管的事：
 * 1. **窗口**：最近几轮原样带、更早的进压缩（默认 5 轮）；
 * 2. **摘要标注**：压缩后的摘要怎么写给模型看（说清"只作线索"）；
 * 3. **界面文案**：`上下文 5 轮 · 已压缩 3 轮`。
 *
 * 图片**不重放**：历史里的图片只在用户消息里注明张数。重发像素等于每轮把图再算一遍 token，
 * 而"这一轮带了图"这件事本身对追问已经足够（真要接着问图，重新贴一次最省事）。
 */

/** 要回放给模型的一轮历史（我们库里存的那一份裁出来的形状）。 */
export type HistoryTurn = {
  /** 消息 id。压缩进度按它记（`history_summary_through`），所以必须是原样的 id。 */
  id: string;
  question: string;
  answer: string;
  steps: ReasoningStep[];
  /** 这一轮带了几张图片（只记张数，不重发）。 */
  images?: number;
};

export const HISTORY_LIMITS = {
  /** 原样带上去的最近轮数。 */
  verbatimTurns: 5,
  /** 原样部分的字符预算（兜底：一轮特别长时不要把它和前面几轮一起塞进去）。 */
  verbatimChars: 16_000,
  /** 摘要本身的上限。 */
  summaryChars: 3_000,
} as const;

export type HistoryLimits = { readonly [K in keyof typeof HISTORY_LIMITS]: number };

/** 交给编排层的那一份历史（`agent.ts` 的入参、`run.context` 的来源都是它）。 */
export type ReasoningHistory = {
  /** 更早轮次压成的摘要；空串就是没有。这一条拼进 instructions（见 prompt.ts）。 */
  summary: string;
  /** 已经由框架转换成模型消息的历史（含工具调用与结果）。 */
  messages: ModelMessage[];
  /** 原样回放的轮数（界面与审计用它，别去数 messages：一轮可能对应好几条模型消息）。 */
  verbatimTurns: number;
  /** 累计压进摘要的轮数（含以前压的）。 */
  compressedTurns: number;
  /** 原样那几轮的字数，界面与审计都看这个数。 */
  chars: number;
  /** 压缩失败这类情况只影响上下文，不该把整轮问答搞挂，所以随结果带出去。 */
  warning?: string;
};

/**
 * 把一轮还原成两条框架消息：用户问题 + assistant（工具调用与结果 + 结论）。
 *
 * 工具这一步是**框架格式**而不是我们拼的文本：`tool-<名字>` part 里带 toolCallId / input / output，
 * 由 convertToModelMessages 还原成模型侧的 tool-call + tool-result —— 配对、裁剪都不用我们操心。
 * 思考过程刻意不放（一轮就有几千字，回放它最贵、信息量最低；要的是结论与轨迹）。
 */
export function turnUIMessages(turn: HistoryTurn): UIMessage[] {
  const question = turn.images
    ? `${turn.question}\n（这一轮还带了 ${turn.images} 张图片，图片内容不在上下文里）`
    : turn.question;
  const parts: UIMessage["parts"] = turn.steps.map((step) => {
    const toolCallId = `${turn.id}:${step.index}`;
    const input = step.arguments ?? {};
    return step.ok
      ? { type: `tool-${step.tool}`, toolCallId, state: "output-available" as const, input, output: step.result }
      : { type: `tool-${step.tool}`, toolCallId, state: "output-error" as const, input, errorText: step.result };
  });
  if (turn.answer) parts.push({ type: "text", text: turn.answer });
  return [
    { id: `${turn.id}:user`, role: "user", parts: [{ type: "text", text: question }] },
    { id: `${turn.id}:assistant`, role: "assistant", parts },
  ];
}

/** 一轮在窗口里占多少字符：问题 + 结论 + 轨迹的粗略长度，够算预算就行。 */
export function turnChars(turn: HistoryTurn): number {
  return turn.question.length + turn.answer.length + turn.steps.reduce((sum, step) => sum + step.result.length, 0);
}

export type HistoryPlan = {
  /** 原样带上去的最近几轮（时间正序）。 */
  verbatim: HistoryTurn[];
  /** 该压进摘要的那几轮（时间正序）。 */
  compressed: HistoryTurn[];
  verbatimChars: number;
};

/**
 * 从最近一轮往回取"原样窗口"，剩下的都进压缩。
 *
 * 两条规矩：
 * 1. **至少留最近一轮**（除非用户把轮数设成 0）：追问全靠它；
 * 2. 轮数或字符预算哪个先到就停；轮数设成 0 = **完全不带历史**（也不压缩）——
 *    那是"我就要单轮问答"的明确意思，别偷偷压。
 */
export function planHistory(turns: readonly HistoryTurn[], options: { limits?: HistoryLimits; verbatimTurns?: number } = {}): HistoryPlan {
  const limits = options.limits ?? HISTORY_LIMITS;
  const maxTurns = Math.max(0, Math.floor(options.verbatimTurns ?? limits.verbatimTurns));
  if (!maxTurns) return { verbatim: [], compressed: [], verbatimChars: 0 };
  const verbatim: HistoryTurn[] = [];
  let chars = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const size = turnChars(turn);
    if (verbatim.length >= maxTurns) break;
    if (verbatim.length > 0 && chars + size > limits.verbatimChars) break;
    verbatim.unshift(turn);
    chars += size;
  }
  const kept = new Set(verbatim.map((turn) => turn.id));
  return { verbatim, compressed: turns.filter((turn) => !kept.has(turn.id)), verbatimChars: chars };
}

/**
 * 摘要怎么标注给模型看。
 *
 * 必须写清"这是压缩过的、只作线索"：旧结论里的对象类型名、表名、数字都可能已经变了，
 * 模型要是把它们当成本轮的事实复用，就会答出一份"看着很确定但没查过"的结论。
 */
export function summaryBlock(summary: string): string {
  const text = summary.trim();
  if (!text) return "";
  return [
    "【本次对话之前轮次的摘要】更早的轮次已经压成下面这段，只作线索：",
    "口径、已确认过的表与字段、已经给过的结论可以接着用；但凡涉及具体数字、字段、表名或对象类型名，仍要用本轮的工具重新核对一遍再下结论。",
    text,
  ].join("\n");
}

/** 界面与审计用的一句话：`上下文 5 轮 · 已压缩 3 轮`。 */
export function historyLabel(context: ReasoningContext | undefined): string {
  if (!context) return "";
  const parts = [`上下文 ${context.verbatimTurns} 轮`];
  if (context.compressedTurns) parts.push(`已压缩 ${context.compressedTurns} 轮`);
  return parts.join(" · ");
}
