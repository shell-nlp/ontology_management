"use client";

import { useState } from "react";
import { BarChart3, Pencil, Plus, Trash2, X } from "lucide-react";
import { newId } from "@/lib/shared/common/ids";
import { useSplitPane } from "@/components/split-pane";
import type { Definition, Metric } from "@/lib/ontology/draft";
import "./metric-manager.css";

/**
 * 指标（业务口径）的配置区 —— 「本体建模」页的一级标签之一。
 *
 * 一条指标是**两件事**：
 * 1. **关联**：这个指标和哪些对象类型有关（可以多个）—— 决定它出现在哪些类型的上下文里；
 * 2. **怎么算**：挑一个关联类型作为计算落点，配上聚合方式 / 过滤 / 维度 —— **可以不配**。
 *
 * 不配计算口径 = 「只描述、不算数」：合法形态，模型能讲清这个口径是什么，
 * 但**不能拿它出数**（查询会报 METRIC_NOT_CALCULABLE）。让它出数等于放模型去猜口径，
 * 那正是指标要消灭的东西，所以这一页把"能不能出数"当结论摆在最下面。
 *
 * 左栏清单、右栏编辑器；改动先落在右栏草稿，点「保存指标」才写进定义（与概念分组同一套路）。
 * 指错了（计算落点不在关联里、属性 / 维度不存在）在发布前被 `@/lib/ontology/metrics` 挡住。
 */
type Props = {
  definition: Definition;
  canEdit: boolean;
  save: (next: Definition) => Promise<void>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

type Calculation = NonNullable<Metric["calculation"]>;

export const AGGREGATION_OPTIONS = [
  { value: "COUNT", label: "行数 / 计数", hint: "COUNT：不选属性就是数行数" },
  { value: "SUM", label: "求和", hint: "SUM：把属性的值加起来" },
  { value: "COUNT_DISTINCT", label: "去重计数", hint: "COUNT(DISTINCT)：数有多少个不同的取值" },
  { value: "AVG", label: "平均", hint: "AVG" },
  { value: "MIN", label: "最小", hint: "MIN" },
  { value: "MAX", label: "最大", hint: "MAX" },
] as const;

export const FILTER_OPERATORS = [
  { value: "EQ", label: "=" },
  { value: "NE", label: "≠" },
  { value: "GT", label: ">" },
  { value: "GTE", label: "≥" },
  { value: "LT", label: "<" },
  { value: "LTE", label: "≤" },
  { value: "IN", label: "属于（逗号分隔）" },
  { value: "NOT_IN", label: "不属于" },
  { value: "CONTAINS", label: "包含" },
  { value: "IS_NULL", label: "为空" },
  { value: "NOT_NULL", label: "非空" },
] as const;

function aggregationLabel(value: string) {
  return AGGREGATION_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

function newMetric(): Metric {
  return {
    id: newId(),
    name: "新指标",
    description: "",
    // 新指标先"只描述"：先让人把口径写清楚，再决定要不要配算法（也避免默认 COUNT 被当成真口径）。
    entityTypeIds: [],
    calculation: null,
    unitType: "",
    unit: "",
    // 新指标一律先落 draft：没验收过的口径不该被模型当成现成口径直接用。
    status: "draft",
    owner: "",
    tags: [],
  } as Metric;
}

/** 「这条指标怎么表达」统一在一处算：清单、结论条、算式都读它，避免三处各写一套判断。 */
function described(definition: Definition, metric: Metric) {
  const calculation = metric.calculation ?? null;
  const calcType = calculation?.entityTypeId ? definition.entityTypes.find((item) => item.id === calculation.entityTypeId) ?? null : null;
  const related = (metric.entityTypeIds ?? [])
    .map((id) => definition.entityTypes.find((item) => item.id === id) ?? null)
    .filter((item): item is Definition["entityTypes"][number] => Boolean(item));
  const computable = Boolean(calculation && calcType);
  const expression = !calculation
    ? "只描述，不算数"
    : !calcType
      ? `计算落点已失效（${aggregationLabel(calculation.aggregation)}）`
      : calculation.property
        ? `${calculation.aggregation}(${calcType.name}.${calculation.property})`
        : `${calculation.aggregation}(${calcType.name})`;
  return { calculation, calcType, related, computable, expression };
}

export function MetricManager({ definition, canEdit, save, notify, fail }: Props) {
  const metrics = definition.metrics;
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Metric | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = metrics.find((item) => item.id === selectedId) ?? null;
  // 选中的指标换了就在渲染期重装草稿：用 effect 会多一次渲染，还可能把用户正在打的字覆盖掉。
  if (selected && draft?.id !== selected.id) setDraft({ ...selected });
  const current = selected && draft?.id === selected.id ? draft : null;
  const dirty = current && selected ? JSON.stringify(current) !== JSON.stringify(selected) : false;
  const view = current ? described(definition, current) : null;
  // 计算落点上的属性才是"可聚合 / 可分组"的那批；没挑落点就没有候选。
  const calcProperties = view?.calcType?.properties.map((item) => item.name) ?? [];

  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey: "metric-split",
    defaultWidth: 320,
    minLeft: 260,
    minDetail: 460,
    maxLeft: 620,
    label: "拖动调整指标清单宽度，双击恢复默认",
  });

  const patch = (partial: Partial<Metric>) => setDraft((state) => (state ? { ...state, ...partial } : state));
  const patchCalculation = (partial: Partial<Calculation>) =>
    setDraft((state) => (state && state.calculation ? { ...state, calculation: { ...state.calculation, ...partial } } : state));

  const commit = async (next: Definition, message: string) => {
    setBusy(true);
    try {
      await save(next);
      notify(message);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const addMetric = () => {
    let name = "新指标";
    let index = 2;
    while (metrics.some((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())) { name = `新指标 ${index}`; index += 1; }
    const metric = { ...newMetric(), name };
    setSelectedId(metric.id);
    void commit({ ...definition, metrics: [...metrics, metric] }, "已新建指标，填好口径后保存。");
  };

  const saveDraft = () => {
    if (!selected || !current) return;
    const name = current.name.trim();
    if (!name) { fail(new Error("指标名称不能为空。")); return; }
    if (metrics.some((item) => item.id !== selected.id && item.name.trim().toLowerCase() === name.toLowerCase())) {
      fail(new Error(`已经有叫「${name}」的指标了。`));
      return;
    }
    void commit({ ...definition, metrics: metrics.map((item) => (item.id === selected.id ? { ...current, name } : item)) }, `指标「${name}」已保存到草稿。`);
  };

  const removeMetric = () => {
    if (!selected) return;
    if (!window.confirm(`删除指标「${selected.name}」？模型以后就看不到这条口径了，绑定的数据本身不受影响。`)) return;
    setSelectedId("");
    void commit({ ...definition, metrics: metrics.filter((item) => item.id !== selected.id) }, "指标已从草稿删除。");
  };

  /** 关联一个对象类型。 */
  const relate = (id: string) => {
    if (!current || !id || current.entityTypeIds.includes(id)) return;
    patch({ entityTypeIds: [...current.entityTypeIds, id] });
  };

  /**
   * 取消关联。**如果它正好是计算落点**，只把落点清空、算法留着（不静默删算法）——
   * 界面据此提示"重新挑一个落点或改成只描述"，发布校验里也只是一条 WARN。
   */
  const unrelate = (id: string) => {
    if (!current) return;
    const nextIds = current.entityTypeIds.filter((item) => item !== id);
    const calculation = current.calculation && current.calculation.entityTypeId === id
      ? { ...current.calculation, entityTypeId: "" }
      : current.calculation;
    patch({ entityTypeIds: nextIds, calculation });
  };

  /** 换计算落点：属性 / 维度 / 过滤都是那个类型上的，跟着重置；聚合方式保留。 */
  const pickCalcType = (id: string) => {
    if (!current) return;
    const existing = current.calculation;
    if (existing && existing.entityTypeId === id) return;
    patch({
      calculation: {
        entityTypeId: id,
        aggregation: existing?.aggregation ?? "COUNT",
        property: "",
        filters: [],
        dimensions: [],
        timeProperty: "",
      },
    });
  };

  const toggleDimension = (property: string) => {
    if (!current?.calculation) return;
    const has = current.calculation.dimensions.includes(property);
    patchCalculation({ dimensions: has ? current.calculation.dimensions.filter((item) => item !== property) : [...current.calculation.dimensions, property] });
  };

  return <section className="manager-grid metric-grid" ref={containerRef} style={containerStyle}>
    <div className="panel functional-panel mm-rail">
      <span className="eyebrow">指标</span>
      <h2>{metrics.length} 个指标</h2>
      <p className="mm-rail-note">指标是业务口径。先说清<b>和谁有关</b>，再说<b>怎么算</b> —— 怎么算可以留空，那就只描述、不出数。</p>
      <div className="mm-rail-actions">
        <button className="action compact" disabled={!canEdit || busy} onClick={addMetric}><Plus size={14} />新建指标</button>
        <p>只描述怎么算，不产生数据。</p>
      </div>
      <div className="mm-rows">
        {metrics.map((metric) => {
          const info = described(definition, metric);
          const calcName = info.calcType?.name ?? "";
          return <button key={metric.id} className={selectedId === metric.id ? "mm-row selected" : "mm-row"} onClick={() => setSelectedId(metric.id)}>
            <span className={info.computable ? "mm-lamp" : "mm-lamp hold"} aria-hidden="true" />
            <span>
              <b>{metric.name}</b>
              <small>{info.expression}</small>
              <em>{info.related.length ? `关联 ${info.related.length} 个类型` : "还没关联对象类型"}{info.computable && calcName ? ` · 算在「${calcName}」` : ""}</em>
            </span>
          </button>;
        })}
        {!metrics.length && <p className="mm-empty">还没有指标。把常用的口径固化下来（互联网专线条数、短彩信欠费金额…），问答就不用每次重新推口径。</p>}
      </div>
    </div>
    <div {...handleProps}><span aria-hidden="true" /></div>
    <div className="panel functional-panel mm-sheet">
      {selected && current && view ? <>
        <div className="mm-sheet-body">
        <div className="mm-sheet-head">
          <span className="eyebrow">指标定义</span>
          <div className="mm-title-row">
            <input aria-label="指标名称" disabled={!canEdit} placeholder="例如：互联网专线条数" value={current.name} onChange={(event) => patch({ name: event.target.value })} />
            <em className={current.status === "verified" ? "mm-pill verified" : "mm-pill draft"}>{current.status === "verified" ? "已验收" : "草稿"}</em>
            {dirty && <em className="mm-pill dirty">未保存</em>}
          </div>
          <textarea className="mm-desc" rows={2} disabled={!canEdit} placeholder="这个指标量的是什么、边界在哪" value={current.description} onChange={(event) => patch({ description: event.target.value })} />
          {/* 口径元信息：与「怎么算」无关，所以常驻在这里 —— 只描述、不算数的指标也要能改它。 */}
          <div className="mm-meta">
            <div className="mm-meta-head"><b>口径元信息</b><span>和「怎么算」无关，有没有配计算口径都能改</span></div>
            <div className="mm-form">
              <label className="mm-field"><span>单位</span><input disabled={!canEdit} placeholder="条 / 元 / MB / 分" value={current.unit ?? ""} onChange={(event) => patch({ unit: event.target.value })} /></label>
              <label className="mm-field"><span>状态</span>
                <select disabled={!canEdit} value={current.status ?? "draft"} onChange={(event) => patch({ status: event.target.value as Metric["status"] })}>
                  <option value="draft">草稿（还没验收）</option>
                  <option value="verified">已验收（模型可直接引用）</option>
                </select>
              </label>
              <label className="mm-field"><span>负责人（可选）</span><input disabled={!canEdit} placeholder="例如：市场部数据组" value={current.owner ?? ""} onChange={(event) => patch({ owner: event.target.value })} /></label>
            </div>
            <p className="mm-hint">状态管的是「这条口径验收没有」：<b>草稿照样能出数</b>，模型引用它出数时会附一句「尚未验收」；标成已验收表示可以当成可信口径直接用。</p>
          </div>
        </div>

        <div className="mm-step">
          <div className="mm-step-head">
            <span className="mm-step-no">1</span>
            <b>关联的对象类型</b>
            <span>这个指标和谁有关（可以多个）</span>
            <em>{view.related.length} 个</em>
          </div>
          <div className="mm-roster">
            {view.related.map((type) => {
              const isCalc = current.calculation?.entityTypeId === type.id;
              return <div className={isCalc ? "mm-rel is-calc" : "mm-rel"} key={type.id}>
                <b>{type.name}</b>
                {isCalc ? <span className="mm-tag">计算落点</span> : <s>仅关联</s>}
                <button type="button" className="mm-x" title={`取消关联 ${type.name}`} disabled={!canEdit} onClick={() => unrelate(type.id)}><X size={13} /></button>
              </div>;
            })}
            {!view.related.length && <p className="mm-empty">还没关联任何对象类型 —— 先选一个，才知道这条指标说的是谁。</p>}
          </div>
          <select className="mm-add-rel" disabled={!canEdit} value="" onChange={(event) => { relate(event.target.value); event.target.value = ""; }}>
            <option value="">＋ 关联一个对象类型</option>
            {definition.entityTypes.filter((type) => !current.entityTypeIds.includes(type.id)).map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
          <p className="mm-hint">关联决定「这条指标出现在哪些类型的上下文里」（问答、检索、对象类型详情页都按它归类）。<b>关联不等于能算</b> —— 能不能出数看第 2 步。</p>
        </div>

        <div className="mm-step">
          <div className="mm-step-head">
            <span className="mm-step-no">2</span>
            <b>怎么算</b>
            <span>挑一个关联类型作为计算落点；不挑就是「只描述、不算数」</span>
            <em>{view.computable ? `算在「${view.calcType!.name}」` : current.calculation ? "落点待选" : "未配置"}</em>
          </div>
          <div className="mm-pick">
            {view.related.map((type) => <button type="button" key={type.id} disabled={!canEdit} className={current.calculation?.entityTypeId === type.id ? "mm-opt on" : "mm-opt"} onClick={() => pickCalcType(type.id)}><i />{type.name}</button>)}
            <button type="button" disabled={!canEdit} className={current.calculation ? "mm-opt" : "mm-opt on"} onClick={() => patch({ calculation: null })}><i />只描述、不算数</button>
          </div>

          {current.calculation && !view.calcType && <p className="mm-warn">计算落点不在关联里了（可能刚取消了那个类型的关联）—— 在上面重新挑一个，或者改成「只描述、不算数」。算法本身还留着。</p>}

          {current.calculation && view.calcType && <>
            <div className="mm-form" style={{ marginTop: 11 }}>
              <label className="mm-field"><span>聚合方式</span>
                <select disabled={!canEdit} value={current.calculation.aggregation} onChange={(event) => patchCalculation({ aggregation: event.target.value as Calculation["aggregation"] })}>
                  {AGGREGATION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="mm-field"><span>聚合属性{current.calculation.aggregation === "COUNT" ? "（留空 = 数行数）" : ""}</span>
                <select disabled={!canEdit} value={current.calculation.property} onChange={(event) => patchCalculation({ property: event.target.value })}>
                  <option value="">{current.calculation.aggregation === "COUNT" ? "不选（数行数）" : "选择属性"}</option>
                  {calcProperties.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label className="mm-field"><span>时间维度（按它看趋势）</span>
                <select disabled={!canEdit} value={current.calculation.timeProperty} onChange={(event) => patchCalculation({ timeProperty: event.target.value })}>
                  <option value="">不用时间维度</option>
                  {calcProperties.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            </div>

            <p className="mm-hint" style={{ marginTop: 10 }}>可用维度（模型能按这些属性分组看；<b>勾了时间维度就自动算一个维度</b>）</p>
            <div className="mm-chips">
              {calcProperties.map((name) => {
                const picked = current.calculation!.dimensions.includes(name);
                const isTime = current.calculation!.timeProperty === name;
                return <button key={name} type="button" disabled={!canEdit || isTime} className={picked || isTime ? "mm-chip on" : "mm-chip"} onClick={() => toggleDimension(name)}>{name}{isTime ? " · 时间" : ""}</button>;
              })}
              {!calcProperties.length && <p className="mm-empty">这个对象类型还没有属性。</p>}
            </div>

            <p className="mm-hint" style={{ marginTop: 10 }}>口径过滤（这个数只算满足这些条件的行）</p>
            <div className="mm-filters">
              {current.calculation.filters.map((filter, index) => (
                <div className="mm-filter-row" key={`${filter.property}-${index}`}>
                  <select disabled={!canEdit} value={filter.property} onChange={(event) => patchCalculation({ filters: current.calculation!.filters.map((item, i) => (i === index ? { ...item, property: event.target.value } : item)) })}>
                    <option value="">选择属性</option>
                    {calcProperties.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  <select disabled={!canEdit} value={filter.operator} onChange={(event) => patchCalculation({ filters: current.calculation!.filters.map((item, i) => (i === index ? { ...item, operator: event.target.value as Calculation["filters"][number]["operator"] } : item)) })}>
                    {FILTER_OPERATORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                  <input disabled={!canEdit || filter.operator === "IS_NULL" || filter.operator === "NOT_NULL"} placeholder="值" value={filter.value} onChange={(event) => patchCalculation({ filters: current.calculation!.filters.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)) })} />
                  <button type="button" className="mm-icon" disabled={!canEdit} title="删除这条过滤" onClick={() => patchCalculation({ filters: current.calculation!.filters.filter((_, i) => i !== index) })}><X size={13} /></button>
                </div>
              ))}
              <button type="button" className="action compact" disabled={!canEdit} onClick={() => patchCalculation({ filters: [...current.calculation!.filters, { property: calcProperties[0] ?? "", operator: "EQ", value: "" }] })}><Plus size={13} />加一条过滤</button>
              {!current.calculation.filters.length && <p className="mm-hint">没加过滤 = 全部行都算。像「只看互联网专线」「排除红冲」这类边界就写在这里。</p>}
            </div>
          </>}

          {!current.calculation && <p className="mm-hint">这条指标现在只有描述，<b>模型能讲清它是什么，但拿不到数</b>。要用它出数，就在上面挑一个类型并选好聚合方式。</p>}
        </div>

        </div>

        <div className={view.computable ? "mm-readout" : "mm-readout hold"}>
          <div>
            <div className="mm-readout-state">
              <span className="mm-lamp" aria-hidden="true" />
              <b>{view.computable ? "能出数" : "不可出数"}</b>
              <span>{view.computable
                ? `模型可以在「${view.calcType!.name}」上引用它出数`
                : current.calculation ? "算法在、落点没定 —— 先挑一个关联类型" : "只描述口径：能讲清是什么，但要数就得另写聚合（会提示未引用已定义指标）"}</span>
            </div>
            <div className={view.computable ? "mm-expr" : "mm-expr hold"}>{view.expression}</div>
          </div>
          <div className="mm-readout-acts">
            <button className="action danger" disabled={!canEdit || busy} onClick={removeMetric}><Trash2 size={15} />删除指标</button>
            <button className="action primary" disabled={!canEdit || busy || !dirty} onClick={saveDraft}><Pencil size={15} />{busy ? "保存中…" : "保存指标"}</button>
          </div>
        </div>
      </> : <div className="mm-blank">
        <BarChart3 size={20} />
        <b>{metrics.length ? "选择一个指标" : "先建一个指标"}</b>
        <span>{metrics.length ? "左边挑一个指标，这里改它的口径：关联哪些对象类型、算在哪儿、怎么算。" : "把常用的业务口径固化下来，模型答统计类问题时就有统一依据。"}</span>
      </div>}
    </div>
  </section>;
}
