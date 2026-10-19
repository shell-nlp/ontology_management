"use client";

import { AlertTriangle, Check, CircleSlash, ShieldAlert } from "lucide-react";
import type { RuleEffect } from "@/lib/ontology/draft";

const effectLabel = (effect: RuleEffect) => effect === "BLOCK" ? "拦截" : effect === "WARN" ? "提示" : "隐藏";

/** 写回计划（界面看的形态）：干跑时就能看到"点执行会写哪张表的哪几列"。 */
export type WritebackPlanView = {
  entityType: string;
  table: string;
  dataSourceName: string;
  description: string;
  keys: { column: string; value: unknown }[];
  assignments: { column: string; property: string; value: unknown }[];
};

/** 写不回去的那一处：`reason` 说清为什么，`hint` 给一条能马上走的路。 */
export type WritebackRefusal = { nodeId: string; entityType: string; reason: string; hint?: string };

/** 真写下去的每一处：表、旧值 → 新值、实际语句。 */
export type WritebackExecution = {
  entityType: string;
  table: string;
  dataSourceName: string;
  statement: string;
  written: { property: string; column: string; from: unknown; to: unknown }[];
};

export type WritebackReport = {
  requested: boolean;
  /** OFF = 没勾写回；PREVIEW = 干跑出的计划；APPLIED = 已经写进业务库；REFUSED = 有写不回的，整批没执行。 */
  mode: "OFF" | "PREVIEW" | "APPLIED" | "REFUSED";
  plans: WritebackPlanView[];
  refusals: WritebackRefusal[];
  skipped: { nodeId: string; entityType: string; reason: string }[];
  executions: WritebackExecution[];
};

export type ActionFinding = { ruleId: string; ruleName: string; effect: RuleEffect; message: string; evidence: string[] };

export type ActionRunOutcome = {
  actionId: string;
  actionName: string;
  actionCode: string;
  verdict: "PASSED" | "BLOCKED";
  blockers: ActionFinding[];
  warnings: ActionFinding[];
  hidden: ActionFinding[];
  steps: string[];
  createdEntities: { id: string; label: string; display: string }[];
  subject: { id: string; label: string; display: string } | null;
  dryRun: boolean;
  applied: boolean;
  /** 写回业务库的情况：没勾写回时是 OFF，勾了干跑是 PREVIEW。 */
  writeback?: WritebackReport;
};


export function OutcomePanel({ outcome }: { outcome: ActionRunOutcome }) {
  const blocked = outcome.verdict === "BLOCKED";
  return (
    <div className={blocked ? "as-outcome blocked" : "as-outcome passed"}>
      <div className="as-verdict">
        {blocked ? <AlertTriangle size={16} /> : <Check size={16} />}
        <b>{blocked ? "被规则拦截，未写入" : outcome.applied ? "执行成功，已写入草稿快照" : "干跑通过，未写入"}</b>
        <span>{outcome.actionName} · {outcome.actionCode}</span>
        {outcome.subject && <span className="as-verdict-subject">作用于 {outcome.subject.label}「{outcome.subject.display}」</span>}
      </div>
      {outcome.blockers.map((finding) => <Finding key={finding.ruleId} finding={finding} level="blocker" />)}
      {outcome.warnings.map((finding) => <Finding key={finding.ruleId} finding={finding} level="warning" />)}
      {outcome.hidden.length > 0 && (
        <div className="as-hidden-note">
          <b><CircleSlash size={12} />这个动作本不该出现在该对象上</b>
          {outcome.hidden.map((finding) => <p key={finding.ruleId}>{finding.ruleName}{finding.message ? `：${finding.message}` : ""}</p>)}
        </div>
      )}
      {outcome.steps.length > 0 && (
        <div className="as-rail-block">
          <b>{outcome.applied ? "已执行的操作" : "计划的操作"}</b>
          <ol className="as-steps">{outcome.steps.map((step, index) => <li key={`${index}-${step}`}><span>{step}</span></li>)}</ol>
        </div>
      )}
      {outcome.createdEntities.length > 0 && (
        <div className="as-created">
          {outcome.createdEntities.map((entity) => <span key={entity.id}>{entity.label} <code>{entity.display}</code></span>)}
        </div>
      )}
      <WritebackPanel report={outcome.writeback} />
    </div>
  );
}

const writebackModeLabel: Record<WritebackReport["mode"], string> = {
  OFF: "写回业务库：没开启（勾上才会真的写源表）",
  PREVIEW: "写回业务库：这是计划（干跑，没写库）",
  APPLIED: "写回业务库：已经写进去了",
  REFUSED: "写回业务库：被拒，整批都没有执行",
};

function formatWritebackValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "（空）";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 写回报告：**计划**（会写哪张表、哪几列）、**结果**（旧值 → 新值、实际语句）、**拒绝**（哪一处、为什么、去哪儿改）。
 * 三样都摆出来，是因为"写业务库"是平台里唯一不可逆的动作，用户必须能在点之前和点之后都看清。
 */
function WritebackPanel({ report }: { report?: WritebackReport }) {
  if (!report) return null;
  // 没勾写回、这次又什么都没改到，就整块不显示 —— 不是"空面板占位"。
  const empty = !report.plans.length && !report.refusals.length && !report.executions.length && !report.skipped.length;
  if (empty) return null;
  const refused = report.mode === "REFUSED";
  return (
    <div className={refused ? "as-writeback-panel refused" : "as-writeback-panel"}>
      <div className="as-writeback-head">
        <b>{writebackModeLabel[report.mode]}</b>
        {report.executions.length > 0 && <span className="as-chip passed">{report.executions.length} 处已写库</span>}
        {report.mode === "PREVIEW" && report.plans.length > 0 && <span className="as-chip muted">{report.plans.length} 处待写</span>}
      </div>
      {report.plans.map((plan) => (
        <div className="as-writeback-row" key={`plan-${plan.entityType}-${plan.description}`}>
          <b>{plan.entityType}</b>
          <span className="as-writeback-table">{plan.table}{plan.dataSourceName ? ` · ${plan.dataSourceName}` : ""}</span>
          <ul>
            {plan.keys.map((key) => <li key={`k-${key.column}`}>按 <code>{key.column}</code> = {formatWritebackValue(key.value)} 定位这一行</li>)}
            {plan.assignments.map((item) => <li key={`a-${item.column}`}>改 <code>{item.column}</code> ← 属性「{item.property}」</li>)}
          </ul>
        </div>
      ))}
      {report.executions.map((execution) => (
        <div className="as-writeback-row" key={`exec-${execution.table}-${execution.statement}`}>
          <b>{execution.entityType}</b>
          <span className="as-writeback-table">{execution.table}{execution.dataSourceName ? ` · ${execution.dataSourceName}` : ""}</span>
          <ul>
            {execution.written.map((item) => (
              <li key={`w-${item.column}`}><code>{item.column}</code>：{formatWritebackValue(item.from)} → {formatWritebackValue(item.to)}</li>
            ))}
          </ul>
          <pre className="as-writeback-sql">{execution.statement}</pre>
        </div>
      ))}
      {report.refusals.map((refusal) => (
        <div className="as-writeback-row refused" key={`refusal-${refusal.nodeId}`}>
          <b><AlertTriangle size={12} />{refusal.entityType} 写不回去</b>
          <p>{refusal.reason}</p>
          {refusal.hint && <p className="as-writeback-hint">→ {refusal.hint}</p>}
        </div>
      ))}
      {report.skipped.map((item) => (
        <div className="as-writeback-row muted" key={`skip-${item.nodeId}`}>
          <b>{item.entityType}</b>
          <p>{item.reason}</p>
        </div>
      ))}
    </div>
  );
}

/** 有一处写不回就是一个都没写：这里不是"报错"，是"整批没动，改完再来" —— 语气和内容都要说清。 */
export function WritebackRefusedPanel({ failure }: { failure: { message: string; writeback?: WritebackReport } }) {
  return (
    <div className="as-outcome blocked">
      <div className="as-verdict">
        <AlertTriangle size={16} />
        <b>{failure.message}</b>
        <span>业务库和草稿快照都保持原样，按下面的提示改完再执行一次就行。</span>
      </div>
      <WritebackPanel report={failure.writeback} />
    </div>
  );
}

function Finding({ finding, level }: { finding: ActionFinding; level: "blocker" | "warning" }) {
  return (
    <div className={`as-finding ${level}`}>
      <b>{level === "blocker" ? <ShieldAlert size={12} /> : <AlertTriangle size={12} />}{finding.ruleName}<span className="as-chip muted">{effectLabel(finding.effect)}</span></b>
      {finding.message && <p>{finding.message}</p>}
      {finding.evidence.length > 0 && <ul className="as-evidence">{finding.evidence.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>}
    </div>
  );
}

/** 引用一个对象：可以是动作入参，也可以是本动作前面新建出来的对象。 */
