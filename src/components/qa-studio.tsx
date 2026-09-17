"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Boxes, Brain, ChevronDown, CircleDot, History, ImagePlus, Link2, Loader2, Plus, Send, Settings2, Sparkles, Square, Trash2, X } from "lucide-react";
import { MarkdownView } from "@/components/markdown-view";
import { api } from "@/lib/api-client";
import { conversationTimeLabel, groupConversationsByDay, type ConversationDetail, type ConversationMessage, type ConversationSummary } from "@/lib/reasoning/conversation-view";
import { DEFAULT_SYSTEM_PROMPT, isCustomSystemPrompt } from "@/lib/reasoning/prompt";
import {
  clearReasoningSettings,
  loadReasoningSettings,
  reasoningSettingsPayload,
  REASONING_SETTING_FIELDS,
  REASONING_SETTING_RANGES,
  saveReasoningSettings,
  SYSTEM_PROMPT_LIMIT,
  systemPromptFieldValue,
  type ReasoningSettings,
} from "@/lib/reasoning/settings";
import { IMAGE_ONLY_QUESTION, mediaTypeOf } from "@/lib/reasoning/attachments";
import { historyLabel } from "@/lib/reasoning/history";
import type { ReasoningAttachment, ReasoningContext, ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";
import "./qa-studio.css";

/**
 * 智能问答：用已发布的本体回答业务问题。
 *
 * 设计取的是"实验记录"而不是"聊天"：Agent 的回复不是气泡，而是一份通栏的求证报告 ——
 * 最上面一条「求证轨迹」说明它查了哪几步，下面是结论，再下面是能点回对象页的证据。
 * 页面唯一的签名元素就是这条轨迹，其它地方都刻意安静。
 *
 * 全程走 SSE：思考、每一步、正文都是边跑边长出来的，所以轨迹在推理过程中就是活的。
 */

const TOOL_LABELS: Record<string, string> = {
  search_schema: "检索本体",
  get_object_type: "读取对象类型",
  query_object_instance: "查询对象",
  query_instance_subgraph: "查询子图",
  list_actions: "列出动作",
};

const EXAMPLES = [
  "这个本体里有哪些对象类型？它们各自有哪些属性？",
  "本体里有哪些接口？分别是谁实现的？",
  "把所有对象类型和它们之间的关系类型列出来",
  "本体里定义了哪些可以直接改数据的动作？",
];

type Turn = {
  id: string;
  question: string;
  /** 这一轮一起问的图片：当场问的是刚贴的，回看历史读的是当时存在运行记录里的那份。 */
  attachments: ReasoningAttachment[];
  /** 这一轮回放了哪些历史上下文（多轮）；老记录没有这一项。 */
  context?: ReasoningContext;
  /** 正在整理上下文（读历史 / 压摘要）——这两步也要几秒，界面得说出来。 */
  preparing?: boolean;
  thinking: string;
  answer: string;
  steps: ReasoningStep[];
  run: ReasoningRun | null;
  error: string | null;
  /** 用户中途点了「停止」：这一轮是**被叫停的**，不是失败的，界面上要标出来。 */
  stopped?: boolean;
  busy: boolean;
  /** 这一轮有没有开思考。关掉时不显示「思考过程」，否则会挂一个永远空着的块。 */
  thinkingOn: boolean;
};

/** 历史里的记录 → 界面上的这一轮。步骤直接从那次运行的 run 里取，和当时看到的一样。 */
function messageToTurn(message: ConversationMessage): Turn {
  return {
    id: message.id,
    question: message.question,
    attachments: message.run?.attachments ?? [],
    context: message.run?.context,
    thinking: message.thinking,
    answer: message.answer,
    steps: message.run?.steps ?? [],
    run: message.run,
    error: message.error,
    // 那次是被停的，回看时也要照样标「已停止」（老记录没有这个字段）。
    stopped: message.run?.stopped ?? false,
    busy: false,
    thinkingOn: message.thinkingOn,
  };
}

type Props = {
  targetId: string;
  ontologyName: string;
  published: boolean;
  onOpenObject: (objectId: string) => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};


/** 入参里单个值的写法：字符串带引号（区分「郑州」和郑州这段文本本身），数组展开成 []。 */
function formatArgument(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => formatArgument(item)).join(", ")}]`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 一行放得下的入参摘要，形如 `type_name="专线产品用户"  limit=20`。
 *
 * 同一轮里模型常连着调好几次同一个工具（比如连着好几次 search_schema），
 * 只看工具名根本分不出哪一步查了什么 —— 所以入参要在行上就能看见，点开再看完整 JSON。
 */
function argumentSummary(args: Record<string, unknown> | undefined): string {
  const entries = Object.entries(args ?? {});
  if (!entries.length) return "无入参";
  return entries.map(([key, value]) => `${key}=${formatArgument(value)}`).join("  ");
}

/**
 * 求证轨迹：这一页的签名元素。
 * 横向一串节点，每个是「第几步 · 调了什么 · 传了什么参数 · 拿到了什么 · 耗时」，
 * 点开看这一步的完整入参与原始返回。推理进行中也是活的：步骤一完成就出现在这里。
 *
 * 行上的「拿到了什么」用 `step.summary`（服务端按工具如实生成），**不用证据条数**：
 * get_table_ddl / run_sql 按设计不产出证据，用证据数会显示成"无命中"，
 * 明明返回了 6 行却像什么都没查到（2026-09-14 用户报的）。
 */
function ProofTrail({ steps, live, totalMs }: { steps: ReasoningStep[]; live: boolean; totalMs: number }) {
  // 默认收起；推理中自动展开，让过程可见（用户手动收起来后就尊重用户的选择）。
  const [manual, setManual] = useState<boolean | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const open = manual ?? live;
  const summary = useMemo(() => {
    if (!steps.length) return live ? "正在检索本体…" : "没有调用工具";
    const hits = steps.reduce((sum, step) => sum + step.evidence.length, 0);
    // 证据数为 0 时不写"证据 0 项"：这一轮本来就可能是纯查数据（不产生证据）。
    return [`已调用工具 ${steps.length} 次`, hits ? `证据 ${hits} 项` : "", `${((totalMs || 0) / 1000).toFixed(1)}s`].filter(Boolean).join(" · ");
  }, [steps, live, totalMs]);

  return (
    <div className={`qa-trail${open ? " open" : ""}`}>
      <button type="button" className="qa-trail-summary" onClick={() => setManual(!open)} aria-expanded={open}>
        <span className="qa-trail-badge">求证轨迹</span>
        <span className="qa-trail-text">{summary}</span>
        {live && <Loader2 size={13} className="qa-spin" />}
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open && (
        <ol className="qa-trail-steps">
          {steps.map((step) => (
            <li key={step.index} className={`qa-trail-step${step.ok ? "" : " failed"}`}>
              <button type="button" onClick={() => setOpenStep(openStep === step.index ? null : step.index)} aria-expanded={openStep === step.index}>
                <span className="qa-trail-node">{step.index}</span>
                <b>{TOOL_LABELS[step.tool] ?? step.tool}</b>
                <code>{step.tool}</code>
                <span className="qa-trail-args">{argumentSummary(step.arguments)}</span>
                <span className="qa-trail-facts">
                  {step.ok ? step.summary ?? "已返回" : "出错"}
                  <i>{step.elapsedMs}ms</i>
                </span>
              </button>
              {openStep === step.index && (
                <div className="qa-step-detail">
                  <div className="qa-step-part">
                    <span className="qa-step-part-label">入参</span>
                    <pre className="qa-step-args">{JSON.stringify(step.arguments ?? {}, null, 2)}</pre>
                  </div>
                  <div className="qa-step-part">
                    <span className="qa-step-part-label">返回</span>
                    <pre className="qa-step-result">{step.result}</pre>
                  </div>
                </div>
              )}
            </li>
          ))}
          {live && <li className="qa-trail-empty"><Loader2 size={12} className="qa-spin" /> 继续查证…</li>}
          {!steps.length && !live && <li className="qa-trail-empty">模型直接给出了结论，没有查询图库。</li>}
        </ol>
      )}
    </div>
  );
}

/**
 * 思考过程。默认跟随推理状态：跑的时候展开，跑完自动收起（用户手动开过就一直展开）。
 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;
  if (!text.trim() && !live) return null;
  return (
    <div className={`qa-thinking${open ? " open" : ""}`}>
      <button type="button" className="qa-thinking-head" onClick={() => setManual(!open)} aria-expanded={open}>
        <Brain size={13} />
        <span>思考过程</span>
        {live ? <em><Loader2 size={11} className="qa-spin" />进行中</em> : <em>{text.length} 字</em>}
        <ChevronDown size={14} className={open ? "is-open" : ""} />
      </button>
      {open && <pre className="qa-thinking-body">{text || "…"}</pre>}
    </div>
  );
}

/** 一轮最多带几张图、缩到多大：和 lib/reasoning/attachments.ts 的上限配套。 */
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_EDGE = 1600;
/** 单张 data URL 的字符上限，比服务端那道（3.2M）留一点余量。 */
const MAX_IMAGE_CHARS = 2_800_000;

/** 读成可画的图：优先 createImageBitmap（快、不占 DOM），老浏览器退回 <img> + object URL。 */
async function loadDrawable(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`「${file.name}」读不出来，换一张图试试。`));
      element.src = url;
    });
    return { source: image as CanvasImageSource, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (reason) {
    URL.revokeObjectURL(url);
    throw reason;
  }
}

/**
 * 图片进 state 之前先在浏览器里过一遍画布：长边超过 MAX_IMAGE_EDGE 就等比缩小，
 * 编码后仍然过大就换 JPEG 再压两次。
 *
 * 非缩不可的原因：模型看 1600px 已经够清楚，而原图直接 base64 进请求体与对话历史是几 MB 起，
 * 一次粘贴三张截图就能把一轮问答拖成几十秒。
 * 截图类图片保持原格式（PNG 的文字比 JPEG 清楚），照片才用 JPEG。
 */
async function prepareImage(file: File): Promise<ReasoningAttachment> {
  if (!file.type.startsWith("image/")) throw new Error(`「${file.name}」不是图片。`);
  const drawable = await loadDrawable(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(drawable.width, drawable.height, 1));
    const width = Math.max(1, Math.round(drawable.width * scale));
    const height = Math.max(1, Math.round(drawable.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("这个浏览器画不了图（拿不到 canvas 上下文），换一个浏览器再试。");
    context.drawImage(drawable.source, 0, 0, width, height);
    const keep = ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? file.type : "image/png";
    let dataUrl = canvas.toDataURL(keep, keep === "image/png" ? undefined : 0.86);
    if (dataUrl.length > MAX_IMAGE_CHARS) dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (dataUrl.length > MAX_IMAGE_CHARS) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    if (dataUrl.length > MAX_IMAGE_CHARS) throw new Error(`「${file.name}」压缩完还是太大，换一张小一点的图。`);
    return {
      name: file.name || "粘贴的图片",
      // 压缩时可能换了格式，所以媒体类型看编码结果，不看原文件类型。
      mediaType: mediaTypeOf(dataUrl, keep),
      dataUrl,
      width,
      height,
      bytes: Math.round(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4),
    };
  } finally {
    drawable.release();
  }
}

/** 字节数给人看的样子。 */
function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 消费 SSE：把后端的事件翻译成界面状态。 */
async function streamRun(
  targetId: string,
  question: string,
  /** 和问题一起发过去的图片；空数组就是纯文字提问。 */
  attachments: ReasoningAttachment[],
  thinking: boolean,
  conversationId: string | null,
  /** 请求体里那几项：三个数字旋钮 + 可选的系统提示词。 */
  settings: Record<string, number | string>,
  /** 这一轮的取消开关：用户点「停止」时用它掐断请求，服务端收到断开就把整轮运行停掉。 */
  signal: AbortSignal,
  handlers: {
    onThinking: (text: string) => void;
    onAnswer: (text: string) => void;
    onAnswerReset: () => void;
    onStep: (step: ReasoningStep) => void;
    onContext: (phase: "start" | "compressing" | "ready", history: ReasoningContext | undefined) => void;
    onDone: (run: ReasoningRun) => void;
    onSaved: (conversationId: string | null, warning: string | undefined) => void;
  },
) {
  const response = await fetch("/api/reasoning/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ targetId, question, thinking, ...settings, ...(conversationId ? { conversationId } : {}), ...(attachments.length ? { attachments } : {}) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（HTTP ${response.status}）。`);
  }
  if (!response.body) throw new Error("服务端没有返回流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data:"));
      if (!line) continue;
      let event: { type: string; [key: string]: unknown };
      try {
        event = JSON.parse(line.slice(5).trim()) as typeof event;
      } catch {
        continue;
      }
      if (event.type === "thinking") handlers.onThinking(String(event.text ?? ""));
      else if (event.type === "answer") handlers.onAnswer(String(event.text ?? ""));
      else if (event.type === "answerReset") handlers.onAnswerReset();
      else if (event.type === "step") handlers.onStep(event.step as ReasoningStep);
      else if (event.type === "context") handlers.onContext(String(event.phase) as "start" | "compressing" | "ready", event.history as ReasoningContext | undefined);
      else if (event.type === "done") handlers.onDone(event.run as ReasoningRun);
      else if (event.type === "saved") handlers.onSaved((event.conversationId as string | null) ?? null, typeof event.warning === "string" ? event.warning : undefined);
      else if (event.type === "error") throw new Error(String(event.message ?? "推理失败。"));
    }
  }
}

/** 历史侧栏开没开记在本地：习惯开着的人，下次进来还是开着的。 */
const HISTORY_OPEN_KEY = "ontology.qa.history";

function loadHistoryOpen() {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(HISTORY_OPEN_KEY) === "1"; } catch { return false; }
}

/** 读一个本体的历史列表。列表接口只回摘要，点开某一条才会取完整内容。 */
function fetchConversations(targetId: string) {
  return api<{ conversations: ConversationSummary[] }>(`/api/reasoning/conversations?targetId=${encodeURIComponent(targetId)}`)
    .then((data) => data.conversations);
}

/**
 * 对话历史侧栏。
 *
 * 它和主区的关系是"记录"与"当前这一页"：点一条就把那次的完整过程（求证轨迹 / 结论 / 依据）
 * 铺回主区，和当时看到的一模一样。删除走就地二次确认 —— 历史是随手可删的东西，
 * 但也不该点一下就没了。
 */
function HistoryRail({ conversations, activeId, loadingId, confirmingId, busy, onOpen, onAskDelete, onCancelDelete, onConfirmDelete }: {
  conversations: ConversationSummary[];
  /** 当前画面正对着哪段对话；新开的一轮在服务端定下 id 之前是 null。 */
  activeId: string | null;
  loadingId: string | null;
  confirmingId: string | null;
  busy: boolean;
  onOpen: (id: string) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  const groups = useMemo(() => groupConversationsByDay(conversations), [conversations]);
  return (
    <aside className="qa-history" aria-label="对话历史">
      <header className="qa-history-head">
        <History size={14} />
        <span>对话历史</span>
        {conversations.length > 0 && <em>{conversations.length}</em>}
      </header>

      {!conversations.length ? (
        <p className="qa-history-empty">
          还没有历史对话。跑完一轮问答它就会留在这里 —— 只有跑出结论的才记，失败的不会占位置。
        </p>
      ) : (
        <div className="qa-history-body">
          {groups.map((group) => (
            <section className="qa-history-group" key={group.day}>
              <p className="qa-history-day">{group.day}</p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id} className={`qa-history-item${item.id === activeId ? " active" : ""}`}>
                    {confirmingId === item.id ? (
                      <div className="qa-history-confirm">
                        <span>删除这段对话？</span>
                        <div>
                          <button type="button" className="danger" onClick={() => onConfirmDelete(item.id)}>删除</button>
                          <button type="button" onClick={onCancelDelete}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button type="button" className="qa-history-open" onClick={() => onOpen(item.id)} disabled={busy} title={item.title}>
                          <b>{item.title || "未命名对话"}</b>
                          <span className="qa-history-meta">
                            {loadingId === item.id && <Loader2 size={11} className="qa-spin" />}
                            {item.turns} 轮 · {conversationTimeLabel(item.updatedAt)}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="qa-history-remove"
                          onClick={() => onAskDelete(item.id)}
                          title="删除这段对话"
                          aria-label={`删除对话：${item.title || "未命名对话"}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

export function QaStudio({ targetId, ontologyName, published, onOpenObject, notify, fail }: Props) {
  // 会话和它所属的本体绑在一起：换了本体就当新会话，直接派生，不用 effect 去清空。
  // conversationId 也放这里，因为"现在在跟哪段历史对话"同样是随本体走的。
  const [session, setSession] = useState<{ targetId: string; conversationId: string | null; turns: Turn[] }>(() => ({ targetId, conversationId: null, turns: [] }));
  const [question, setQuestion] = useState("");
  /** 这一轮要带上的图片。发送后清空 —— 图属于某一轮问答，不该黏在下一条问题上。 */
  const [attachments, setAttachments] = useState<ReasoningAttachment[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 点开看的原图；null 就是没开。 */
  const [preview, setPreview] = useState<ReasoningAttachment | null>(null);
  const [status, setStatus] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(loadHistoryOpen);
  // 「问答配置」里的那几个数：默认是空的 = 不限制，存在本机。
  const [settings, setSettings] = useState<ReasoningSettings>(loadReasoningSettings);
  const [configOpen, setConfigOpen] = useState(false);
  // 列表跟着本体走：换了本体就当还没读过，不去 effect 里清空（和 turns 一个套路）。
  const [history, setHistory] = useState<{ targetId: string; items: ConversationSummary[] }>(() => ({ targetId, items: [] }));
  const [loadingConversation, setLoadingConversation] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** 「图片」按钮点开的就是这个藏起来的 file input。 */
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 用户往上翻了就不自动跟随，免得读一半被拽回底部。
  const stickRef = useRef(true);
  /**
   * 当前正在跑的那一轮：id 用来就地改这一轮的状态，controller 用来「停止」。
   * 一次只可能有一轮在跑（busy 挡着），所以一个 ref 就够，不必用 Map。
   */
  const runRef = useRef<{ id: string; controller: AbortController } | null>(null);

  const turns = useMemo(() => (session.targetId === targetId ? session.turns : []), [session, targetId]);
  const conversationId = session.targetId === targetId ? session.conversationId : null;
  const conversations = useMemo(() => (history.targetId === targetId ? history.items : []), [history, targetId]);
  /** 三个参数里只要设了一个，页头那个开关就挂角标 —— 不然看不出这次问答是被限制过的。 */
  const hasLimits = Boolean(settings.maxSteps || settings.toolResultLimit || settings.sqlRowLimit)
    || settings.historyTurns !== undefined;
  /** 抽屉里的提示词文本框：没改过就显示默认那段原文（用户要"看得见默认提示词"）。 */
  const systemPromptText = systemPromptFieldValue(settings);
  const customPrompt = isCustomSystemPrompt(settings.systemPrompt);
  const updateTurns = useCallback((updater: (current: Turn[]) => Turn[]) => {
    setSession((current) => {
      const sameTarget = current.targetId === targetId;
      return { targetId, conversationId: sameTarget ? current.conversationId : null, turns: updater(sameTarget ? current.turns : []) };
    });
  }, [targetId]);
  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
  }, [updateTurns]);

  /** 用户动作触发的刷新（跑完一轮 / 删掉一条）：这时候读不到就该说出来。 */
  const refreshConversations = useCallback(async () => {
    try {
      setHistory({ targetId, items: await fetchConversations(targetId) });
    } catch (reason) {
      fail(reason);
    }
  }, [fail, targetId]);

  useEffect(() => {
    void fetch("/api/reasoning/status").then((res) => res.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

  // 参数随手改随手存：抽屉里没有"保存"按钮 —— 这几个数没有"改到一半"的中间态。
  useEffect(() => { saveReasoningSettings(settings); }, [settings]);

  // 配置抽屉开着时按 Esc 关掉，和平台里其它浮层一致。
  useEffect(() => {
    if (!configOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setConfigOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configOpen]);

  // 原图预览开着时按 Esc 关掉，和平台里其它浮层一致。
  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  /** 改一个参数。空输入 = 不限制（不往请求里带这一项）。 */
  const updateSetting = useCallback((key: keyof ReasoningSettings, raw: string) => {
    const trimmed = raw.trim();
    const numeric = trimmed === "" ? undefined : Math.floor(Number(trimmed));
    setSettings((current) => ({ ...current, [key]: numeric !== undefined && Number.isFinite(numeric) ? numeric : undefined }));
  }, []);

  const resetSettings = useCallback(() => {
    clearReasoningSettings();
    setSettings({});
  }, []);

  /**
   * 改系统提示词。**和默认一模一样（或清空）就存成"没改"**：本机不用存一大段和默认重复的文本，
   * 请求里也不会带上它，服务端自动回退到默认那段。
   */
  const updateSystemPrompt = useCallback((raw: string) => {
    setSettings((current) => ({ ...current, systemPrompt: isCustomSystemPrompt(raw) ? raw.slice(0, SYSTEM_PROMPT_LIMIT) : undefined }));
  }, []);

  /**
   * 页面加载、换本体、展开侧栏时读一次列表。
   * 失败是静默的：侧栏是辅助区域，读不到就先空着，不该在页头弹一个错误。
   */
  useEffect(() => {
    let cancelled = false;
    void fetchConversations(targetId)
      .then((items) => { if (!cancelled) setHistory({ targetId, items }); })
      .catch(() => { /* 静默：展开侧栏时还会再读一次 */ });
    return () => { cancelled = true; };
  }, [historyOpen, targetId]);

  // 跟随到底部（整页滚动 + 底部吸底输入条，所以跟的是窗口）。
  useEffect(() => {
    if (stickRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [turns]);

  useEffect(() => {
    const onScroll = () => {
      stickRef.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /**
   * 收图片：按钮选的、粘贴的、拖进来的都走这里。
   *
   * 一律先在浏览器里缩一遍（prepareImage）再进 state —— 发给模型的、存进对话历史的都是缩过的那张。
   * 超过张数上限的部分直接说明并丢掉，不静默截断。
   */
  const addFiles = useCallback(async (incoming: Iterable<File>) => {
    const files = [...incoming].filter((file) => file.type.startsWith("image/"));
    if (!files.length) { fail(new Error("只能带图片：截图直接粘贴，或者选一个图片文件。")); return; }
    if (attachments.length >= MAX_ATTACHMENTS) { notify(`一轮最多带 ${MAX_ATTACHMENTS} 张图片，先去掉一张再加。`); return; }
    setPreparing(true);
    try {
      const room = MAX_ATTACHMENTS - attachments.length;
      const prepared: ReasoningAttachment[] = [];
      for (const file of files.slice(0, room)) prepared.push(await prepareImage(file));
      setAttachments((current) => [...current, ...prepared].slice(0, MAX_ATTACHMENTS));
      if (files.length > room) notify(`一轮最多带 ${MAX_ATTACHMENTS} 张图片，后面 ${files.length - room} 张没有加上。`);
    } catch (reason) {
      fail(reason);
    } finally {
      setPreparing(false);
    }
  }, [attachments.length, fail, notify]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((current) => current.filter((_, position) => position !== index));
  }, []);

  const ask = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const images = attachments.slice(0, MAX_ATTACHMENTS);
    // 只贴了图没写字也算一次提问：补上 IMAGE_ONLY_QUESTION，界面与模型看到的是同一句。
    if ((!trimmed && !images.length) || busy) return;
    if (!targetId) { fail(new Error("请先在左侧选择一个本体。")); return; }
    const id = `${Date.now()}`;
    const asked = trimmed || IMAGE_ONLY_QUESTION;
    // 「停止」掐断的就是这一次请求：controller 跟着这一轮走，跑完 / 失败 / 被停都要把它摘掉。
    const controller = new AbortController();
    runRef.current = { id, controller };
    setQuestion("");
    setBusy(true);
    stickRef.current = true;
    updateTurns((current) => [...current, { id, question: asked, attachments: images, thinking: "", answer: "", steps: [], run: null, error: null, busy: true, thinkingOn: thinkingEnabled }]);
    try {
      await streamRun(targetId, asked, images, thinkingEnabled, conversationId, reasoningSettingsPayload(settings), controller.signal, {
        onThinking: (delta) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, thinking: turn.thinking + delta } : turn))),
        onAnswer: (delta) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, answer: turn.answer + delta } : turn))),
        // 这一段其实是"要调工具"前的过渡语，不是结论。别丢掉 —— 关掉思考时模型会把旁白写在这里，
        // 挪进思考过程既保留了过程，又不会让结论区闪出半句话。
        onAnswerReset: () => updateTurns((current) => current.map((turn) => (
          turn.id === id ? { ...turn, thinking: turn.thinking ? `${turn.thinking}\n${turn.answer}` : turn.answer, answer: "" } : turn
        ))),
        onStep: (step) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, steps: [...turn.steps, step] } : turn))),
        // 上下文这两步（读历史 + 压摘要）都发生在模型开始答之前，所以先挂"整理中"，拿到结果再落数。
        onContext: (phase, history) => patchTurn(id, phase === "ready" ? { preparing: false, context: history } : { preparing: true }),
        onDone: (run) => { patchTurn(id, { run, busy: false }); notify(`推理完成：${run.steps.length} 步，引用 ${run.evidence.length} 项证据。`); },
        // 历史 id 由服务端定：新对话的第一轮跑完才有 id，这里把"当前在跟哪段对话"接上去。
        onSaved: (savedId, warning) => {
          if (savedId) {
            setSession((current) => (current.targetId === targetId ? { ...current, conversationId: savedId } : current));
            void refreshConversations();
          }
          if (warning) notify(warning);
        },
      });
    } catch (reason) {
      // 用户叫停不是错误：这一轮回填成「已停止」，不弹报错，也不动已经流出来的内容。
      if (controller.signal.aborted) {
        patchTurn(id, { busy: false, stopped: true });
      } else {
        patchTurn(id, { error: reason instanceof Error ? reason.message : "推理失败。", busy: false });
        fail(reason);
      }
    } finally {
      // 已经被「停止」接手、或者下一轮已经开跑（ref 换了人）时别去动它。
      if (runRef.current?.controller === controller) runRef.current = null;
      patchTurn(id, { busy: false });
      setBusy(false);
      // 图片属于刚问完的那一轮，不该黏在下一条问题上。
      setAttachments([]);
      inputRef.current?.focus();
    }
  }, [attachments, busy, conversationId, fail, notify, patchTurn, refreshConversations, settings, thinkingEnabled, targetId, updateTurns]);

  /**
   * 停止这一轮：先掐断请求，服务端收到断开就把模型那一轮也停了（连带叫住后面还没开始跑的步骤）。
   * 停的是"继续往下查"，不是把查到的抹掉 —— 已经流出来的思考、步骤与半截结论都留在画面上。
   */
  const stop = useCallback(() => {
    const active = runRef.current;
    if (!active) return;
    runRef.current = null;
    active.controller.abort();
    // 立刻收尾这一轮，不等 fetch 的 finally 回来：输入框要马上能用。
    patchTurn(active.id, { busy: false, stopped: true });
    setBusy(false);
    notify("已停止这一轮：已经跑出来的思考和查询留在上面，后面的步骤不再继续。");
  }, [notify, patchTurn]);

  const toggleHistory = useCallback(() => {
    setHistoryOpen((current) => {
      const next = !current;
      window.localStorage.setItem(HISTORY_OPEN_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  /** 开一段新对话：只清界面这一侧，原来的记录仍然留在历史里。 */
  const startNewConversation = useCallback(() => {
    if (busy) return;
    setSession({ targetId, conversationId: null, turns: [] });
    setQuestion("");
    setAttachments([]);
    setPreview(null);
    setConfirmingDelete(null);
    stickRef.current = true;
    inputRef.current?.focus();
  }, [busy, targetId]);

  const openConversation = useCallback(async (id: string) => {
    if (busy || loadingConversation) return;
    setLoadingConversation(id);
    setConfirmingDelete(null);
    try {
      const conversation = await api<ConversationDetail>(`/api/reasoning/conversations/${id}?targetId=${encodeURIComponent(targetId)}`);
      setSession({ targetId, conversationId: conversation.id, turns: conversation.messages.map(messageToTurn) });
      stickRef.current = true;
    } catch (reason) {
      fail(reason);
      // 读不到就是它已经不在了（另一个标签页删过，或换了本体）：顺手把列表刷新干净。
      void refreshConversations();
    } finally {
      setLoadingConversation(null);
    }
  }, [busy, fail, loadingConversation, refreshConversations, targetId]);

  const removeConversation = useCallback(async (id: string) => {
    setConfirmingDelete(null);
    try {
      await api(`/api/reasoning/conversations/${id}?targetId=${encodeURIComponent(targetId)}`, { method: "DELETE" });
      setHistory((current) => ({ targetId, items: current.items.filter((item) => item.id !== id) }));
      // 删掉的正是眼前这段：画面也得跟着空掉，否则会以为没删掉。
      if (conversationId === id) setSession({ targetId, conversationId: null, turns: [] });
      notify("这段对话已从历史里删除。");
    } catch (reason) {
      fail(reason);
      void refreshConversations();
    }
  }, [conversationId, fail, notify, refreshConversations, targetId]);

  return (
    <section className={`qa-root${historyOpen ? " with-history" : ""}`}>
      <header className="qa-head">
        <div className="qa-head-main">
          <span className="qa-head-eyebrow">智能问答</span>
          <b>{ontologyName}</b>
          <span className={`qa-model${status?.configured ? "" : " off"}`}>
            <Sparkles size={12} />
            {status === null ? "模型状态未知" : status.configured ? status.model : "未配置模型"}
          </span>
        </div>
        <div className="qa-head-actions">
          <button
            type="button"
            className={`qa-toggle${historyOpen ? " on" : ""}`}
            onClick={toggleHistory}
            title={historyOpen ? "收起对话历史" : "展开对话历史"}
            aria-expanded={historyOpen}
          >
            <History size={13} />
            对话历史
            <em>{conversations.length}</em>
          </button>
          <button
            type="button"
            className={`qa-toggle${thinkingEnabled ? " on" : ""}`}
            disabled={busy}
            onClick={() => setThinkingEnabled((current) => !current)}
            title={thinkingEnabled ? "模型先思考再回答，更慢但更稳" : "跳过思考，直接回答，更快"}
          >
            <Brain size={13} />
            思考
            <em>{thinkingEnabled ? "开" : "关"}</em>
          </button>
          <button
            type="button"
            className={`qa-toggle${configOpen ? " on" : ""}`}
            onClick={() => setConfigOpen(true)}
            title="问答的运行参数：默认都不限制，想卡才卡"
            aria-expanded={configOpen}
          >
            <Settings2 size={13} />
            问答配置
            {/* 设过限制才挂这个角标：让人一眼看出"这次问答是被限制过的"。 */}
            {hasLimits && <em>已设</em>}
          </button>
          {turns.length > 0 && <button className="action compact" disabled={busy} onClick={startNewConversation} title="清空当前画面，历史记录仍然保留"><Plus size={13} />新对话</button>}
        </div>
      </header>

      <div className="qa-feed" ref={feedRef}>
        {!turns.length && (
          <div className="qa-empty">
            <div className="qa-empty-mark"><Sparkles size={20} /></div>
            <h3>问一个业务问题，看模型怎么在本体上查证</h3>
            <p>
              模型只能通过只读工具读这个本体的定义：先检索概念，再读对象类型与动作，最后给结论。
              思考和每一步查询都会实时显示，每一步传了什么参数、拿到什么返回，都能展开核对。
            </p>
            {!published && <p className="qa-warn"><AlertCircle size={14} />当前本体还没有发布版本。问答只在已发布的本体与图库上跑，先去「本体草稿」发布一次。</p>}
            <div className="qa-examples">
              {EXAMPLES.map((example) => (
                <button key={example} type="button" disabled={busy || !published} onClick={() => void ask(example)}>{example}</button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <article className="qa-turn" key={turn.id}>
            <div className="qa-ask">
              <span>我</span>
              <div className="qa-ask-body">
                <p>{turn.question}</p>
                {turn.attachments.length > 0 && (
                  <div className="qa-ask-images">
                    {turn.attachments.map((item, index) => (
                      <button
                        key={`${item.name}-${index}`}
                        type="button"
                        className="qa-ask-image"
                        onClick={() => setPreview(item)}
                        title={`${item.name} · ${item.width}×${item.height} · 点开看原图`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- 图片是本地压缩后的 data URL，next/image 没法优化它（也不该走图片服务）。 */}
                        <img src={item.dataUrl} alt={item.name} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="qa-answer">
              <div className="qa-answer-head"><span className="qa-answer-mark">本体</span><b>Agent</b></div>

              {(turn.thinkingOn || turn.thinking) && (turn.thinking || turn.busy) && <ThinkingBlock text={turn.thinking} live={turn.busy} />}
              {(turn.steps.length > 0 || turn.busy) && <ProofTrail steps={turn.steps} live={turn.busy} totalMs={turn.run?.elapsedMs ?? 0} />}

              {turn.error && <div className="qa-error"><AlertCircle size={15} />{turn.error}</div>}

              {turn.answer && (
                <div className={`qa-stream${turn.busy ? " live" : ""}`}>
                  <MarkdownView text={turn.answer} className="qa-markdown" />
                </div>
              )}
              {turn.busy && !turn.answer && !turn.thinking && <div className="qa-pending"><Loader2 size={15} className="qa-spin" />{turn.preparing ? "正在整理这段对话的上下文…" : "正在检索本体…"}</div>}
              {!turn.thinkingOn && turn.busy && turn.thinking === "" && <p className="qa-nothink">已关闭思考，直接检索。</p>}
              {/* 被叫停的一轮：说清"是停了、不是错了"，免得看成模型没答上来。 */}
              {turn.stopped && <div className="qa-stopped"><Square size={12} fill="currentColor" />已停止 —— 这一轮是手动停的，已经跑完的步骤留在上面的轨迹里，结论可能不完整。</div>}

              {turn.run && (
                <>
                  <Evidence run={turn.run} onOpenObject={onOpenObject} />
                  <footer className="qa-meta">
                    <span>{turn.run.model}</span>
                    <span>{(turn.run.elapsedMs / 1000).toFixed(1)}s</span>
                    <span>{turn.run.usage.totalTokens} tokens</span>
                    {/* 步数 = 模型调用次数；工具调用可能一步并发多个，所以两个数字分开显示。 */}
                    {/* 平时只说用了几步：没设上限时那个分母（服务端兜底值）不该冒充"限制"。 */}
                    <span>{turn.run.stepCount} 步 · 工具 {turn.run.steps.length} 次</span>
                    {turn.run.context && <span title="同一段对话里回放给模型的历史：最近几轮连求证轨迹一起带，更早的压成摘要">{historyLabel(turn.run.context)}</span>}
                    {turn.run.context?.warning && <em>{turn.run.context.warning}</em>}
                    {turn.run.truncated && <em>步数用满（{turn.run.stepCount}/{turn.run.maxSteps}），模型是被拦停的，结论可能不完整</em>}
                  </footer>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      <div
        className={`qa-compose${dragging ? " dragging" : ""}`}
        onDragOver={(event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          if (!event.dataTransfer?.files.length) return;
          event.preventDefault();
          setDragging(false);
          // 同样是活对象：拖放的 files 出了事件回调就可能失效，先拷一份。
          void addFiles([...event.dataTransfer.files]);
        }}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          // 先把 FileList 拷成数组再清空 input：`event.target.files` 是活的对象，清空后它自己也空了。
          onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void addFiles(files); }}
        />
        <div className="qa-compose-main">
          {attachments.length > 0 && (
            <div className="qa-attachments">
              {attachments.map((item, index) => (
                <figure className="qa-attachment" key={`${item.name}-${index}`}>
                  <button type="button" className="qa-attachment-open" onClick={() => setPreview(item)} title="点开看原图">
                    {/* eslint-disable-next-line @next/next/no-img-element -- 图片是本地压缩后的 data URL，next/image 没法优化它（也不该走图片服务）。 */}
                    <img src={item.dataUrl} alt={item.name} />
                  </button>
                  <figcaption>{item.width}×{item.height} · {formatBytes(item.bytes)}</figcaption>
                  <button type="button" className="qa-attachment-remove" onClick={() => removeAttachment(index)} aria-label={`移除图片 ${item.name}`} title="移除这张图"><X size={12} /></button>
                </figure>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onPaste={(event) => {
              // 截图直接粘贴进来。纯文字粘贴照旧走浏览器默认行为。
              const pasted = [...event.clipboardData.items]
                .filter((item) => item.kind === "file")
                .map((item) => item.getAsFile())
                .filter((file): file is File => Boolean(file));
              if (!pasted.length) return;
              event.preventDefault();
              void addFiles(pasted);
            }}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }}
            placeholder={published ? "问一个业务问题，例如：哪些用户开了专线？（截图可以直接粘贴或拖进来）" : "当前本体还没有发布版本，先去发布"}
            rows={1}
            disabled={busy}
          />
        </div>
        <div className="qa-compose-actions">
          <button
            type="button"
            className="qa-attach"
            disabled={busy || !published || preparing}
            onClick={() => fileRef.current?.click()}
            title="加一张图片（截图直接粘贴、或者把图片拖进来也行）"
          >
            {preparing ? <Loader2 size={15} className="qa-spin" /> : <ImagePlus size={15} />}
            图片
            {attachments.length > 0 && <em>{attachments.length}/{MAX_ATTACHMENTS}</em>}
          </button>
          {/* 跑的过程中这个主按钮就地变成「停止」：那一格里最该点的就是它，不必再去页头找。 */}
          {busy ? (
            <button type="button" className="action stop" onClick={stop} title="停止这一轮：模型立刻收手，已经跑出来的部分留在上面">
              <Square size={13} fill="currentColor" />
              停止
            </button>
          ) : (
            <button type="button" className="action primary" disabled={(!question.trim() && !attachments.length) || !published} onClick={() => void ask(question)}>
              <Send size={15} />
              发送
            </button>
          )}
        </div>
        {dragging && <div className="qa-compose-drop">松手就把它加进这一轮</div>}
      </div>

      {historyOpen && (
        <HistoryRail
          conversations={conversations}
          activeId={conversationId}
          loadingId={loadingConversation}
          confirmingId={confirmingDelete}
          busy={busy}
          onOpen={(id) => void openConversation(id)}
          onAskDelete={setConfirmingDelete}
          onCancelDelete={() => setConfirmingDelete(null)}
          onConfirmDelete={(id) => void removeConversation(id)}
        />
      )}

      {configOpen && (
        <div className="qa-config-backdrop" role="presentation" onClick={() => setConfigOpen(false)}>
          <aside className="qa-config" role="dialog" aria-modal="true" aria-label="问答配置" onClick={(event) => event.stopPropagation()}>
            <header className="qa-config-head">
              <Settings2 size={15} />
              <b>问答配置</b>
              <button type="button" className="qa-config-close" onClick={() => setConfigOpen(false)} aria-label="关闭"><X size={15} /></button>
            </header>
            <div className="qa-config-body">
              <p className="qa-config-note">
                上面这几个数只管「结论完不完整」。<b>留空就是不限制</b>，由模型自己把握；填了才按填的数卡。
                下面那段系统提示词可以直接改，<b>默认的已经填好了</b>。
              </p>
              <div className="qa-config-section">
                <div className="qa-config-section-head">
                  <span className="eyebrow">参数</span>
                  <button type="button" className="qa-config-reset" onClick={resetSettings}>恢复默认</button>
                </div>
                {REASONING_SETTING_FIELDS.map((field) => (
                  <label className="qa-config-field" key={field.key}>
                    <span className="qa-config-name">
                      <b>{field.label}</b>
                      <i>{REASONING_SETTING_RANGES[field.key].min}–{REASONING_SETTING_RANGES[field.key].max}</i>
                    </span>
                    <span className="qa-config-input">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={REASONING_SETTING_RANGES[field.key].min}
                        max={REASONING_SETTING_RANGES[field.key].max}
                        placeholder={field.placeholder}
                        value={settings[field.key] ?? ""}
                        onChange={(event) => updateSetting(field.key, event.target.value)}
                      />
                      <em>{field.suffix}</em>
                    </span>
                    <small>{field.hint}</small>
                  </label>
                ))}
              </div>
              <div className="qa-config-section">
                <div className="qa-config-section-head">
                  <span className="eyebrow">系统提示词</span>
                  <button type="button" className="qa-config-reset" onClick={() => updateSystemPrompt(DEFAULT_SYSTEM_PROMPT)}>恢复默认</button>
                </div>
                <textarea
                  className="qa-config-prompt"
                  value={systemPromptText}
                  spellCheck={false}
                  onChange={(event) => updateSystemPrompt(event.target.value)}
                  aria-label="系统提示词"
                />
                <small className="qa-config-hint">
                  这是模型每次都会收到的系统提示词（就是上面那段原文，可以直接改）。
                  <b>当前本体的概念清单会自动接在它后面</b>——概念分组与成员、对象类型与它绑的表、关系类型、动作、数据资源，这些是数据不是提示词，不用自己写。
                </small>
                <small className={customPrompt ? "qa-config-prompt-state custom" : "qa-config-prompt-state"}>
                  {customPrompt
                    ? `正在用自定义提示词（${systemPromptText.length} 字，超过 ${SYSTEM_PROMPT_LIMIT} 字会被截断）—— 点「恢复默认」回到默认那段。`
                    : "当前用的是默认提示词。"}
                </small>
              </div>
              <p className="qa-config-foot">
                真正护着数据库的那几条不在这里，也不能关：只读事务、语句超时、写操作拦截。
              </p>
            </div>
          </aside>
        </div>
      )}

      {preview && (
        <div className="qa-lightbox" role="dialog" aria-modal="true" aria-label="图片预览" onClick={() => setPreview(null)}>
          <figure onClick={(event) => event.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 图片是本地压缩后的 data URL，next/image 没法优化它（也不该走图片服务）。 */}
            <img src={preview.dataUrl} alt={preview.name} />
            <figcaption>
              <b>{preview.name}</b>
              <span>{preview.width}×{preview.height} · {formatBytes(preview.bytes)} · {preview.mediaType}</span>
              <button type="button" className="qa-lightbox-close" onClick={() => setPreview(null)} aria-label="关闭预览"><X size={15} /></button>
            </figcaption>
          </figure>
        </div>
      )}
    </section>
  );
}

function Evidence({ run, onOpenObject }: { run: ReasoningRun; onOpenObject: (id: string) => void }) {
  const concepts = run.evidence.filter((item) => item.kind === "OBJECT_TYPE" || item.kind === "RELATION_TYPE" || item.kind === "ACTION" || item.kind === "INTERFACE");
  const objects = run.evidence.filter((item) => item.kind === "OBJECT");
  const relationships = run.evidence.filter((item) => item.kind === "RELATIONSHIP");
  if (!concepts.length && !objects.length && !relationships.length) return null;
  return (
    <div className="qa-evidence">
      <span className="qa-evidence-label">依据</span>
      <div className="qa-chips">
        {concepts.map((item) => <span className="qa-chip concept" key={`${item.kind}-${item.id}`}><Boxes size={11} />{item.label}</span>)}
        {objects.map((item) => (
          <button className="qa-chip object" key={item.id} onClick={() => onOpenObject(item.id)} title={item.id}>
            <CircleDot size={11} />{item.label}
          </button>
        ))}
        {relationships.map((item) => <span className="qa-chip concept" key={item.id}><Link2 size={11} />{item.label}</span>)}
      </div>
    </div>
  );
}