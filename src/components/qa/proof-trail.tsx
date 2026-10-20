"use client";

import { useMemo, useState } from "react";
import { Brain, ChevronDown, Loader2 } from "lucide-react";
import { formatDuration } from "@/lib/shared/common/format-units";
import { toolTitle } from "@/lib/reasoning/tool-labels";
import type { ReasoningStep } from "@/lib/reasoning/types";
import "../qa-studio.css";

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
export function ProofTrail({ steps, live, totalMs }: { steps: ReasoningStep[]; live: boolean; totalMs: number }) {
  // 默认收起；推理中自动展开，让过程可见（用户手动收起来后就尊重用户的选择）。
  const [manual, setManual] = useState<boolean | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const open = manual ?? live;
  const summary = useMemo(() => {
    if (!steps.length) return live ? "正在检索本体…" : "没有调用工具";
    const hits = steps.reduce((sum, step) => sum + step.evidence.length, 0);
    // 证据数为 0 时不写"证据 0 项"：这一轮本来就可能是纯查数据（不产生证据）。
    // 单位随量级变（ms / s / 分秒 / 小时）：10 步跑两分钟时写 111.5s 没人读得出量级。
    return [`已调用工具 ${steps.length} 次`, hits ? `证据 ${hits} 项` : "", formatDuration(totalMs || 0)].filter(Boolean).join(" · ");
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
                <b>{toolTitle(step.tool)}</b>
                <span className="qa-trail-args">{argumentSummary(step.arguments)}</span>
                <span className="qa-trail-facts">
                  {step.ok ? step.summary ?? "已返回" : "出错"}
                  <i>{formatDuration(step.elapsedMs)}</i>
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
export function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
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

