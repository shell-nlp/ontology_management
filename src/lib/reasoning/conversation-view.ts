import type { ReasoningRun } from "@/lib/reasoning/types";

/**
 * 对话历史里"给人看"的那部分：标题怎么取、一条记录归到哪一天、时间怎么写。
 *
 * 单独放一个文件是有意的：这里全是纯函数，浏览器和服务端都能引用。
 * 读数据库的 @/lib/reasoning/conversations 只能在服务端跑（它会拉起 pg 连接池），
 * 界面需要的那几个判断不能顺手从那里 import 出来。
 */

/** 会话在列表里的标题：取第一问，长了就截断——列表是给人扫的，不是给模型读的。 */
export const TITLE_MAX = 60;

/**
 * 对话历史的数据形状（接口契约）。
 *
 * 放在这个纯模块里而不是 @/lib/reasoning/conversations：界面要用这几个类型，
 * 但不该顺带把服务端的 pg 连接池拉进浏览器包。
 */
export type ConversationSummary = {
  id: string;
  title: string;
  /** 这段对话里有几轮问答。 */
  turns: number;
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  id: string;
  question: string;
  answer: string;
  thinking: string;
  thinkingOn: boolean;
  /** 那次运行的完整结果（步骤 / 证据 / 用量）；老记录可能没有。 */
  run: ReasoningRun | null;
  error: string | null;
  createdAt: string;
};

export type ConversationDetail = ConversationSummary & { messages: ConversationMessage[] };

export function conversationTitle(question: string): string {
  const text = question.replace(/\s+/g, " ").trim();
  if (text.length <= TITLE_MAX) return text;
  return `${text.slice(0, TITLE_MAX - 1)}…`;
}

export type ConversationDay = "今天" | "昨天" | "更早";

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 记录归到哪一天。刻意只有三档（今天 / 昨天 / 更早）：
 * 分得太细在侧栏里就是噪音，这三档正好回答"这是刚才问的，还是以前问的"。
 */
export function conversationDay(iso: string, now: Date = new Date()): ConversationDay {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "更早";
  const days = Math.round((startOfDay(now) - startOfDay(new Date(time))) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return "更早";
}

/** 今天 / 昨天给时刻（知道是几点问的），更早给日期（时刻已经没意义了）。 */
export function conversationTimeLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  if (conversationDay(iso, now) !== "更早") return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 按"今天 / 昨天 / 更早"分组，组内保持传进来的顺序（服务端已经按更新时间倒序）。 */
export function groupConversationsByDay<T extends { updatedAt: string }>(
  items: readonly T[],
  now: Date = new Date(),
): { day: ConversationDay; items: T[] }[] {
  const buckets = new Map<ConversationDay, T[]>();
  for (const item of items) {
    const day = conversationDay(item.updatedAt, now);
    const bucket = buckets.get(day);
    if (bucket) bucket.push(item);
    else buckets.set(day, [item]);
  }
  const order: ConversationDay[] = ["今天", "昨天", "更早"];
  return order.filter((day) => buckets.has(day)).map((day) => ({ day, items: buckets.get(day)! }));
}
