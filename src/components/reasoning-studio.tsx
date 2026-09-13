"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Boxes, Check, ChevronDown, CircleDot, Link2, Loader2, Play, RefreshCcw, Sparkles, Wrench } from "lucide-react";
import { api } from "@/lib/api-client";
import type { ReasoningRun, ReasoningStep } from "@/lib/reasoning/types";
import "./reasoning-studio.css";

/** 工具的中文名：步骤时间线上要让人一眼看懂"它在干什么"。 */
const TOOL_LABELS: Record<string, string> = {
  search_schema: "检索本体",
  get_object_type: "读取对象类型",
  query_object_instance: "查询对象",
  query_instance_subgraph: "查询子图",
  list_actions: "列出动作",
};

const EXAMPLES = [
  "这个本体里有哪些对象类型？各自有多少个对象？",
  "把所有对象和它们之间的关系列出来",
  "哪些对象类型之间有父子关系？",
  "这个本体定义里有没有可以直接改数据的动作？",
];

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
    // 表格：| a | b | 紧跟一行 |---|---|
    if (line.trim().startsWith("|")) {
      const header = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        rows.push(lines[cursor].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
        cursor += 1;
      }
      blocks.push(
        <div className="rs-table-wrap" key={`t-${key}`}>
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
  return <div className="rs-markdown">{blocks}</div>;
}

function StepRow({ step }: { step: ReasoningStep }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => {
    const entries = Object.entries(step.arguments).filter(([, value]) => value !== undefined && value !== null && String(value) !== "");
    return entries.map(([name, value]) => `${name}=${Array.isArray(value) ? value.join(",") : String(value)}`).join(" · ") || "无参数";
  }, [step.arguments]);
  return (
    <li className={`rs-step${step.ok ? "" : " failed"}`}>
      <button type="button" className="rs-step-head" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="rs-step-index">{step.index}</span>
        <span className="rs-step-main">
          <b>{TOOL_LABELS[step.tool] ?? step.tool}</b>
          <code>{step.tool}</code>
          <small>{summary}</small>
        </span>
        <span className="rs-step-state">
          {step.ok ? <Check size={13} /> : <AlertCircle size={13} />}
          {step.evidence.length ? <em>{step.evidence.length} 条证据</em> : null}
          <i>{step.elapsedMs}ms</i>
          <ChevronDown size={14} className={open ? "is-open" : ""} />
        </span>
      </button>
      {open && <pre className="rs-step-result">{step.result}</pre>}
    </li>
  );
}

export function ReasoningStudio({ targetId, ontologyName, published, onOpenObject, notify, fail }: Props) {
  const [question, setQuestion] = useState("");
  const [run, setRun] = useState<ReasoningRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ configured: boolean; model: string | null }>("/api/reasoning/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  const execute = useCallback(async (text: string) => {
    if (!targetId) { fail(new Error("请先在左侧选择一个本体。")); return; }
    if (!text.trim() || busy) return;
    setBusy(true);
    setLocalError(null);
    setRun(null);
    try {
      const result = await api<ReasoningRun>("/api/reasoning/run", { method: "POST", body: JSON.stringify({ targetId, question: text.trim() }) });
      setRun(result);
      notify(`推理完成：${result.steps.length} 步，引用 ${result.evidence.length} 项证据。`);
    } catch (reason) {
      setLocalError(reason instanceof Error ? reason.message : "推理失败。");
      fail(reason);
    } finally {
      setBusy(false);
    }
  }, [busy, fail, notify, targetId]);

  const objects = run ? run.evidence.filter((item) => item.kind === "OBJECT") : [];
  const concepts = run ? run.evidence.filter((item) => item.kind !== "OBJECT" && item.kind !== "RELATIONSHIP") : [];
  const relationships = run ? run.evidence.filter((item) => item.kind === "RELATIONSHIP") : [];

  return (
    <section className="stack rs-root">
      <div className="panel functional-panel rs-ask">
        <div className="title-row">
          <div>
            <span className="eyebrow">推理</span>
            <h2>让模型在本体上多步推理</h2>
          </div>
          <span className={`rs-model${status?.configured ? "" : " off"}`}>
            <Sparkles size={13} />
            {status === null ? "模型状态未知" : status.configured ? status.model : "未配置模型"}
          </span>
        </div>
        <p className="subtle">
          模型只能通过只读工具查询本体与图库：先检索概念，再取实例与子图，最后给结论。每一步都留痕，证据里是图库里的真实对象。
        </p>
        <div className="rs-input">
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void execute(question); }}
            placeholder="用一句业务问题描述你想知道什么，例如：专业线产品用户和普通用户有什么区别？"
            rows={3}
          />
          <button className="action primary" disabled={busy || !question.trim() || !published} onClick={() => void execute(question)}>
            {busy ? <Loader2 size={15} className="rs-spin" /> : <Play size={15} />}
            {busy ? "推理中…" : "开始推理"}
          </button>
        </div>
        {!published && <p className="rs-hint">当前本体还没有发布版本。推理只在已发布的本体与图库上跑，先去「本体草稿」发布一次。</p>}
        <div className="rs-examples">
          <span>试试：</span>
          {EXAMPLES.map((example) => (
            <button key={example} type="button" disabled={busy} onClick={() => { setQuestion(example); void execute(example); }}>{example}</button>
          ))}
        </div>
      </div>

      {localError && <div className="panel functional-panel rs-error"><AlertCircle size={16} />{localError}</div>}

      {run && (
        <div className="rs-result">
          <div className="panel functional-panel rs-steps">
            <div className="title-row">
              <div><span className="eyebrow">推理步骤</span><h2>{run.steps.length} 步</h2></div>
              <button className="action compact" disabled={busy} onClick={() => void execute(run.question)}><RefreshCcw size={13} />重跑</button>
            </div>
            <ol className="rs-step-list">
              {run.steps.map((step) => <StepRow key={step.index} step={step} />)}
              {!run.steps.length && <li className="rs-step-empty">模型直接给出了结论，没有调用任何工具。</li>}
            </ol>
          </div>

          <div className="panel functional-panel rs-answer">
            <span className="eyebrow">结论</span>
            <Markdown text={run.answer} />

            {concepts.length > 0 && (
              <div className="rs-evidence">
                <span className="eyebrow">用到的概念</span>
                <div className="rs-chips">{concepts.map((item) => <span className="rs-chip" key={`${item.kind}-${item.id}`}><Boxes size={12} />{item.label}</span>)}</div>
              </div>
            )}
            {objects.length > 0 && (
              <div className="rs-evidence">
                <span className="eyebrow">引用的对象（点击去对象页核对）</span>
                <div className="rs-chips">
                  {objects.map((item) => (
                    <button className="rs-chip link" key={item.id} onClick={() => onOpenObject(item.id)} title={item.id}>
                      <CircleDot size={12} />{item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {relationships.length > 0 && (
              <div className="rs-evidence">
                <span className="eyebrow">引用的关系</span>
                <div className="rs-chips">{relationships.map((item) => <span className="rs-chip" key={item.id}><Link2 size={12} />{item.label}</span>)}</div>
              </div>
            )}

            <div className="rs-meta">
              <span><Wrench size={12} />{ontologyName}</span>
              <span>{run.model}</span>
              <span>{(run.elapsedMs / 1000).toFixed(1)}s</span>
              <span>{run.usage.totalTokens} tokens</span>
              {run.truncated && <em>达到步数上限，结论可能不完整</em>}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
