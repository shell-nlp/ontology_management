"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Boxes, ChevronDown, CircleDot, Eraser, Link2, Loader2, Play, Send, Sparkles } from "lucide-react";
import { api } from "@/lib/api-client";
import type { ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";
import "./qa-studio.css";

/**
 * 智能问答：用已发布的本体回答业务问题。
 *
 * 设计取的是"实验记录"而不是"聊天"：Agent 的回复不是气泡，而是一份通栏的求证报告 ——
 * 最上面一条「求证轨迹」说明它查了哪几步，下面是结论，再下面是能点回对象页的证据。
 * 页面唯一的签名元素就是这条轨迹，其它地方都刻意安静。
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
  run: ReasoningRun | null;
  error: string | null;
  busy: boolean;
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

/** 单步展开后的原始返回；抽出来是因为轨迹里每一步都用它。 */
function StepResult({ step }: { step: ReasoningStep }) {
  return <pre className="qa-step-result">{step.result}</pre>;
}

/**
 * 求证轨迹：这一步的签名元素。
 * 横向一串节点，每个节点是「第几步 · 调了什么 · 命中多少 · 耗时」，点开看原始返回。
 */
function ProofTrail({ steps, totalMs }: { steps: ReasoningStep[]; totalMs: number }) {
  const [open, setOpen] = useState(false);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const summary = useMemo(() => {
    if (!steps.length) return "没有调用工具";
    const hits = steps.reduce((sum, step) => sum + step.evidence.length, 0);
    return `已调用工具 ${steps.length} 次 · 命中 ${hits} 项 · ${(totalMs / 1000).toFixed(1)}s`;
  }, [steps, totalMs]);

  return (
    <div className={`qa-trail${open ? " open" : ""}`}>
      <button type="button" className="qa-trail-summary" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="qa-trail-badge">求证轨迹</span>
        <span className="qa-trail-text">{summary}</span>
        <ChevronDown size={15} className={open ? "is-open" : ""} />
      </button>
      {open && (
        <ol className="qa-trail-steps">
          {steps.map((step) => (
            <li key={step.index} className={`qa-trail-step${step.ok ? "" : " failed"}${openStep === step.index ? " expanded" : ""}`}>
              <button type="button" onClick={() => setOpenStep(openStep === step.index ? null : step.index)} aria-expanded={openStep === step.index}>
                <span className="qa-trail-node">{step.index}</span>
                <b>{TOOL_LABELS[step.tool] ?? step.tool}</b>
                <code>{step.tool}</code>
                <span className="qa-trail-facts">
                  {step.ok ? (step.evidence.length ? `命中 ${step.evidence.length}` : "无命中") : "出错"}
                  <i>{step.elapsedMs}ms</i>
                </span>
              </button>
              {openStep === step.index && <StepResult step={step} />}
            </li>
          ))}
          {!steps.length && <li className="qa-trail-empty">模型直接给出了结论，没有查询图库。</li>}
        </ol>
      )}
    </div>
  );
}

export function QaStudio({ targetId, ontologyName, published, onOpenObject, notify, fail }: Props) {
  // 会话和它所属的本体绑在一起：换了本体就当新会话，直接派生，不用 effect 去清空。
  const [session, setSession] = useState<{ targetId: string; turns: Turn[] }>(() => ({ targetId, turns: [] }));
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const turns = useMemo(() => (session.targetId === targetId ? session.turns : []), [session, targetId]);
  const updateTurns = useCallback((updater: (current: Turn[]) => Turn[]) => {
    setSession((current) => ({ targetId, turns: updater(current.targetId === targetId ? current.turns : []) }));
  }, [targetId]);
  useEffect(() => {
    void api<{ configured: boolean; model: string | null }>("/api/reasoning/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);


  const ask = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    if (!targetId) { fail(new Error("请先在左侧选择一个本体。")); return; }
    const id = `${Date.now()}`;
    setQuestion("");
    setBusy(true);
    updateTurns((current) => [...current, { id, question: trimmed, run: null, error: null, busy: true }]);
    try {
      const run = await api<ReasoningRun>("/api/reasoning/run", { method: "POST", body: JSON.stringify({ targetId, question: trimmed }) });
      updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, run, busy: false } : turn)));
      notify(`推理完成：${run.steps.length} 步，引用 ${run.evidence.length} 项证据。`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "推理失败。";
      updateTurns((current) => current.map((turn) => (turn.id === id ? { ...turn, error: message, busy: false } : turn)));
      fail(reason);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [busy, fail, notify, targetId, updateTurns]);

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
              每一步都会留下轨迹，结论里引用的对象可以直接点开核对。
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
              {turn.busy && <div className="qa-pending"><Loader2 size={15} className="qa-spin" />正在检索本体并逐步查证…</div>}
              {turn.error && <div className="qa-error"><AlertCircle size={15} />{turn.error}</div>}
              {turn.run && (
                <>
                  <ProofTrail steps={turn.run.steps} totalMs={turn.run.elapsedMs} />
                  <Markdown text={turn.run.answer} />
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
