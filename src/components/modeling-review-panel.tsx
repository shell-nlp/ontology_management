"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Wrench } from "lucide-react";
import {
  REVIEW_SCOPE_LABELS,
  reviewOntologyModel,
  summarizeModelingReview,
  type ReviewScope,
} from "@/lib/modeling-review";
import type { Definition } from "@/lib/ontology-draft";

/**
 * 建模体检面板。
 *
 * 它和页头上那个「校验」是两件事：校验管"能不能发布"（拦得住就是拦），这里管"建得好不好"。
 * 所以措辞上刻意不说"错误"：只有「该改」和「可以更好」两档，一条都不挡发布 ——
 * 草稿停在半路是常态，体检要能容忍中间状态，只把值得回头看一眼的地方挑出来。
 *
 * 每条结论都带**规则码**：它是稳定标识，界面与技能文档共用同一份。
 */
export function ModelingReviewPanel({ definition, onLocate }: {
  definition: Definition;
  /** 点结论上的主体跳到对应的标签页（对象类型 / 关系类型 / 接口 / 概念分组 / 动作）。 */
  onLocate: (scope: ReviewScope) => void;
}) {
  const findings = useMemo(() => reviewOntologyModel(definition), [definition]);
  const summary = useMemo(() => summarizeModelingReview(findings), [findings]);
  const [filter, setFilter] = useState<"ALL" | "WARN" | "INFO">("ALL");
  const shown = filter === "ALL" ? findings : findings.filter((item) => item.level === filter);

  return (
    <section className="panel functional-panel review-panel">
      <div className="review-head">
        <div>
          <span className="eyebrow">建模体检</span>
          <h2>{summary.headline}</h2>
        </div>
        <div className="review-filters" role="group" aria-label="按档次筛选">
          <button type="button" className={filter === "ALL" ? "active" : ""} aria-pressed={filter === "ALL"} onClick={() => setFilter("ALL")}>全部 <b>{summary.total}</b></button>
          <button type="button" className={filter === "WARN" ? "active" : ""} aria-pressed={filter === "WARN"} onClick={() => setFilter("WARN")}>该改 <b>{summary.warn}</b></button>
          <button type="button" className={filter === "INFO" ? "active" : ""} aria-pressed={filter === "INFO"} onClick={() => setFilter("INFO")}>可以更好 <b>{summary.info}</b></button>
        </div>
      </div>
      <p className="subtle">
        体检只看<b>定义内部是不是自洽</b>：空壳与孤悬的对象类型、主键列没属性接、必填属性没映射列、命名打架、
        关系端点没选、接口没人实现、规则没条件……它<b>不挡发布</b>（发布前的硬性校验是页头那个「校验」按钮），
        这里全是建议。对象类型绑的表里到底有没有这一列，要拿真实表结构比，属于「数据资源」那侧的活。
      </p>
      {!findings.length ? (
        <p className="review-clean"><CheckCircle2 size={15} />没有发现问题：对象类型、关系类型、接口、概念分组、动作与规则都是自洽的。</p>
      ) : !shown.length ? (
        <p className="empty">这一档没有问题。</p>
      ) : (
        <ul className="review-list">
          {shown.map((item, index) => (
            <li className={item.level === "WARN" ? "review-item warn" : "review-item info"} key={`${item.code}-${item.subjectId}-${index}`}>
              <div className="review-item-head">
                <span className="review-level">{item.level === "WARN" ? <AlertTriangle size={12} /> : <Info size={12} />}{item.level === "WARN" ? "该改" : "可以更好"}</span>
                <code>{item.code}</code>
                {item.subject && (
                  <button type="button" className="review-scope" onClick={() => onLocate(item.scope)} title="去对应的标签页看这一项">
                    {REVIEW_SCOPE_LABELS[item.scope]} · {item.subject}
                  </button>
                )}
              </div>
              <p className="review-issue">{item.message}</p>
              <p className="review-hint"><Wrench size={12} />{item.hint}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}