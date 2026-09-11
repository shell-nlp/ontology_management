"use client";

import { useState, type FormEvent } from "react";
import { CheckCircle2, CircleDot, Link2, Pencil, Plus, TableProperties, Trash2, X } from "lucide-react";
import { propertyTypeOptions, type EntityType, type Property, type RelationType } from "@/lib/ontology-draft";

export type TypeEditPayload = {
  name: string;
  description?: string;
  displayProperty?: string;
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  properties: Property[];
};

type Props = {
  kind: "entity" | "relation";
  mode?: "create" | "edit";
  entity?: EntityType | null;
  relation?: RelationType | null;
  entityTypes: EntityType[];
  onClose: () => void;
  onSave: (payload: TypeEditPayload) => Promise<void>;
};

/**
 * 对象类型 / 关系类型的完整编辑面板：名称、端点契约、以及全部属性规则。
 * 表单模式和可视化模式共用同一个面板，两种入口写出来的草稿结构完全一致。
 */
export function TypeEditDialog({ kind, mode = "edit", entity, relation, entityTypes, onClose, onSave }: Props) {
  const [name, setName] = useState(kind === "entity" ? entity?.name ?? "" : relation?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [displayProperty, setDisplayProperty] = useState(kind === "entity" ? entity?.displayProperty ?? "" : "");
  const [source, setSource] = useState(relation?.sourceEntityTypeId ?? "");
  const [target, setTarget] = useState(relation?.targetEntityTypeId ?? "");
  const [properties, setProperties] = useState<Property[]>(kind === "entity" ? entity?.properties ?? [] : relation?.properties ?? []);
  const [propName, setPropName] = useState("");
  const [dataType, setDataType] = useState<Property["dataType"]>("TEXT");
  const [required, setRequired] = useState(false);
  const [editingProp, setEditingProp] = useState<number | null>(null);
  const [propDraft, setPropDraft] = useState<Property | null>(null);
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);

  const addProperty = () => {
    try {
      const trimmed = propName.trim();
      if (!trimmed) throw new Error("请填写属性名称。");
      if (properties.some((item) => item.name === trimmed)) throw new Error("属性名称已存在。");
      const prop: Property = { name: trimmed, dataType, required, unique: false, indexed: false };
      setProperties((current) => [...current, prop]);
      setPropName("");
      setLocalError("");
    } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "添加属性失败。"); }
  };
  const startEditProperty = (index: number) => { setEditingProp(index); setPropDraft({ ...properties[index] }); setLocalError(""); };
  const saveProperty = () => {
    try {
      const draft = propDraft;
      if (!draft) return;
      const trimmed = draft.name.trim();
      if (!trimmed) throw new Error("请填写属性名称。");
      if (properties.some((item, i) => i !== editingProp && item.name === trimmed)) throw new Error("属性名称已存在。");
      setProperties((current) => current.map((item, i) => i === editingProp ? { ...draft, name: trimmed } : item));
      setEditingProp(null);
      setPropDraft(null);
      setLocalError("");
    } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "保存属性失败。"); }
  };
  const removeProperty = (index: number) => {
    const removed = properties[index];
    setProperties((current) => current.filter((_, i) => i !== index));
    if (removed && displayProperty === removed.name) setDisplayProperty("");
    if (editingProp === index) { setEditingProp(null); setPropDraft(null); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave(kind === "entity" ? { name, description, displayProperty, properties } : { name, sourceEntityTypeId: source, targetEntityTypeId: target, properties });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const noun = kind === "entity" ? "对象类型" : "关系类型";
  const title = mode === "create" ? `新建${noun}` : `编辑${noun}`;
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog type-dialog" onSubmit={submit}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon">{kind === "entity" ? <CircleDot size={22} /> : <Link2 size={22} />}</div>
        <span className="eyebrow">{kind === "entity" ? "对象类型" : "关系契约"}</span>
        <h2>{title}</h2>
        <label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "entity" ? "例如：客户" : "例如：负责"} required /></label>
        {kind === "entity" ? (
          <>
            <label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label>
            <label>
              显示属性
              <select value={displayProperty} onChange={(event) => setDisplayProperty(event.target.value)}>
                <option value="">默认（按 name/名称/title/id 自动选择）</option>
                {properties.map((prop) => <option key={prop.name} value={prop.name}>{prop.name}</option>)}
              </select>
              <small>节点在可视化中的标题；在本体草稿页「复制显示样式」可导出对应 Neo4j Browser caption 规则。</small>
            </label>
          </>
        ) : (
          <>
            <label>起始对象类型<select value={source} onChange={(event) => setSource(event.target.value)} required><option value="">选择类型</option>{entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
            <label>终止对象类型<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">选择类型</option>{entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          </>
        )}
        <div className="dialog-divider" />
        <div className="dialog-section-head"><span className="eyebrow">属性配置</span><h3>{kind === "entity" ? "对象属性" : "关系属性"}</h3></div>
        <p className="dialog-hint">在同一处维护该类型全部属性，保存时一并写入草稿。</p>
        {properties.length > 0 && (
          <div className="dialog-prop-list">
            {properties.map((prop, index) => editingProp === index && propDraft ? (
              <div className="dialog-prop-row editing" key={`${prop.name}-${index}`}>
                <input value={propDraft.name} onChange={(event) => setPropDraft({ ...propDraft, name: event.target.value })} />
                <select value={propDraft.dataType} onChange={(event) => setPropDraft({ ...propDraft, dataType: event.target.value as Property["dataType"] })}>{propertyTypeOptions.map((item) => <option key={item}>{item}</option>)}</select>
                <label className="check-label"><input type="checkbox" checked={propDraft.required} onChange={(event) => setPropDraft({ ...propDraft, required: event.target.checked })} />必填</label>
                <button type="button" className="action compact" onClick={saveProperty}><CheckCircle2 size={13} />保存</button>
                <button type="button" className="action compact" onClick={() => { setEditingProp(null); setPropDraft(null); setLocalError(""); }}>取消</button>
              </div>
            ) : (
              <div className="dialog-prop-row" key={`${prop.name}-${index}`}>
                <TableProperties size={15} /><b>{prop.name}</b><span>{prop.dataType}</span><em>{prop.required ? "必填" : "可选"}</em>
                <button type="button" className="action compact" onClick={() => startEditProperty(index)}><Pencil size={12} />编辑</button>
                <button type="button" className="action compact danger" onClick={() => removeProperty(index)}><Trash2 size={12} />删除</button>
              </div>
            ))}
          </div>
        )}
        {/* 外层已经是表单，这里只能是 div：套 form 会触发 hydration 报错，回车改为直接提交这一行。 */}
        <div className="inline-form dialog-prop-add">
          <input value={propName} onChange={(event) => setPropName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addProperty(); } }} placeholder="新属性名称" />
          <select value={dataType} onChange={(event) => setDataType(event.target.value as Property["dataType"])}>{propertyTypeOptions.map((item) => <option key={item}>{item}</option>)}</select>
          <label className="check-label"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />必填</label>
          <button type="button" className="action primary" onClick={addProperty}><Plus size={14} />添加属性</button>
        </div>
        {localError && <p className="dialog-error">{localError}</p>}
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy}>{busy ? "保存中…" : mode === "create" ? "加入草稿" : "保存修改"}</button>
        </div>
      </form>
    </div>
  );
}
