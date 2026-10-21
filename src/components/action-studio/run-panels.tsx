"use client";

import { AlertTriangle, Check, CircleSlash, ShieldAlert } from "lucide-react";
import type { RuleEffect } from "@/lib/ontology/draft";
import "../action-studio.css";

const effectLabel = (effect: RuleEffect) => effect === "BLOCK" ? "拦截" : effect === "WARN" ? "提示" : "隐藏";

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
  /** 兼容尚未升级的服务端响应；新响应总会返回删除清单。 */
  deletedEntities?: { id: string; label: string; display: string }[];
  subject: { id: string; label: string; display: string } | null;
  dryRun: boolean;
  applied: boolean;
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
          <b>新建</b>
          {outcome.createdEntities.map((entity) => <span key={entity.id}>{entity.label} <code>{entity.display}</code></span>)}
        </div>
      )}
      {outcome.deletedEntities?.length ? (
        <div className="as-created deleted">
          <b>删除</b>
          {outcome.deletedEntities.map((entity) => <span key={entity.id}>{entity.label} <code>{entity.display}</code></span>)}
        </div>
      ) : null}
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
