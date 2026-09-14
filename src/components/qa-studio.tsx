"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Boxes, Brain, ChevronDown, CircleDot, Eraser, Link2, Loader2, Send, Sparkles } from "lucide-react";
import type { ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";
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
  "这个本体里有哪些对象类型？各自有多少个对象？",
  "有哪些对象类型之间有父子关系？",
  "把所有对象和它们之间的关系列出来",
  "本体里定义了哪些可以直接改数据的动作？",
];

type Turn = {
  id: string;
  question: string;
  thinking: string;
  answer: string;
  steps: ReasoningStep[];
  run: ReasoningRun | null;
  error: string | null;
  busy: boolean;
  /** 这一轮有没有开思考。关掉时不显示「思考过程」，否则会挂一个永远空着的块。 */
  thinkingOn: boolean;
};

type Props = {
  targetId: string;
  ontologyName: string;
  published: boolean;
  onOpenObject: (objectId: string) => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

/** 极简 Markdown：只覆盖模型实际会输出的那几种（标题、粗体、行内代码、列表、表格）。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part !== "");
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    return <Fragment key={`${keyPrefix}-${index}`}>{part}</Fragment>;
  });
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (line.trim().startsWith("|")) {
      const header = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        rows.push(lines[cursor].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
        cursor += 1;
      }
      blocks.push(
        <div className="qa-table-wrap" key={`t-${key}`}>
          <table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `th-${key}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, `td-${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      key += 1; index = cursor; continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={`h-${key}`}>{inline(line.replace(/^#{1,6}\s/, ""), `h-${key}`)}</h4>);
      key += 1; index += 1; continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      blocks.push(<ul key={`ul-${key}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `li-${key}-${itemIndex}`)}</li>)}</ul>);
      key += 1; continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].trim().startsWith("|") && !/^#{1,6}\s/.test(lines[index]) && !/^\s*([-*]|\d+\.)\s/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${key}`}>{inline(paragraph.join(" "), `p-${key}`)}</p>);
    key += 1;
  }
  return <div className="qa-markdown">{blocks}</div>;
}

/**
 * 求证轨迹：这一页的签名元素。
 * 横向一串节点，每个是「第几步 · 调了什么 · 命中多少 · 耗时」，点开看原始返回。
 * 推理进行中也是活的：步骤一完成就出现在这里。
 */
function ProofTrail({ steps, live, totalMs }: { steps: ReasoningStep[]; live: boolean; totalMs: number }) {
  // 默认收起；推理中自动展开，让过程可见（用户手动收起来后就尊重用户的选择）。
  const [manual, setManual] = useState<boolean | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const open = manual ?? live;
  const summary = useMemo(() => {
    if (!steps.length) return live ? "正在检索本体…" : "没有调用工具";
    const hits = steps.reduce((sum, step) => sum + step.evidence.length, 0);
    return `已调用工具 ${steps.length} 次 · 命中 ${hits} 项 · ${((totalMs || 0) / 1000).toFixed(1)}s`;
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
                <span className="qa-trail-facts">
                  {step.ok ? (step.evidence.length ? `命中 ${step.evidence.length}` : "无命中") : "出错"}
                  <i>{step.elapsedMs}ms</i>
                </span>
              </button>
              {openStep === step.index && <pre className="qa-step-result">{step.result}</pre>}
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

/** 消费 SSE：把后端的事件翻译成界面状态。 */
async function streamRun(
  targetId: string,
  question: string,
  thinking: boolean,
  handlers: {
    onThinking: (text: string) => void;
    onAnswer: (text: string) => void;
    onAnswerReset: () => void;
    onStep: (step: ReasoningStep) => void;
    onDone: (run: ReasoningRun) => void;
  },
) {
  const response = await fetch("/api/reasoning/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId, question, thinking }),
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
      else if (event.type === "done") handlers.onDone(event.run as ReasoningRun);
      else if (event.type === "error") throw new Error(String(event.message ?? "推理失败。"));
    }
  }
}

export function QaStudio({ targetId, ontologyName, published, onOpenObject, notify, fail }: Props) {
  // 会话和它所属的本体绑在一起：换了本体就当新会话，直接派生，不用 effect 去清空。
  const [session, setSession] = useState<{ targetId: string; turns: Turn[] }>(() => ({ targetId, turns: [] }));
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // 用户往上翻了就不自动跟随，免得读一半被拽回底部。
  const stickRef = useRef(true);

  const turns = useMemo(() => (session.targetId === targetId ? session.turns : []), [session, targetId]);
  const updateTurns = useCallback((updater: (current: Turn[]) => Turn[]) => {
    setSession((current) => ({ targetId, turns: updater(current.targetId === targetId ? current.turns : []) }));
  }, [targetId]);
  const patchTurn = useCallback((id: string, patch: Partial<Turn>) => {
    updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, ...patch } : turn)));
  }, [updateTurns]);

  useEffect(() => {
    void fetch("/api/reasoning/status").then((res) => res.json()).then(setStatus).catch(() => setStatus(null));
  }, []);

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

  const ask = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (!targetId) { fail(new Error("请先在左侧选择一个本体。")); return; }
    const id = `${Date.now()}`;
    setQuestion("");
    setBusy(true);
    stickRef.current = true;
    updateTurns((current) => [...current, { id, question: trimmed, thinking: "", answer: "", steps: [], run: null, error: null, busy: true, thinkingOn: thinkingEnabled }]);
    try {
      await streamRun(targetId, trimmed, thinkingEnabled, {
        onThinking: (delta) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, thinking: turn.thinking + delta } : turn))),
        onAnswer: (delta) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, answer: turn.answer + delta } : turn))),
        // 这一段其实是"要调工具"前的过渡语，不是结论。别丢掉 —— 关掉思考时模型会把旁白写在这里，
        // 挪进思考过程既保留了过程，又不会让结论区闪出半句话。
        onAnswerReset: () => updateTurns((current) => current.map((turn) => (
          turn.id === id ? { ...turn, thinking: turn.thinking ? `${turn.thinking}\n${turn.answer}` : turn.answer, answer: "" } : turn
        ))),
        onStep: (step) => updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, steps: [...turn.steps, step] } : turn))),
        onDone: (run) => { patchTurn(id, { run, busy: false }); notify(`推理完成：${run.steps.length} 步，引用 ${run.evidence.length} 项证据。`); },
      });
    } catch (reason) {
      patchTurn(id, { error: reason instanceof Error ? reason.message : "推理失败。", busy: false });
      fail(reason);
    } finally {
      patchTurn(id, { busy: false });
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, fail, notify, patchTurn, thinkingEnabled, targetId, updateTurns]);

  return (
    <section className="qa-root">
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
            className={`qa-toggle${thinkingEnabled ? " on" : ""}`}
            disabled={busy}
            onClick={() => setThinkingEnabled((current) => !current)}
            title={thinkingEnabled ? "模型先思考再回答，更慢但更稳" : "跳过思考，直接回答，更快"}
          >
            <Brain size={13} />
            思考
            <em>{thinkingEnabled ? "开" : "关"}</em>
          </button>
          {turns.length > 0 && <button className="action compact" disabled={busy} onClick={() => updateTurns(() => [])}><Eraser size={13} />清空</button>}
        </div>
      </header>

      <div className="qa-feed" ref={feedRef}>
        {!turns.length && (
          <div className="qa-empty">
            <div className="qa-empty-mark"><Sparkles size={20} /></div>
            <h3>问一个业务问题，看模型怎么在本体上查证</h3>
            <p>
              模型只能通过只读工具读取这个本体：先检索概念，再取对象与子图，最后给结论。
              思考和每一步查询都会实时显示，结论里引用的对象可以直接点开核对。
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
            <div className="qa-ask"><span>我</span><p>{turn.question}</p></div>
            <div className="qa-answer">
              <div className="qa-answer-head"><span className="qa-answer-mark">本体</span><b>Agent</b></div>

              {(turn.thinkingOn || turn.thinking) && (turn.thinking || turn.busy) && <ThinkingBlock text={turn.thinking} live={turn.busy} />}
              {(turn.steps.length > 0 || turn.busy) && <ProofTrail steps={turn.steps} live={turn.busy} totalMs={turn.run?.elapsedMs ?? 0} />}

              {turn.error && <div className="qa-error"><AlertCircle size={15} />{turn.error}</div>}

              {turn.answer && (
                <div className={`qa-stream${turn.busy ? " live" : ""}`}>
                  <Markdown text={turn.answer} />
                </div>
              )}
              {turn.busy && !turn.answer && !turn.thinking && <div className="qa-pending"><Loader2 size={15} className="qa-spin" />正在检索本体…</div>}
              {!turn.thinkingOn && turn.busy && turn.thinking === "" && <p className="qa-nothink">已关闭思考，直接检索。</p>}

              {turn.run && (
                <>
                  <Evidence run={turn.run} onOpenObject={onOpenObject} />
                  <footer className="qa-meta">
                    <span>{turn.run.model}</span>
                    <span>{(turn.run.elapsedMs / 1000).toFixed(1)}s</span>
                    <span>{turn.run.usage.totalTokens} tokens</span>
                    {turn.run.truncated && <em>达到步数上限，结论可能不完整</em>}
                  </footer>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="qa-compose">
        <textarea
          ref={inputRef}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(question); } }}
          placeholder={published ? "问一个业务问题，例如：哪些用户开了专线？" : "当前本体还没有发布版本，先去发布"}
          rows={1}
          disabled={busy}
        />
        <button className="action primary" disabled={busy || !question.trim() || !published} onClick={() => void ask(question)}>
          {busy ? <Loader2 size={15} className="qa-spin" /> : <Send size={15} />}
          发送
        </button>
      </div>
    </section>
  );
}

function Evidence({ run, onOpenObject }: { run: ReasoningRun; onOpenObject: (id: string) => void }) {
  const concepts = run.evidence.filter((item) => item.kind === "OBJECT_TYPE" || item.kind === "RELATION_TYPE" || item.kind === "ACTION");
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
