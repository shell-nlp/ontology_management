"use client";

import { useState } from "react";
import { BarChart3, Pencil, Plus, Trash2, X } from "lucide-react";
import { newId } from "@/lib/framework/ids";
import { useSplitPane } from "@/components/split-pane";
import type { Definition, Metric } from "@/lib/ontology/draft";
import "./metric-manager.css";

/**
 * 指标（业务口径）的配置区 —— 「本体建模」页的一级标签之一
 * （可视化建模 · 概念分组 · 对象类型 · 关系类型 · 接口 · **指标**）。
 *
 * 一条指标回答「这个数怎么算」：作用在哪个对象类型上、按哪个属性怎么聚合、
 * 口径过滤是什么（只看互联网专线 / 排除红冲…）、能按哪些维度分组、单位是什么。
 * 它**只描述口径，不是查询结果** —— 出数仍然由模型按这份口径落成只读 SQL。
 *
 * 左栏是清单，右栏是编辑表单；改动先落在右栏草稿里，点「保存指标」才写进草稿定义
 * （与概念分组同一套路：一次性覆盖，避免两次写互相盖掉）。
 * 指向不存在的属性 / 对象类型会在发布前被 `@/lib/metrics` 的检查挡住。
 */
type Props = {
  definition: Definition;
  canEdit: boolean;
  save: (next: Definition) => Promise<void>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

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

function newMetric(entityTypeId: string): Metric {
  return {
    id: newId(),
    name: "新指标",
    description: "",
    entityTypeId,
    aggregation: "COUNT",
    property: "",
    filters: [],
    dimensions: [],
    timeProperty: "",
    unitType: "",
    unit: "",
    // 新指标一律先落 draft：没验收过的口径不该被模型当成现成口径直接用。
    status: "draft",
    owner: "",
    tags: [],
  } as Metric;
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
  const scope = current ? definition.entityTypes.find((item) => item.id === current.entityTypeId) ?? null : null;
  const propertyOptions = scope?.properties.map((item) => item.name) ?? [];
  const dirty = current && selected ? JSON.stringify(current) !== JSON.stringify(selected) : false;

  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey: "metric-split",
    defaultWidth: 320,
    minLeft: 260,
    minDetail: 460,
    maxLeft: 620,
    label: "拖动调整指标清单宽度，双击恢复默认",
  });

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

  const patch = (partial: Partial<Metric>) => setDraft((state) => (state ? { ...state, ...partial } : state));

  /** 换作用对象类型时清掉指向旧类型的选择：留着就是悬空引用，发布前还会被拦一道。 */
  const changeScope = (entityTypeId: string) => patch({ entityTypeId, property: "", filters: [], dimensions: [], timeProperty: "" });

  const addMetric = () => {
    let name = "新指标";
    let index = 2;
    while (metrics.some((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())) { name = `新指标 ${index}`; index += 1; }
    const metric = { ...newMetric(definition.entityTypes[0]?.id ?? ""), name };
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

  const toggleDimension = (property: string) => {
    if (!current) return;
    const has = current.dimensions.includes(property);
    patch({ dimensions: has ? current.dimensions.filter((item) => item !== property) : [...current.dimensions, property] });
  };

  return <section className="manager-grid metric-grid" ref={containerRef} style={containerStyle}>
    <div className="panel functional-panel mm-rail">
      <span className="eyebrow">指标</span>
      <h2>{metrics.length} 个指标</h2>
      <p className="mm-rail-note">指标是业务口径：模型答「这个数怎么算」时按它来，不从列注释里猜。</p>
      <div className="mm-rail-actions">
        <button className="action compact" disabled={!canEdit || busy} onClick={addMetric}><Plus size={14} />新建指标</button>
        <p>只描述怎么算，不产生数据。</p>
      </div>
      <div className="mm-rows">
        {metrics.map((metric) => {
          const scopeName = definition.entityTypes.find((item) => item.id === metric.entityTypeId)?.name ?? "未选类型";
          return <button key={metric.id} className={selectedId === metric.id ? "mm-row selected" : "mm-row"} onClick={() => setSelectedId(metric.id)}>
            <BarChart3 size={13} />
            <span>
              <b>{metric.name}</b>
              <small>{`${metric.aggregation}${metric.property ? `(${metric.property})` : "（行数）"} · ${scopeName} · ${(metric.status ?? "draft") === "verified" ? "已验收" : "草稿"}`}</small>
            </span>
          </button>;
        })}
        {!metrics.length && <p className="mm-empty">还没有指标。把常用的口径固化下来（互联网专线条数、短彩信欠费金额…），问答就不用每次重新推口径。</p>}
      </div>
    </div>
    <div {...handleProps}><span aria-hidden="true" /></div>
    <div className="panel functional-panel mm-sheet">
      {selected && current ? <>
        <div className="mm-sheet-head">
          <span className="eyebrow">指标定义</span>
          <div className="mm-title-row">
            <input aria-label="指标名称" disabled={!canEdit} placeholder="例如：互联网专线条数" value={current.name} onChange={(event) => patch({ name: event.target.value })} />
            {dirty && <em>未保存</em>}
          </div>
          <p className="mm-hint">指标只描述口径。真正出数由模型按这份定义落成只读 SQL（对象类型绑定的表）。</p>
        </div>

        <div className="mm-block">
          <span className="mm-block-label">口径</span>
          <div className="mm-form">
            <label className="mm-field mm-span-2"><span>说明（量的是什么、边界在哪）</span><textarea rows={2} disabled={!canEdit} value={current.description} onChange={(event) => patch({ description: event.target.value })} /></label>
            <label className="mm-field"><span>作用的对象类型</span>
              <select disabled={!canEdit} value={current.entityTypeId} onChange={(event) => changeScope(event.target.value)}>
                <option value="">选择对象类型</option>
                {definition.entityTypes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label className="mm-field"><span>聚合方式</span>
              <select disabled={!canEdit} value={current.aggregation} onChange={(event) => patch({ aggregation: event.target.value as Metric["aggregation"] })}>
                {AGGREGATION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="mm-field"><span>聚合属性{current.aggregation === "COUNT" ? "（留空 = 数行数）" : ""}</span>
              <select disabled={!canEdit || !scope} value={current.property} onChange={(event) => patch({ property: event.target.value })}>
                <option value="">{current.aggregation === "COUNT" ? "不选（数行数）" : "选择属性"}</option>
                {propertyOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="mm-field"><span>单位</span><input disabled={!canEdit} placeholder="条 / 元 / MB / 分" value={current.unit} onChange={(event) => patch({ unit: event.target.value })} /></label>
            <label className="mm-field"><span>状态</span>
              <select disabled={!canEdit} value={current.status ?? "draft"} onChange={(event) => patch({ status: event.target.value as Metric["status"] })}>
                <option value="draft">草稿（还没验收）</option>
                <option value="verified">已验收（模型可直接引用）</option>
              </select>
            </label>
            <label className="mm-field"><span>负责人（可选）</span><input disabled={!canEdit} placeholder="例如：市场部数据组" value={current.owner ?? ""} onChange={(event) => patch({ owner: event.target.value })} /></label>
            <label className="mm-field mm-span-2"><span>时间维度（可选，按它看趋势）</span>
              <select disabled={!canEdit || !scope} value={current.timeProperty} onChange={(event) => patch({ timeProperty: event.target.value })}>
                <option value="">不用时间维度</option>
                {propertyOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
          </div>
        </div>

        <div className="mm-block">
          <span className="mm-block-label">口径过滤（固定条件：这个数只算满足这些条件的行）</span>
          <div className="mm-filters">
            {current.filters.map((filter, index) => (
              <div className="mm-filter-row" key={`${filter.property}-${index}`}>
                <select disabled={!canEdit} value={filter.property} onChange={(event) => patch({ filters: current.filters.map((item, i) => (i === index ? { ...item, property: event.target.value } : item)) })}>
                  <option value="">选择属性</option>
                  {propertyOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <select disabled={!canEdit} value={filter.operator} onChange={(event) => patch({ filters: current.filters.map((item, i) => (i === index ? { ...item, operator: event.target.value as Metric["filters"][number]["operator"] } : item)) })}>
                  {FILTER_OPERATORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                <input disabled={!canEdit || filter.operator === "IS_NULL" || filter.operator === "NOT_NULL"} placeholder="值（再传一次原值即可）" value={filter.value} onChange={(event) => patch({ filters: current.filters.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)) })} />
                <button type="button" className="mm-icon" disabled={!canEdit} title="删除这条过滤" onClick={() => patch({ filters: current.filters.filter((_, i) => i !== index) })}><X size={13} /></button>
              </div>
            ))}
            <button type="button" className="action compact" disabled={!canEdit || !scope} onClick={() => patch({ filters: [...current.filters, { property: propertyOptions[0] ?? "", operator: "EQ", value: "" }] })}><Plus size={13} />加一条过滤</button>
            {!current.filters.length && <p className="mm-hint">没加过滤 = 全部行都算。像「只看互联网专线」「排除红冲」这类边界就写在这里。</p>}
          </div>
        </div>

        <div className="mm-block">
          <span className="mm-block-label">可用维度（模型可以按这些属性分组看）</span>
          <div className="mm-chips">
            {propertyOptions.map((name) => (
              <button key={name} type="button" className={current.dimensions.includes(name) ? "mm-chip checked" : "mm-chip"} disabled={!canEdit} onClick={() => toggleDimension(name)}>{name}</button>
            ))}
            {!propertyOptions.length && <p className="mm-empty">先在上面选一个作用的对象类型，才有属性可选。</p>}
          </div>
        </div>

        <div className="mm-sheet-foot">
          <button className="action danger" disabled={!canEdit || busy} onClick={removeMetric}><Trash2 size={15} />删除指标</button>
          <button className="action primary" disabled={!canEdit || busy || !dirty} onClick={saveDraft}><Pencil size={15} />{busy ? "保存中…" : "保存指标"}</button>
        </div>
      </> : <div className="mm-blank">
        <BarChart3 size={20} />
        <b>{metrics.length ? "选择一个指标" : "先建一个指标"}</b>
        <span>{metrics.length ? "左边挑一个指标，这里改它的口径：聚合方式、过滤条件、维度与单位。" : "把常用的业务口径固化下来，模型答统计类问题时就有统一依据。"}</span>
      </div>}
    </div>
  </section>;
}
