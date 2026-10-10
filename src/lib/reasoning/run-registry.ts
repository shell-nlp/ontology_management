import { randomUUID } from "node:crypto";
import { z } from "zod";
import { listDataSources } from "@/lib/datasource/sources";
import { getGraphStore } from "@/lib/framework/graph";
import { getOntologyByTargetId } from "@/lib/ontology/ontologies";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getPublishedOntology } from "@/lib/versioning/published-ontology";
import { runReasoning, worthKeepingTurn } from "@/lib/reasoning/agent";
import { attachmentsSchema } from "@/lib/reasoning/attachment-schema";
import { effectiveQuestion } from "@/lib/reasoning/attachments";
import { saveTurn } from "@/lib/reasoning/conversations";
import { prepareHistory } from "@/lib/reasoning/history-context";
import { loadToolPolicy } from "@/lib/reasoning/tool-policy";
import type { ReasoningRunEvent } from "@/lib/reasoning/run-events";
import { getTarget } from "@/lib/platform/targets";

/**
 * 一轮推理的**服务端运行登记处**：跑起来之后不再挂在某一条 HTTP 请求上。
 *
 * 用户口径（2026-10-10）：「切换页面了，或者新建聊天了，放后台运行，而且从对话历史还能看到是否正在运行」。
 * 要做到这一点，运行必须由服务端持有 —— 挂在请求上就只能"浏览器开着、页面还停在这一档"才算数：
 *
 * - `startReasoningRun` 把校验、取定义、跑模型这些事**先做完校验**（错就回 HTTP 错误），
 *   然后把真正的推理丢进后台跑，立刻把 runId 还给调用方；
 * - 事件按顺序留在 `record.events` 里（SSE 增量的 thinking / answer **合并成一条**，
 *   否则一段长回答会攒出几万个事件），界面靠 `after` 游标补看没看过的部分；
 * - 界面只是"接上这条流"：切走再回来、刷新页面，都能从游标处接回去继续看。
 *
 * 三个边界，改之前先读：
 * 1. **只有内存**：进程重启（开发时改代码、容器重建）运行就没了。落库的只有**跑完**的那一轮
 *    （`saveTurn`），这也和以前一样 —— 半截的运行不进历史。
 * 2. **停止只认显式请求**：以前"浏览器断开 = 用户叫停"，现在断开只是"不看了"。
 *    真停要调 `cancelReasoningRun`（界面上的「停止」按钮）。
 * 3. **所有权**：每条运行记着 userId，读事件与取消都要比对，别让别人的运行被别人看。
 */

/** 跑完的记录留 10 分钟：够"刚跑完再回来看一眼"，也不至于把内存攒满。 */
const RUN_KEEP_MS = 10 * 60_000;
/** 一条运行最多留多少事件（合并过之后正常远不到这个数），兜底防内存失控。 */
const MAX_EVENTS = 20_000;

export const reasoningRunInput = z.object({
  targetId: z.string().uuid(),
  // 问题可以为空：只带图片提问时由 effectiveQuestion 补一句默认的（见 attachments.ts）。
  question: z.string().trim().max(500),
  /** 和问题一起发过去的图片；张数 / 体积 / 类型上限见 attachments.ts。 */
  attachments: attachmentsSchema,
  // 上限与服务端 agent.ts 的 MAX_STEPS_CEILING 对齐：那是防跑穿的兜底，不是给用户设的门槛。
  maxSteps: z.number().int().min(1).max(100).optional(),
  thinking: z.boolean().optional(),
  /** 有就追加到这段对话后面，没有就新开一段。 */
  conversationId: z.string().uuid().optional(),
  /** 「问答配置」里的两个数。不传就是"不限制"，服务端只保留防跑穿的兜底。 */
  toolResultLimit: z.number().int().min(500).max(200_000).optional(),
  sqlRowLimit: z.number().int().min(1).max(5000).optional(),
  /** 「问答配置」里改过的系统提示词。不传（或空白）就用默认那段。 */
  systemPrompt: z.string().trim().max(20_000).optional(),
  /** 「问答配置」里的「历史轮数」：原样回放最近几轮。不传 = 默认 5；0 = 完全不带历史。 */
  historyTurns: z.number().int().min(0).max(20).optional(),
});

export type ReasoningRunInput = z.infer<typeof reasoningRunInput>;

export type ReasoningRunStatus = "running" | "done" | "stopped" | "error";

/** 给界面看的运行摘要：不含事件体（那一份走 events 接口）。 */
export type ReasoningRunSummary = {
  runId: string;
  status: ReasoningRunStatus;
  /** ISO；**界面展示的耗时用本地时钟算**，这两个时间戳只作为"从什么时候开始"的事实。 */
  startedAt: string;
  finishedAt: string | null;
  question: string;
  targetId: string;
  conversationId: string | null;
  cursor: number;
  error: string | null;
  stopped: boolean;
  /** 已经落进对话历史（这一轮可以被历史列表读到）。 */
  saved: boolean;
};

type StoredRun = ReasoningRunSummary & {
  userId: string;
  ontologyId: string | null;
  events: ReasoningRunEvent[];
  /** 追加了事件或状态变了就敲一下：订阅者据此把新事件推出去。 */
  listeners: Set<(payload: { index: number; event: ReasoningRunEvent }) => void>;
  controller: AbortController;
  startedAtMs: number;
  finishedAtMs: number | null;
};

/**
 * 运行表**必须挂在 globalThis 上**，不能是本模块自己的变量。
 *
 * Next 的 dev（Turbopack）按路由分别打包，同一个模块可能被实例化多份 ——
 * 用模块级 `new Map()` 时，`POST /api/reasoning/runs` 起的那条运行，在
 * `GET /api/reasoning/runs/[runId]/events` 里查不到，会回 404：界面就显示"接上失败"，
 * 而运行本身其实还在跑、最后照样落进历史（2026-10-10 实测就是这样，两边各说各话）。
 * 挂到 globalThis 上，进程里所有路由看到的是同一份。
 */
const REGISTRY_KEY = "__ontologyReasoningRuns";

function registry(): Map<string, StoredRun> {
  const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Map<string, StoredRun> };
  if (!holder[REGISTRY_KEY]) holder[REGISTRY_KEY] = new Map<string, StoredRun>();
  return holder[REGISTRY_KEY];
}

/** 已经跑完（不论成没成）且超过保留期的记录清掉。 */
function prune() {
  const now = Date.now();
  for (const [id, record] of registry()) {
    if (record.status !== "running" && record.finishedAtMs && now - record.finishedAtMs > RUN_KEEP_MS) registry().delete(id);
  }
}

function summaryOf(record: StoredRun): ReasoningRunSummary {
  return {
    runId: record.runId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    question: record.question,
    targetId: record.targetId,
    conversationId: record.conversationId,
    cursor: record.events.length,
    error: record.error,
    stopped: record.stopped,
    saved: record.saved,
  };
}

/**
 * 把事件写进记录。
 *
 * 连续的 thinking / answer 增量**合并进上一条**：一段 5,000 字的回答会分成几百个增量，
 * 逐个留着既费内存又让"补看"变慢，而界面本来就是把它们拼起来。合并后**下标不变**，
 * 于是订阅者收到的是"下标 i 的内容更新了"，重放的界面按同一个 reducer 折出来仍然一致。
 */
function pushEvent(record: StoredRun, event: ReasoningRunEvent) {
  const last = record.events[record.events.length - 1];
  /*
   * `done` 会出现两次：编排层跑完自己会发一条（agent.ts），收尾时这里还要发一条。
   * 内容一样又是**最大的一条**（整轮 run 全在里面），所以按"同类型就地替换"存 ——
   * 下标不变，界面照样收得到，事件表里只有一条。
   */
  if (event.type === "done") {
    const index = record.events.findIndex((item) => item.type === "done");
    if (index >= 0) {
      record.events[index] = event;
      for (const listener of record.listeners) listener({ index, event });
      return index;
    }
  }
  if (
    last &&
    (event.type === "thinking" || event.type === "answer") &&
    last.type === event.type &&
    record.events.length <= MAX_EVENTS
  ) {
    last.text += event.text;
    const index = record.events.length - 1;
    for (const listener of record.listeners) listener({ index, event: last });
    return index;
  }
  if (record.events.length >= MAX_EVENTS) return record.events.length - 1;
  record.events.push(event);
  const index = record.events.length - 1;
  for (const listener of record.listeners) listener({ index, event });
  return index;
}

function finish(record: StoredRun, status: ReasoningRunStatus) {
  record.status = status;
  record.finishedAtMs = Date.now();
  record.finishedAt = new Date(record.finishedAtMs).toISOString();
  record.listeners.clear();
}

export type StartRunOptions = {
  userId: string;
  actorId: string;
  input: ReasoningRunInput;
};

/**
 * 起一轮推理并立刻返回（校验不过直接抛，调用方回 HTTP 错误）。
 *
 * 校验、取本体定义、取数据资源、决定历史归属都在**开跑之前**做完 ——
 * 一旦回了 202，就没有地方再报"这个本体没发布"了。
 */
export async function startReasoningRun({ userId, actorId, input }: StartRunOptions): Promise<ReasoningRunSummary> {
  prune();
  const question = effectiveQuestion(input.question, input.attachments ?? []);
  if (!question) throw new Error("问题不能为空。");

  const target = await getTarget(input.targetId);
  if (!target) throw new Error("本体存储不存在。");

  let definition;
  try {
    definition = await getPublishedOntology(target.id);
  } catch {
    throw new Error("该本体还没有发布版本，先在「本体草稿」里发布后再提问。");
  }

  const store = getGraphStore(target);
  const runtimeTypes = await store.readRuntimeTypes().catch(() => null);
  // 对象类型绑了哪些表，模型自己看不到（绑定里只有资源 id），这里一并交给工具集翻译成可读文本。
  const dataSources = await listDataSources().catch(() => []);
  const ontology = await getOntologyByTargetId(target.id);
  const scope = { ontologyId: ontology?.id ?? null, targetId: target.id };

  const startedAtMs = Date.now();
  const record: StoredRun = {
    runId: randomUUID(),
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: null,
    question,
    targetId: target.id,
    conversationId: input.conversationId ?? null,
    cursor: 0,
    error: null,
    stopped: false,
    saved: false,
    userId,
    ontologyId: scope.ontologyId,
    events: [],
    listeners: new Set(),
    controller: new AbortController(),
    startedAtMs,
    finishedAtMs: null,
  };
  registry().set(record.runId, record);

  void executeRun({ record, actorId, input, question, target: target.id, scope, context: { store, definition, runtimeTypes, dataSources, toolResultLimit: input.toolResultLimit, sqlRowLimit: input.sqlRowLimit } });
  return summaryOf(record);
}

async function executeRun(options: {
  record: StoredRun;
  actorId: string;
  input: ReasoningRunInput;
  question: string;
  target: string;
  scope: { ontologyId: string | null; targetId: string };
  context: Parameters<typeof runReasoning>[0]["context"];
}) {
  const { record, actorId, input, question, scope, context } = options;
  const send = (event: ReasoningRunEvent) => pushEvent(record, event);
  try {
    /*
     * 多轮上下文：同一段对话里的前面几轮要回放给模型 —— 最近几轮连求证轨迹一起原样带，
     * 更早的轮次压成一段摘要（摘要存在对话记录里，下一轮直接复用）。
     */
    send({ type: "context", phase: "start" });
    const history = await prepareHistory({
      scope,
      userId: actorId,
      conversationId: input.conversationId ?? null,
      verbatimTurns: input.historyTurns,
      onCompress: (turns) => send({ type: "context", phase: "compressing", turns }),
    });
    send({
      type: "context",
      phase: "ready",
      history: {
        verbatimTurns: history.verbatimTurns,
        compressedTurns: history.compressedTurns,
        summaryChars: history.summary.length,
        chars: history.chars,
        ...(history.warning ? { warning: history.warning } : {}),
      },
    });
    // 工具开关跟着平台库走：MCP 那边关掉的工具，这里也同样不发给模型。
    // 按本体分（2026-10-08）：这个本体有自己的覆盖就按覆盖，没有就跟着全局默认。
    const policy = await loadToolPolicy(scope.ontologyId);
    const run = await runReasoning({
      question,
      attachments: input.attachments,
      history,
      context,
      maxSteps: input.maxSteps,
      disabledTools: policy.disabledTools,
      thinking: input.thinking,
      systemPrompt: input.systemPrompt,
      // 只有界面上的「停止」（cancel 接口）会掐这一条；断线不再等于叫停。
      abortSignal: record.controller.signal,
      onEvent: send,
    });
    await writeAuditEntry({
      actorId,
      targetId: options.target,
      action: "REASONING_RUN",
      details: { question, attachments: input.attachments?.length ?? 0, historyTurns: history.verbatimTurns, historyCompressed: history.compressedTurns, historyContextChars: history.chars, steps: run.steps.length, stepCount: run.stepCount, maxSteps: run.maxSteps, toolResultLimit: input.toolResultLimit ?? null, sqlRowLimit: input.sqlRowLimit ?? null, customSystemPrompt: Boolean(input.systemPrompt), model: run.model, truncated: run.truncated, stopped: run.stopped ?? false, elapsedMs: run.elapsedMs, thinking: input.thinking !== false, runId: record.runId, background: true },
    });
    record.stopped = run.stopped ?? false;
    send({ type: "done", run });
    /**
     * 记进对话历史：跑挂了的一轮不留记录，历史里不会出现"点进去只有半句话"的条目。
     * 被用户叫停的一轮要不要记，判断在 `worthKeepingTurn` 里（有东西可看才记）。
     */
    if (worthKeepingTurn(run)) {
      try {
        const conversationId = await saveTurn({
          scope,
          userId: actorId,
          conversationId: input.conversationId ?? null,
          question,
          answer: run.answer,
          thinking: run.reasoning,
          thinkingOn: input.thinking !== false,
          run,
          error: null,
        });
        record.conversationId = conversationId;
        record.saved = true;
        send({ type: "saved", conversationId });
      } catch {
        // 落库失败不该吞掉已经跑出来的结论：界面照常显示，只是这条不进历史。
        send({ type: "saved", conversationId: null, warning: "结论已生成，但这次没能记进对话历史。" });
      }
    }
    finish(record, record.stopped ? "stopped" : "done");
  } catch (error) {
    // 用户叫停不算失败：`runReasoning` 被掐时是**正常返回**的（stopped: true），走不到这里。
    const message = error instanceof Error ? error.message : "推理失败。";
    record.error = message;
    send({ type: "error", message });
    finish(record, "error");
  }
}

export function getReasoningRun(runId: string): ReasoningRunSummary | null {
  prune();
  const record = registry().get(runId);
  return record ? summaryOf(record) : null;
}

/** 这条运行属于谁：读事件 / 取消之前必须比对（别人的运行不给看）。 */
export function reasoningRunOwner(runId: string): string | null {
  return registry().get(runId)?.userId ?? null;
}

/**
 * 当前这个人在这个本体上的运行：**还在跑的**，加上"刚跑完、但没能落进历史"的
 * （这种最需要留住 —— 刷新页面之后唯一的线索就是它）。
 *
 * 已经落库的不列：历史列表按对话读得到，再列一遍界面会重复。
 */
export function listReasoningRuns(userId: string, scope: { ontologyId: string | null; targetId: string }): ReasoningRunSummary[] {
  prune();
  const now = Date.now();
  return [...registry().values()]
    .filter((record) => record.userId === userId)
    .filter((record) => (scope.ontologyId ? record.ontologyId === scope.ontologyId : record.ontologyId === null && record.targetId === scope.targetId))
    .filter((record) => record.status === "running" || (!record.saved && record.finishedAtMs !== null && now - record.finishedAtMs <= 120_000))
    .sort((left, right) => right.startedAtMs - left.startedAtMs)
    .map(summaryOf);
}

/** 从 `after`（不含）开始的事件，带各自的下标 —— 下标是重放的游标。 */
export function readReasoningRunEvents(runId: string, after = 0): { index: number; event: ReasoningRunEvent }[] {
  const record = registry().get(runId);
  if (!record) return [];
  return record.events.slice(Math.max(0, after)).map((event, offset) => ({ index: Math.max(0, after) + offset, event }));
}

/**
 * 接上一条正在跑的运行。回调收到的是"下标 i 的事件（可能是被合并更新过的同一条）"。
 * 运行已经结束时返回一个空退订函数，调用方不用自己判断。
 */
export function subscribeReasoningRun(runId: string, listener: (payload: { index: number; event: ReasoningRunEvent }) => void): () => void {
  const record = registry().get(runId);
  if (!record || record.status !== "running") return () => {};
  record.listeners.add(listener);
  return () => record.listeners.delete(listener);
}

/**
 * 用户点「停止」：掐断模型这一轮。
 *
 * 停的是"继续往下查"，不是把查到的抹掉 —— 已经流出来的思考、步骤与半截结论照常收尾
 * （`runReasoning` 被掐时正常返回，`stopped: true`），`worthKeepingTurn` 决定要不要进历史。
 */
export function cancelReasoningRun(runId: string): boolean {
  const record = registry().get(runId);
  if (!record || record.status !== "running") return false;
  record.stopped = true;
  record.controller.abort();
  return true;
}
