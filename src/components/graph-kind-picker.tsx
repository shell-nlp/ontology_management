"use client";

import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { GRAPH_TARGET_KINDS, PLANNED_GRAPH_TARGETS, graphTargetKindInfo, type GraphTargetKind, type GraphTargetMark } from "@/lib/graph/types";

/**
 * 图数据库引擎标记。
 * 每个图形都来自该引擎自己的数据模型，而不是通用的数据库图标：
 * 属性图是「节点 + 卫星点」，RDF 是闭合的主谓宾，无向网格是 NetworkX，分片是 Elasticsearch。
 */
export function GraphKindMark({ mark, accent, size = 24, className }: { mark: GraphTargetMark; accent: string; size?: number; className?: string }) {
  const stroke = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: accent, strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true };
  if (mark === "triple") {
    return <svg {...stroke}><circle cx="12" cy="4.9" r="2" /><circle cx="5.6" cy="18.6" r="2" /><circle cx="18.4" cy="18.6" r="2" /><path d="M10.6 6.6 7 16.6M13.4 6.6 17 16.6M7.7 18.6h8.6" /></svg>;
  }
  if (mark === "mesh") {
    return <svg {...stroke}><circle cx="5" cy="6.4" r="1.9" /><circle cx="18.9" cy="6.9" r="1.9" /><circle cx="7.4" cy="18.2" r="1.9" /><circle cx="17.6" cy="17.4" r="1.9" /><path d="M6.9 7 17 7.1M6.1 8.2l1.1 8.1M9.3 17.9l6.4-.4M18.4 8.7l-.7 6.8M9 16.9 6.3 8.3" /></svg>;
  }
  if (mark === "shards") {
    return <svg {...stroke}><rect x="3.8" y="5" width="16.4" height="3.7" rx="1.5" /><rect x="3.8" y="10.2" width="16.4" height="3.7" rx="1.5" /><rect x="3.8" y="15.4" width="16.4" height="3.7" rx="1.5" /></svg>;
  }
  return <svg {...stroke}><circle cx="12" cy="12" r="3.3" fill={accent} stroke="none" /><circle cx="4.8" cy="6.2" r="1.8" /><circle cx="19.2" cy="6.8" r="1.8" /><circle cx="12" cy="20.2" r="1.8" /><path d="M9.4 9.9 6.4 7.5M14.6 10.1l3-2.5M12 15.4v3" /></svg>;
}

/** 已登记目标分组抬头用的类型徽标。 */
export function GraphKindBadge({ kind }: { kind: GraphTargetKind }) {
  const info = graphTargetKindInfo(kind);
  return <span className="target-kind-badge" style={{ color: info.accent, borderColor: `${info.accent}33`, background: `${info.accent}0f` }}>
    <GraphKindMark mark={info.mark} accent={info.accent} size={13} />
    {info.label}
    <em>{capabilityLine(info)}</em>
  </span>;
}

/** 卡片上的能力行：数据模型 + 查询语言，两者都决定后续怎么用。 */
export function capabilityLine(info: { modelLabel: string; queryLanguageLabel: string }) {
  return `${info.modelLabel} · ${info.queryLanguageLabel}`;
}

/**
 * 类型选择面板：左侧分类 + 右侧引擎卡片。
 * 只负责“选哪个引擎”，提交动作由外层决定——这样它能同时用在两步向导和编辑弹窗里。
 */
export function GraphKindChoice({ value, onChange }: { value: GraphTargetKind; onChange: (kind: GraphTargetKind) => void }) {
  const [category, setCategory] = useState<"supported" | "planned">("supported");
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 只有引擎多到看不完时才给搜索框；四个选项配搜索框是装饰。
  const searchable = GRAPH_TARGET_KINDS.length + PLANNED_GRAPH_TARGETS.length > 6;
  const needle = filter.trim().toLowerCase();
  const supported = useMemo(() => GRAPH_TARGET_KINDS.filter((item) => !needle || `${item.label} ${item.description} ${item.queryLanguageLabel}`.toLowerCase().includes(needle)), [needle]);
  const planned = useMemo(() => PLANNED_GRAPH_TARGETS.filter((item) => !needle || `${item.label} ${item.description}`.toLowerCase().includes(needle)), [needle]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const cards = [...(bodyRef.current?.querySelectorAll<HTMLButtonElement>("[data-kind-card]:not([disabled])") ?? [])];
    const index = cards.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    cards[(index + step + cards.length) % cards.length]?.focus();
  };

  return <div className="kind-picker" ref={bodyRef} onKeyDown={moveFocus}>
    {searchable && <label className="kind-search"><Search size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索图数据库类型" /></label>}
    <div className="kind-picker-body">
      <nav className="kind-picker-rail" aria-label="类型分类">
        <button type="button" className={category === "supported" ? "active" : ""} onClick={() => setCategory("supported")}>已支持<span>{GRAPH_TARGET_KINDS.length}</span></button>
        <button type="button" className={category === "planned" ? "active" : ""} onClick={() => setCategory("planned")}>规划中<span>{PLANNED_GRAPH_TARGETS.length}</span></button>
      </nav>
      <div className="kind-picker-grid" role="radiogroup" aria-label="图数据库类型">
        {category === "supported"
          ? supported.map((item) => <button type="button" key={item.kind} data-kind-card aria-pressed={value === item.kind} className={`kind-card${value === item.kind ? " selected" : ""}`} style={{ "--kind-accent": item.accent } as CSSProperties} onClick={() => onChange(item.kind)}>
              <span className="kind-card-mark"><GraphKindMark mark={item.mark} accent={item.accent} size={26} /></span>
              <b>{item.label}</b>
              <code>{capabilityLine(item)}</code>
              <small>{item.description}</small>
              {value === item.kind && <i className="kind-card-check"><Check size={12} /></i>}
            </button>)
          : planned.map((item) => <button type="button" key={item.key} data-kind-card disabled aria-disabled className="kind-card planned" style={{ "--kind-accent": item.accent } as CSSProperties} title={`${item.label} ${item.note}，暂不支持连接`}>
              <span className="kind-card-mark"><GraphKindMark mark={item.mark} accent={item.accent} size={26} /></span>
              <b>{item.label}</b>
              <code>{item.capability}</code>
              <small>{item.description}</small>
              <i className="kind-card-flag">{item.note}</i>
            </button>)}
        {!supported.length && !planned.length && <p className="kind-picker-empty">没有匹配的引擎。</p>}
      </div>
    </div>
  </div>;
}

/** 紧凑的“更换类型”触发器：编辑连接信息时用。 */
export function GraphKindPicker({ value, onChange }: { value: GraphTargetKind; onChange: (kind: GraphTargetKind) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<GraphTargetKind>(value);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);
  const titleId = useId();
  const info = graphTargetKindInfo(value);
  const draftInfo = graphTargetKindInfo(draft);

  const close = useCallback(() => setOpen(false), []);
  const confirm = () => { onChange(draft); close(); };
  const openPicker = () => { setDraft(value); setOpen(true); };

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) {
        wasOpen.current = false;
        triggerRef.current?.focus();
      }
      return;
    }
    wasOpen.current = true;
    dialogRef.current?.querySelector<HTMLButtonElement>("[data-kind-card]")?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return <>
    <button type="button" ref={triggerRef} className="kind-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={openPicker}>
      <span className="kind-trigger-mark"><GraphKindMark mark={info.mark} accent={info.accent} size={22} /></span>
      <span className="kind-trigger-text"><b>{info.label}</b><code>{capabilityLine(info)}</code></span>
      <ChevronDown size={16} className="kind-trigger-chevron" />
    </button>
    {open && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dialog graph-kind-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <button type="button" className="close-button" onClick={close} title="关闭"><X size={18} /></button>
        <span className="eyebrow">连接目标</span>
        <h2 id={titleId}>选择图数据库类型</h2>
        <p>类型决定这个目标用什么查询语言、按什么模型存图。</p>
        <GraphKindChoice value={draft} onChange={setDraft} />
        <div className="kind-picker-foot">
          <span className="kind-picker-summary"><GraphKindMark mark={draftInfo.mark} accent={draftInfo.accent} size={16} />已选择 <b>{draftInfo.label}</b><code>{capabilityLine(draftInfo)}</code></span>
          <div className="functional-actions"><button type="button" className="quiet-button" onClick={close}>取消</button><button type="button" className="primary-button" onClick={confirm}>确认选择</button></div>
        </div>
      </div>
    </div>}
  </>;
}
