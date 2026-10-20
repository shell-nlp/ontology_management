"use client";

import { useEffect, useId, useState } from "react";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/shared/client/api-client";
import { newId } from "@/lib/shared/common/ids";
import type { EntityDictionary } from "@/lib/ontology/dictionaries";
import type { DataViewField, DataViewSummary, PublicDataSource } from "@/lib/datasource/types";
import "./entity-dictionary-editor.css";
import "./type-edit-dialog.css";

type Props = {
  value: EntityDictionary[];
  properties: { name: string; displayName?: string }[];
  dataSources: PublicDataSource[];
  onChange: (value: EntityDictionary[]) => void;
};

export function EntityDictionaryEditor({ value, properties, dataSources, onChange }: Props) {
  return <section className="ted-section dictionary-editor" aria-label="配置字典">
    <div className="ted-section-head"><h3><BookOpen size={16} />配置字典 <em>{value.length} 张表</em></h3>
      <button type="button" className="quiet-button" onClick={() => onChange([...value, { id: newId(), name: "", description: "", dataSourceId: "", schema: "", view: "", mappings: [] }])}><Plus size={14} />添加字典</button>
    </div>
    <p className="dictionary-intro">为属性码值补充业务含义。可引用多张字典表，也可先登记表，稍后再配属性映射。</p>
    {!value.length && <div className="dictionary-empty">例如：地区属性参考地市字典，状态属性参考用户状态字典。</div>}
    {value.map((dictionary, index) => <DictionaryCard key={dictionary.id} dictionary={dictionary} properties={properties} dataSources={dataSources}
      onChange={(patch) => onChange(value.map((item, position) => position === index ? { ...item, ...patch } : item))}
      onRemove={() => onChange(value.filter((_, position) => position !== index))} />)}
    {value.length > 0 && <p className="dictionary-footnote">字典引用不自动创建关系类型。共用一张表的多类码值，请先建好按业务域筛选的字典视图，避免同一码值对应多个含义。</p>}
  </section>;
}

function DictionaryCard({ dictionary, properties, dataSources, onChange, onRemove }: {
  dictionary: EntityDictionary;
  properties: Props["properties"];
  dataSources: PublicDataSource[];
  onChange: (patch: Partial<EntityDictionary>) => void;
  onRemove: () => void;
}) {
  const listId = useId();
  const [tables, setTables] = useState<{ resource: string; rows: DataViewSummary[] }>({ resource: "", rows: [] });
  const [columns, setColumns] = useState<{ key: string; rows: DataViewField[] }>({ key: "", rows: [] });
  const [tableError, setTableError] = useState<{ resource: string; message: string } | null>(null);
  const [columnError, setColumnError] = useState<{ key: string; message: string } | null>(null);
  const { dataSourceId, schema, view } = dictionary;
  const fieldKey = JSON.stringify([dataSourceId, schema, view]);
  const tableRows = tables.resource === dataSourceId ? tables.rows : [];
  const fields = columns.key === fieldKey ? columns.rows : [];
  const error = columnError?.key === fieldKey ? columnError.message : tableError?.resource === dataSourceId ? tableError.message : "";

  useEffect(() => {
    if (!dataSourceId) return;
    let cancelled = false;
    void api<{ views: DataViewSummary[] }>(`/api/data-sources/${encodeURIComponent(dataSourceId)}/views?limit=5000`)
      .then((data) => { if (!cancelled) { setTables({ resource: dataSourceId, rows: data.views }); setTableError(null); } })
      .catch((reason) => { if (!cancelled) setTableError({ resource: dataSourceId, message: reason instanceof Error ? reason.message : "读取表清单失败，请检查数据资源权限。" }); });
    return () => { cancelled = true; };
  }, [dataSourceId]);

  useEffect(() => {
    if (!dataSourceId || !view) return;
    let cancelled = false;
    const query = new URLSearchParams({ limit: "1", ...(schema ? { schema } : {}) });
    void api<{ fields: DataViewField[] }>(`/api/data-sources/${encodeURIComponent(dataSourceId)}/views/${encodeURIComponent(view)}?${query}`)
      .then((data) => { if (!cancelled) { setColumns({ key: fieldKey, rows: data.fields }); setColumnError(null); } })
      .catch((reason) => { if (!cancelled) setColumnError({ key: fieldKey, message: reason instanceof Error ? reason.message : "读取列清单失败，可先登记字典表，稍后再配映射。" }); });
    return () => { cancelled = true; };
  }, [dataSourceId, schema, view, fieldKey]);

  const patchMapping = (index: number, patch: Partial<EntityDictionary["mappings"][number]>) => onChange({ mappings: dictionary.mappings.map((item, position) => index === position ? { ...item, ...patch } : item) });
  const ready = dictionary.mappings.length > 0 && dictionary.mappings.every((item) => item.property && item.codeColumn && item.labelColumn);
  const columnSelect = (index: number, key: "codeColumn" | "labelColumn", label: string) => {
    const value = dictionary.mappings[index][key];
    return <label className="ted-field"><span>{label}</span><select aria-label={label} className="ted-select" value={value} onChange={(event) => patchMapping(index, { [key]: event.target.value })}>
      <option value="">选择列</option>
      {value && !fields.some((field) => field.name === value) && <option value={value}>{value}（待核对）</option>}
      {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.comment ? ` · ${field.comment}` : ""}</option>)}
    </select></label>;
  };

  return <article className="dictionary-card">
    <div className="dictionary-card-head"><b>{dictionary.name || "新字典"}</b><span className={ready ? "dictionary-status mapped" : "dictionary-status"}>{ready ? `已配 ${dictionary.mappings.length} 条映射` : dictionary.mappings.length ? "映射待补全" : "仅供参考"}</span><button type="button" className="ted-close" aria-label={`移除字典${dictionary.name}`} onClick={onRemove}><Trash2 size={15} /></button></div>
    <div className="ted-grid-2">
      <label className="ted-field"><span>字典名称</span><input className="ted-input" value={dictionary.name} placeholder="例如：用户状态字典" onChange={(event) => onChange({ name: event.target.value })} /></label>
      <label className="ted-field"><span>数据资源</span><select className="ted-select" value={dataSourceId} onChange={(event) => onChange({ dataSourceId: event.target.value, schema: "", view: "", mappings: [] })}><option value="">选择数据资源</option>
        {dataSourceId && !dataSources.some((item) => item.id === dataSourceId) && <option value={dataSourceId}>原数据资源（不可访问或已删除）</option>}
        {dataSources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="ted-field"><span>模式 / 库</span><input className="ted-input" value={schema} placeholder="留空使用数据资源默认模式" onChange={(event) => onChange({ schema: event.target.value, mappings: [] })} /></label>
      <label className="ted-field"><span>字典表 / 视图</span><input className="ted-input" list={listId} value={view} disabled={!dataSourceId} placeholder="输入或选择字典表" onChange={(event) => {
        const selected = tableRows.filter((item) => item.name === event.target.value && (!schema || item.schema === schema));
        onChange({ view: event.target.value, schema: selected.length === 1 ? selected[0].schema : schema, mappings: [] });
      }} /><datalist id={listId}>{tableRows.filter((item) => !schema || item.schema === schema).map((item) => <option key={`${item.schema}.${item.name}`} value={item.name}>{item.schema}{item.comment ? ` · ${item.comment}` : ""}</option>)}</datalist></label>
    </div>
    <label className="ted-field"><span>用途说明（可选）</span><input className="ted-input" value={dictionary.description} placeholder="说明这张字典解释哪类业务码值" onChange={(event) => onChange({ description: event.target.value })} /></label>
    {error && <p className="dictionary-error" role="alert">{error}</p>}
    <div className="dictionary-mapping-head"><b>属性映射 <small>可选</small></b><button type="button" className="quiet-button" disabled={!properties.length || !view || !dataSourceId} onClick={() => onChange({ mappings: [...dictionary.mappings, { property: "", codeColumn: "", labelColumn: "" }] })}><Plus size={13} />添加映射</button></div>
    {dictionary.mappings.map((mapping, index) => <div className="dictionary-mapping" key={index}>
      <label className="ted-field"><span>对象属性</span><select aria-label="对象属性" className="ted-select" value={mapping.property} onChange={(event) => patchMapping(index, { property: event.target.value })}><option value="">选择属性</option>
        {mapping.property && !properties.some((item) => item.name === mapping.property) && <option value={mapping.property}>{mapping.property}（属性已移除）</option>}
        {properties.map((property) => <option key={property.name} value={property.name}>{property.displayName || property.name}</option>)}</select></label>
      {columnSelect(index, "codeColumn", "码值列")}{columnSelect(index, "labelColumn", "含义列")}
      <button type="button" className="ted-close" aria-label={`移除第${index + 1}条字典映射`} onClick={() => onChange({ mappings: dictionary.mappings.filter((_, position) => position !== index) })}><Trash2 size={14} /></button>
    </div>)}
    {!dictionary.mappings.length && <p className="dictionary-hint">已登记的字典可供问答参考；未配置映射时，不会假定它与某个属性有对应关系。</p>}
  </article>;
}
