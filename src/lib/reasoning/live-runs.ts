import { useSyncExternalStore } from "react";
import { api } from "@/lib/api-client";
import { authHeaders } from "@/lib/session-token";
import { applyRunEvent, emptyRunViewState, type ReasoningRunEvent, type RunViewState } from "@/lib/reasoning/run-events";
import type { ReasoningAttachment } from "@/lib/reasoning/types";

/**
 * 界面上"正在跑的那一轮"的**本机登记处**：一轮推理的状态活在这里，不活在某个组件里。
 *
 * 用户口径（2026-10-10）：「切换页面了，或者新建聊天了，放后台运行」。
 * 组件（`qa-studio`）切走就被卸载了，所以运行状态必须搬到组件外面 ——
 * 这里是个模块级的单例：谁挂着谁订阅，组件卸载只是"不看了"，接流的那条 fetch 照旧。
 *
 * 三条规矩：
 * 1. **运行归服务端**（见 `@/lib/reasoning/run-registry`）：这里只是接上它的一条流。
 *    所以刷新页面也能用 `syncLiveRuns` 把还在跑的那一轮接回来。
 * 2. **时间用前端时钟**：展示的耗时一律由这里的 `startedAtMs` / `Date.now()` 算，
 *    不用后端回的那个 `elapsedMs`（用户口径：要"实际的前端时间"）。
 * 3. 事件按**下标**存：连续的文字增量在服务端被并进同一条，所以后到的同下标事件是
 *    "替换"而不是"追加" —— 界面状态每次按下标顺序重新折一遍，天然不怕改写。
 */

export type LiveRun = RunViewState & {
  runId: string;
  targetId: string;
  /** 这一轮属于哪段对话；还没落库的新对话是 null。 */
  conversationId: string | null;
  question: string;
  attachments: ReasoningAttachment[];
  thinkingOn: boolean;
  /** 还在跑（服务端还没收尾）。 */
  running: boolean;
  /**
   * 用户按了「新对话」把它让到后台：这一轮不再画在中间那一栏（在侧栏里是"运行中"的一行）。
   * 没落库之前它没有对话 id，光看 id 分不出"就在这一段"还是"被让到后台了"，所以要显式记一下。
   */
  detached: boolean;
  /** 前端时钟：这一轮在本机开始 / 结束的时刻。 */
  startedAtMs: number;
  finishedAtMs: number | null;
  /**
   * 展示用的耗时（毫秒），**由前端时钟算**：跑的时候是 `现在 - startedAtMs`（会随 tick 增长），
   * 跑完是 `finishedAtMs - startedAtMs`。
   */
  elapsedMs: number;
};

type MutableRun = {
  runId: string;
  targetId: string;
  requestedConversationId: string | null;
  question: string;
  attachments: ReasoningAttachment[];
  thinkingOn: boolean;
  events: Map<number, ReasoningRunEvent>;
  /** 已经收到过的最大下标 + 1；接流时按它换算游标。 */
  cursor: number;
  running: boolean;
  reachedEnd: boolean;
  startedAtMs: number;
  finishedAtMs: number | null;
  stream: AbortController | null;
  retries: number;
  detached: boolean;
};

type StartLiveRunInput = {
  targetId: string;
  question: string;
  attachments: ReasoningAttachment[];
  thinking: boolean;
  conversationId: string | null;
  settings: Record<string, number | string>;
};

const runs = new Map<string, MutableRun>();
const listeners = new Set<() => void>();
/**
 * 本机最近在看的对话（按本体记）。
 *
 * 为什么需要它：一轮跑完、落库之后，本机登记处里那条记录的 id 已经变成对话 id，
 * 而**切走再回来**时画面是一段新对话（conversationId 为 null）—— 两边对不上，
 * 用户就会看到"刚问的那一轮不见了"（2026-10-10 实测）。
 * 于是把"刚才在看哪段对话"记在本机，回来时把画面接回去。翻过历史的那次也记。
 */
const lastSeen = new Map<string, string>();
let snapshot: LiveRun[] = [];
let ticker: ReturnType<typeof setInterval> | null = null;
let localSequence = 0;

function viewStateOf(run: MutableRun): RunViewState {
  const indexes = [...run.events.keys()].sort((left, right) => left - right);
  return indexes.reduce((state, index) => applyRunEvent(state, run.events.get(index)!), emptyRunViewState());
}

function elapsedOf(run: MutableRun) {
  const end = run.finishedAtMs ?? (run.running ? Date.now() : run.startedAtMs);
  return Math.max(0, end - run.startedAtMs);
}

function toLiveRun(run: MutableRun): LiveRun {
  const state = viewStateOf(run);
  return {
    ...state,
    runId: run.runId,
    targetId: run.targetId,
    // 落库之后以服务端给的 id 为准：新对话的第一轮跑完才拿到它。
    conversationId: state.savedConversationId ?? run.requestedConversationId,
    question: run.question,
    attachments: run.attachments,
    thinkingOn: run.thinkingOn,
    running: run.running,
    detached: run.detached,
    startedAtMs: run.startedAtMs,
    finishedAtMs: run.finishedAtMs,
    elapsedMs: elapsedOf(run),
  };
}

function rebuild() {
  snapshot = [...runs.values()].map(toLiveRun).sort((left, right) => left.startedAtMs - right.startedAtMs);
}

function notify() {
  rebuild();
  for (const listener of listeners) listener();
  const anyRunning = [...runs.values()].some((run) => run.running);
  if (anyRunning && ticker === null) {
    // 跑着的时候每半秒敲一下：界面上的耗时才会走字（用的是前端时钟）。
    ticker = setInterval(() => {
      rebuild();
      for (const listener of listeners) listener();
      if (![...runs.values()].some((run) => run.running) && ticker !== null) {
        clearInterval(ticker);
        ticker = null;
      }
    }, 500);
  } else if (!anyRunning && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LiveRun[] {
  if (!snapshot.length && runs.size) rebuild();
  return snapshot;
}

/** 订阅"本机正在跑的那些轮"。SSR 与首帧拿到的是同一份（可能是空的）列表。 */
export function useLiveRuns(targetId: string): LiveRun[] {
  const all = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return all.filter((run) => run.targetId === targetId);
}

function setEvent(run: MutableRun, index: number, event: ReasoningRunEvent) {
  run.events.set(index, event);
  if (index + 1 > run.cursor) run.cursor = index + 1;
  // 被让到后台的那一轮不去改"现在在看哪段"：用户已经站在一段新对话上了，不该被拽回去。
  if (event.type === "saved" && event.conversationId && !run.detached) lastSeen.set(run.targetId, event.conversationId);
  if (event.type === "done" || event.type === "error") {
    run.reachedEnd = true;
    run.running = false;
    run.finishedAtMs = Date.now();
  }
}

/**
 * 接上一条运行的流。
 *
 * `after = cursor - 1`（**含端点**）：最后一条可能刚被并进更多文字，补看时把它重发一次，
 * 界面按下标替换 —— 不然切回来会少半句话。
 *
 * 跑完但手上还没内容的（刷新页面之后接回来的那种）也要接一次：补看一遍事件，
 * 那半截思考 / 结论才回得来。已经跑完且已经有内容的不再连。
 */
async function attach(run: MutableRun) {
  if (run.stream) return;
  if (!run.running && run.cursor > 0) return;
  const controller = new AbortController();
  run.stream = controller;
  try {
    const response = await fetch(`/api/reasoning/runs/${run.runId}/events?after=${Math.max(0, run.cursor - 1)}`, {
      headers: { ...authHeaders() },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`接上这次推理失败（HTTP ${response.status}）。`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      run.retries = 0;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((item) => item.startsWith("data:"));
        if (!line) continue;
        try {
          const frame = JSON.parse(line.slice(5).trim()) as { i: number; e: ReasoningRunEvent };
          setEvent(run, frame.i, frame.e);
        } catch {
          // 半截帧不该打断整条流：丢掉这一帧，下一帧照收。
        }
      }
      notify();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    // 服务端还在跑、只是这一条连接断了（换网 / 代理掐流）：退避后重连，别把任务当成失败。
    if (run.running && run.retries < 5) {
      run.retries += 1;
      run.stream = null;
      setTimeout(() => { void attach(run); }, 500 * run.retries);
      return;
    }
    if (run.running) {
      run.events.set(run.cursor, { type: "error", message: error instanceof Error ? error.message : "这次推理的连接断了。" });
      run.cursor += 1;
      run.running = false;
      run.finishedAtMs = Date.now();
    }
  } finally {
    if (run.stream === controller) run.stream = null;
    if (run.running && run.reachedEnd) run.running = false;
    notify();
  }
}

/**
 * 起一轮推理：**先在界面上支起来，再等服务端把运行起好**。
 *
 * 起失败（没发布版本、权限不足…）也要留一条记录 —— 用户点了发送，就该看到那句错误，
 * 而不是屏幕上什么也没发生。
 */
export async function startLiveRun(input: StartLiveRunInput): Promise<string> {
  const localId = `pending-${Date.now()}-${localSequence++}`;
  const record: MutableRun = {
    runId: localId,
    targetId: input.targetId,
    requestedConversationId: input.conversationId,
    question: input.question,
    attachments: input.attachments,
    thinkingOn: input.thinking,
    events: new Map(),
    cursor: 0,
    running: true,
    reachedEnd: false,
    // 前端时钟：这一轮的起点。展示的耗时一律从这里算。
    startedAtMs: Date.now(),
    finishedAtMs: null,
    stream: null,
    retries: 0,
    detached: false,
  };
  runs.set(localId, record);
  notify();

  try {
    const { run } = await api<{ run: { runId: string } }>("/api/reasoning/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: input.targetId,
        question: input.question,
        thinking: input.thinking,
        ...input.settings,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
      }),
    });
    // 换成服务端给的 id：后面接流、停止、落库都认它。
    runs.delete(localId);
    record.runId = run.runId;
    runs.set(run.runId, record);
    notify();
    void attach(record);
    return run.runId;
  } catch (error) {
    runs.delete(localId);
    record.runId = `${localId}-failed`;
    record.running = false;
    record.finishedAtMs = Date.now();
    record.events.set(0, { type: "error", message: error instanceof Error ? error.message : "无法开始这次推理。" });
    record.cursor = 1;
    runs.set(record.runId, record);
    notify();
    return record.runId;
  }
}

/**
 * 把服务端还在跑的那些接回来。
 *
 * 组件挂上（切回智能问答）、刷新页面、换本体之后都要调一次：本机记录里没有的补进来，
 * 本机记录里"显示在跑但其实已经在服务端收尾"的也靠它纠正。
 */
export async function syncLiveRuns(targetId: string): Promise<void> {
  if (!targetId) return;
  let summaries: { runId: string; startedAt: string; status: string; conversationId: string | null; question: string }[];
  try {
    ({ runs: summaries } = await api<{ runs: typeof summaries }>(`/api/reasoning/runs?targetId=${encodeURIComponent(targetId)}`));
  } catch {
    // 读不到就当没有：这是个辅助动作，不该在界面上弹错。
    return;
  }
  for (const summary of summaries) {
    const existing = runs.get(summary.runId);
    if (existing) {
      if (summary.status !== "running") {
        existing.running = false;
        existing.finishedAtMs ??= Date.now();
      } else {
        void attach(existing);
      }
      continue;
    }
    const record: MutableRun = {
      runId: summary.runId,
      targetId,
      requestedConversationId: summary.conversationId,
      question: summary.question,
      attachments: [],
      thinkingOn: true,
      events: new Map(),
      cursor: 0,
      running: summary.status === "running",
      reachedEnd: false,
      // 接回来的运行用服务端给的开跑时刻（ISO）折成本机时间轴，耗时才连贯。
      startedAtMs: Number.isFinite(Date.parse(summary.startedAt)) ? Date.parse(summary.startedAt) : Date.now(),
      finishedAtMs: summary.status === "running" ? null : Date.now(),
      stream: null,
      retries: 0,
      // 接回来的是"服务端还在跑的那些"：它们本来就该待在后台那一栏（侧栏），不是当前这一段的。
      detached: summary.conversationId === null,
    };
    runs.set(summary.runId, record);
    if (record.running) void attach(record);
  }
  notify();
}

/** 用户点「停止」：告诉服务端别往下跑了，本机这一轮立刻收尾（已经跑出来的东西留在上面）。 */
export async function cancelLiveRun(runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;
  run.stream = null;
  run.running = false;
  run.reachedEnd = true;
  run.finishedAtMs = Date.now();
  notify();
  try {
    await api(`/api/reasoning/runs/${runId}/cancel`, { method: "POST" });
  } catch {
    // 服务端那边可能已经结束了：界面已经按"停了"收尾，不必再打扰用户。
  }
}

/** 打开某段历史对话前把它**已经跑完**的那几轮摘掉：那些内容已经在历史里了，留着会重一遍。 */
export function dropFinishedLiveRuns(conversationId: string): void {
  let changed = false;
  for (const [id, run] of runs) {
    if (run.running) continue;
    if (toLiveRun(run).conversationId !== conversationId) continue;
    runs.delete(id);
    changed = true;
  }
  if (changed) notify();
}

/** 本机最近在看的那段对话；null = 这次打开页面以来还没看过任何一段。 */
export function lastSeenConversation(targetId: string): string | null {
  return lastSeen.get(targetId) ?? null;
}

/** 记一下"现在在看这段"。翻历史、跑完落库都算。 */
export function rememberConversation(targetId: string, conversationId: string): void {
  lastSeen.set(targetId, conversationId);
}

/** 用户明确要"新对话"：别再把画面接回上一轮。 */
export function forgetLastSeenConversation(targetId: string): void {
  lastSeen.delete(targetId);
}

/**
 * 用户按了「新对话」：把**还在跑**的那几轮让到后台。
 *
 * 这就是用户口径里的"新建聊天了，放后台运行" —— 中间那一栏让给它一段干净的对话，
 * 原来那一轮继续在服务端跑，侧栏上写着"运行中"，跑完就出现在历史里。
 */
export function detachRunningRuns(targetId: string): void {
  let changed = false;
  for (const run of runs.values()) {
    if (run.targetId !== targetId || !run.running || run.detached) continue;
    run.detached = true;
    changed = true;
  }
  if (changed) notify();
}
