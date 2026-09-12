"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, CircleDot, CornerDownRight, Database, KeyRound, Layers, Link2, Pencil, Plus, Table2, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { ancestorsOf, inheritedPropertiesOf, indexNodes, selectableParentsOf, type HierarchyNode } from "@/lib/class-hierarchy";
import type { DataViewField, DataViewSummary, PublicDataSource } from "@/lib/data-source/types";
import { compactGraphLabel, graphColor } from "@/lib/graph-palette";
import {
  emptyEntitySource,
  entitySources,
  newEntitySourceId,
  propertyTypeOptions,
  sourceFieldsKey,
  sourceName,
  sourceRoleLabel,
  validateEntitySources,
  type EntitySource,
  type EntityType,
  type Property,
  type RelationType,
} from "@/lib/ontology-draft";
import "./type-edit-dialog.css";

export type TypeEditPayload = {
  name: string;
  description?: string;
  displayProperty?: string;
  /** 父类 id 列表；只有类带这一项。 */
  parents?: string[];
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  properties: Property[];
  /** 类的数据来源清单，第 0 份是主来源；关系类型不带这一项。 */
  sources?: EntitySource[];
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
 * 类 / 关系类型的定义面板：左栏写契约（身份、端点、数据来源、属性规则），
 * 右栏按画布的真实规则预览——取色用 graphColor(name)，标签用 compactGraphLabel，
 * 所以改一个名字，这里的圆点和画布上的圆点一起换色。
 *
 * 表单模式和可视化模式共用这一个面板，两种入口写出来的草稿结构完全一致。
 */
export function TypeEditDialog({ kind, mode = "edit", entity, relation, entityTypes, onClose, onSave }: Props) {
  const [name, setName] = useState(kind === "entity" ? entity?.name ?? "" : relation?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [displayProperty, setDisplayProperty] = useState(kind === "entity" ? entity?.displayProperty ?? "" : "");
  const [parents, setParents] = useState<string[]>(kind === "entity" ? entity?.parents ?? [] : []);
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
  // 数据来源：只有对象类型有这一块。第 0 份是主来源，其余是按主键补充属性的来源。
  const [dataSources, setDataSources] = useState<PublicDataSource[]>([]);
  const [sourceDrafts, setSourceDrafts] = useState<EntitySource[]>(() => (kind === "entity" ? entitySources(entity) : []));
  const [fieldsBySource, setFieldsBySource] = useState<Record<string, { key: string; fields: DataViewField[] }>>({});
  const reportedFields = useRef<Record<string, { key: string; fields: DataViewField[] }>>({});

  /** 每份来源各读各的结构，读到的字段按来源 id 汇总到这里，属性映射才有列可选。 */
  const rememberFields = useCallback((sourceId: string, key: string, fields: DataViewField[]) => {
    const previous = reportedFields.current[sourceId];
    if (previous?.key === key && previous.fields.length === fields.length && previous.fields.every((field, index) => field.name === fields[index].name)) return;
    reportedFields.current = { ...reportedFields.current, [sourceId]: { key, fields } };
    setFieldsBySource(reportedFields.current);
  }, []);
  /** 某份来源当前的字段：表换了就作废，免得把上一张表的列指到属性上。 */
  const columnsOfSource = (source: EntitySource | undefined) => {
    if (!source) return [];
    const entry = fieldsBySource[source.id];
    return entry && entry.key === sourceFieldsKey(source) ? entry.fields : [];
  };

  const noun = kind === "entity" ? "对象类型" : "关系类型";
  const title = mode === "create" ? `新增${noun}` : `编辑${noun}`;
  const trimmedName = name.trim();
  const named = trimmedName.length > 0;
  const color = graphColor(trimmedName);
  const sourceEntity = entityTypes.find((item) => item.id === source) ?? null;
  const targetEntity = entityTypes.find((item) => item.id === target) ?? null;
  const previewProperties = properties.slice(0, 8);
  const primarySourceId = sourceDrafts[0]?.id ?? "";
  const primaryKeyColumns = sourceDrafts[0]?.primaryKey ?? [];
  /** 提交时的形状：主来源只留真的选中的列，补充来源按主键列数逐位对齐。 */
  const normalizedSources = sourceDrafts.map((item, index) => ({
    ...item,
    view: item.view.trim(),
    primaryKey: index === 0
      ? item.primaryKey.map((column) => column.trim()).filter(Boolean)
      : primaryKeyColumns.map((_, position) => (item.primaryKey[position] ?? "").trim()),
  }));
  const sourceIssues = kind === "entity" ? validateEntitySources({ name: trimmedName || "未命名对象类型", sources: normalizedSources, properties }) : [];
  const mappedCount = properties.filter((property) => property.sourceField).length;

  /**
   * 类层级：父类 → 祖先 → 继承来的属性。
   *
   * 这里把「正在编辑的这一个」本身也放进节点表，所以预览反映的是**还没保存**的改动：
   * 勾上一个父类，右边立刻能看到它带来了哪些属性。全程纯计算——类只有几十个，
   * 随手算，不碰网络也不碰图库。
   */
  // 这几步刻意不 memo：对象类型只有几十个，重算一次比维护一份可能过期的缓存更省心，
  // 而且草稿正处在编辑中，缓存反而容易落后于输入。
  const selfId = entity?.id ?? "__draft__";
  const selfNode: HierarchyNode = { id: selfId, name: trimmedName || "新对象类型", parents, properties };
  const hierarchyNodes: HierarchyNode[] = kind === "entity"
    ? [selfNode, ...entityTypes.filter((item) => item.id !== selfId).map((item) => ({ id: item.id, name: item.name, parents: item.parents, properties: item.properties }))]
    : [];
  const hierarchyById = indexNodes(hierarchyNodes);
  const ancestorNames = ancestorsOf(selfId, hierarchyById).map((id) => hierarchyById.get(id)?.name ?? id);
  const inheritedProperties = inheritedPropertiesOf(selfNode, hierarchyById);
  const parentCandidates = kind === "entity" ? selectableParentsOf(selfNode, hierarchyNodes) : [];
  const toggleParent = (id: string) => setParents((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));

  // 已登记的数据资源：只取一次，用来填下拉。
  useEffect(() => {
    if (kind !== "entity") return;
    let cancelled = false;
    void api<PublicDataSource[]>("/api/data-sources")
      .then((rows) => { if (!cancelled) setDataSources(rows); })
      .catch(() => { if (!cancelled) setDataSources([]); });
    return () => { cancelled = true; };
  }, [kind]);

  // ESC 关闭：用 ref 存回调，避免调用方每次渲染都重新订阅键盘事件。
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

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
  const cancelEditProperty = () => { setEditingProp(null); setPropDraft(null); setLocalError(""); };
  const removeProperty = (index: number) => {
    const removed = properties[index];
    setProperties((current) => current.filter((_, i) => i !== index));
    if (removed && displayProperty === removed.name) setDisplayProperty("");
    if (editingProp === index) cancelEditProperty();
  };

  /** 映射到某一份来源的属性列都作废（换了资源、换了表）。 */
  const clearSourceMappings = (sourceId: string) => {
    setProperties((current) => current.map((property) => ((property.sourceId || primarySourceId) === sourceId ? { ...property, sourceField: "" } : property)));
  };
  /** 换数据资源：表、主键、标题和映射都不再成立，一起清掉。 */
  const pickSourceDataSource = (sourceId: string, dataSourceId: string) => {
    setSourceDrafts((current) => current.map((item, index) => (item.id === sourceId
      ? { ...item, dataSourceId, schema: "", view: "", titleField: "", primaryKey: index === 0 ? [] : primaryKeyColumns.map(() => "") }
      : item)));
    clearSourceMappings(sourceId);
  };
  /** 换表：字段清单会重新拉，主键、标题与映射跟着换。 */
  const pickSourceView = (sourceId: string, view: string, schema: string) => {
    const changed = (sourceDrafts.find((item) => item.id === sourceId)?.view ?? "") !== view;
    setSourceDrafts((current) => current.map((item, index) => {
      if (item.id !== sourceId) return item;
      if (!changed) return { ...item, schema: schema || item.schema };
      return { ...item, view, schema: schema || item.schema, titleField: "", primaryKey: index === 0 ? [] : primaryKeyColumns.map(() => "") };
    }));
    if (changed) clearSourceMappings(sourceId);
  };
  const updateSource = (sourceId: string, patch: Partial<EntitySource>) => {
    setSourceDrafts((current) => current.map((item) => (item.id === sourceId ? { ...item, ...patch } : item)));
  };
  const addSource = () => {
    setSourceDrafts((current) => [...current, { ...emptyEntitySource(newEntitySourceId()), primaryKey: (current[0]?.primaryKey ?? []).map(() => "") }]);
    setLocalError("");
  };
  const removeSource = (sourceId: string) => {
    const fallback = sourceDrafts.find((item) => item.id !== sourceId)?.id ?? "";
    setSourceDrafts((current) => current.filter((item) => item.id !== sourceId));
    setProperties((current) => current.map((property) => (property.sourceId === sourceId ? { ...property, sourceId: fallback, sourceField: "" } : property)));
    setLocalError("");
  };
  /** 主来源的主键列就是对象的身份；改它时要顺带把补充来源的连接键按位对齐。 */
  const toggleSourceKeyColumn = (column: string) => {
    setSourceDrafts((current) => {
      const primary = current[0];
      if (!primary) return current;
      const primaryKey = primary.primaryKey.includes(column) ? primary.primaryKey.filter((item) => item !== column) : [...primary.primaryKey, column];
      return current.map((item, index) => (index === 0 ? { ...item, primaryKey } : { ...item, primaryKey: primaryKey.map((_, position) => item.primaryKey[position] ?? "") }));
    });
  };
  const setSourceJoinKey = (sourceId: string, position: number, column: string) => {
    setSourceDrafts((current) => current.map((item) => {
      if (item.id !== sourceId) return item;
      const primaryKey = [...item.primaryKey];
      primaryKey[position] = column;
      return { ...item, primaryKey };
    }));
  };
  const mapProperty = (propertyName: string, sourceField: string) => {
    setProperties((current) => current.map((item) => (item.name === propertyName ? { ...item, sourceField } : item)));
  };
  const mapPropertySource = (propertyName: string, sourceId: string) => {
    setProperties((current) => current.map((item) => (item.name === propertyName ? { ...item, sourceId, sourceField: "" } : item)));
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !name.trim()) return;
    const blockers = sourceIssues.filter((issue) => issue.severity !== "WARN");
    if (blockers.length) { setLocalError(blockers.map((issue) => issue.message).join("；")); return; }
    setBusy(true);
    try {
      await onSave(kind === "entity"
        ? { name, description, displayProperty, parents, properties, sources: normalizedSources }
        : { name, sourceEntityTypeId: source, targetEntityTypeId: target, properties });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop ted-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <form
        className="ted-dialog"
        onSubmit={submit}
        onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }}
      >
        <header className="ted-head">
          <span className="ted-mark" style={named ? { background: `${color}14`, color } : undefined}>
            {kind === "entity" ? <CircleDot size={20} /> : <Link2 size={20} />}
          </span>
          <div className="ted-title">
            <span className="ted-eyebrow">{mode === "create" ? "新增" : "编辑"}</span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="ted-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="ted-body">
          <div className="ted-form">
            {kind === "entity" ? (
              <>
                <div className="ted-grid-2">
                  <label className="ted-field">
                    <span>名称</span>
                    <input className="ted-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户" required />
                    <small>对象类型的名称，也是它在画布上的标题和取色依据。</small>
                  </label>
                  <label className="ted-field">
                    <span>说明</span>
                    <input className="ted-input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个对象类型代表什么" />
                    <small>写给同事看的业务含义，可留空。</small>
                  </label>
                </div>
                <label className="ted-field">
                  <span>显示属性</span>
                  <select className="ted-select" value={displayProperty} onChange={(event) => setDisplayProperty(event.target.value)}>
                    <option value="">默认（按 name / 名称 / title / id 自动选择）</option>
                    {properties.map((prop) => <option key={prop.name} value={prop.name}>{prop.name}</option>)}
                  </select>
                  <small>节点上显示哪条属性；在本体草稿页「复制显示样式」可导出对应的 Neo4j Browser caption 规则。</small>
                </label>
                <div className="ted-field">
                  <span><Layers size={12} />父类（继承）</span>
                  {parentCandidates.length > 0 ? (
                    <div className="ted-source-picker">
                      {parentCandidates.map((candidate) => (
                        <label key={candidate.id} className={parents.includes(candidate.id) ? "ted-chip active" : "ted-chip"}>
                          <input type="checkbox" checked={parents.includes(candidate.id)} onChange={() => toggleParent(candidate.id)} />
                          {candidate.name}
                        </label>
                      ))}
                    </div>
                  ) : <p className="ted-props-empty">草稿里还没有别的类，先把父类建出来再回来勾。</p>}
                  {ancestorNames.length > 0 && (
                    <p className="ted-inherit"><CornerDownRight size={12} />也属于：{ancestorNames.join("、")}</p>
                  )}
                  <small>勾上父类，子类就自动拥有父类的属性。比如「专线产品用户」勾上「用户」，就不必再单独建一条「包含」关系。</small>
                </div>
              </>
            ) : (
              <>
                <div className="ted-grid-2">
                  <label className="ted-field">
                    <span>名称</span>
                    <input className="ted-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：负责" required />
                    <small>画布上这条连线标注的关系类型名。</small>
                  </label>
                  <div className="ted-field">
                    <span>方向</span>
                    <div className="ted-direction" aria-hidden="true">
                      <span data-empty={!sourceEntity} style={sourceEntity ? { background: graphColor(sourceEntity.name) } : undefined}>{sourceEntity ? compactGraphLabel(sourceEntity.name) : "起点"}</span>
                      <ArrowGlyph />
                      <span data-empty={!targetEntity} style={targetEntity ? { background: graphColor(targetEntity.name) } : undefined}>{targetEntity ? compactGraphLabel(targetEntity.name) : "终点"}</span>
                    </div>
                    <small>连线由起点指向终点。</small>
                  </div>
                </div>
                <div className="ted-grid-2">
                  <label className="ted-field">
                    <span>起始对象类型</span>
                    <select className="ted-select" value={source} onChange={(event) => setSource(event.target.value)} required>
                      <option value="">选择对象类型</option>
                      {entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <label className="ted-field">
                    <span>终止对象类型</span>
                    <select className="ted-select" value={target} onChange={(event) => setTarget(event.target.value)} required>
                      <option value="">选择对象类型</option>
                      {entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                </div>
              </>
            )}

            <section className="ted-section">
              <div className="ted-section-head">
                <h3>{kind === "entity" ? "属性" : "关系类型属性"}</h3>
                <em>{properties.length ? `${properties.length} 条` : "空"}</em>
              </div>
              {properties.length > 0 ? (
                <div className="ted-props">
                  {properties.map((prop, index) => editingProp === index && propDraft ? (
                    <div className="ted-prop editing" key={`${prop.name}-${index}`}>
                      <input className="ted-input" value={propDraft.name} onChange={(event) => setPropDraft({ ...propDraft, name: event.target.value })} placeholder="属性名称" />
                      <select className="ted-select" value={propDraft.dataType} onChange={(event) => setPropDraft({ ...propDraft, dataType: event.target.value as Property["dataType"] })}>
                        {propertyTypeOptions.map((item) => <option key={item}>{item}</option>)}
                      </select>
                      <label className="ted-toggle"><input type="checkbox" checked={propDraft.required} onChange={(event) => setPropDraft({ ...propDraft, required: event.target.checked })} />必填</label>
                      <div className="ted-prop-actions">
                        <button type="button" className="ted-icon-button confirm" onClick={saveProperty} title="保存这条属性"><Check size={14} /></button>
                        <button type="button" className="ted-icon-button" onClick={cancelEditProperty} title="放弃修改"><X size={14} /></button>
                      </div>
                    </div>
                  ) : (
                    <div className="ted-prop" key={`${prop.name}-${index}`}>
                      <div className="ted-prop-main">
                        <b>{prop.name}</b>
                        <code>{prop.dataType}</code>
                        {prop.required && <i className="ted-tag required">必填</i>}
                        {prop.unique && <i className="ted-tag unique">唯一</i>}
                      </div>
                      <div className="ted-prop-actions">
                        <button type="button" className="ted-icon-button" onClick={() => startEditProperty(index)} title={`编辑 ${prop.name}`}><Pencil size={13} /></button>
                        <button type="button" className="ted-icon-button danger" onClick={() => removeProperty(index)} title={`删除 ${prop.name}`}><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="ted-props-empty">还没有属性。在下面加一条，右侧预览会同步出现。</p>
              )}
              {/* 外层已经是表单，这里只能是 div：套 form 会触发 hydration 报错，回车改为直接提交这一行。 */}
              <div className="ted-add">
                <input className="ted-input" value={propName} onChange={(event) => setPropName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addProperty(); } }} placeholder="新属性名称" />
                <select className="ted-select" value={dataType} onChange={(event) => setDataType(event.target.value as Property["dataType"])}>
                  {propertyTypeOptions.map((item) => <option key={item}>{item}</option>)}
                </select>
                <label className="ted-toggle"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />必填</label>
                <button type="button" className="ted-add-button" onClick={addProperty}><Plus size={13} />添加</button>
              </div>
            </section>

            {kind === "entity" && (
              <section className="ted-section ted-source">
                <div className="ted-section-head">
                  <h3><Database size={13} />数据来源</h3>
                  <em>{sourceDrafts.length ? `${sourceDrafts.length} 份来源 · 已映射 ${mappedCount}/${properties.length} 条属性` : "只做建模"}</em>
                </div>
                {sourceDrafts.length === 0 ? (
                  <div className="ted-source-empty">
                    <p>{dataSources.length
                      ? "这个对象类型还没接数据。一个对象类型可以从多张表拼出来：主来源定对象身份，其余来源按主键补充属性。"
                      : "还没有数据资源。先去左侧「数据资源」页登记一个数据库连接，再回来把对象类型绑到表上。"}</p>
                    <button type="button" className="ted-add-button" disabled={!dataSources.length} onClick={addSource}><Plus size={13} />绑定数据来源</button>
                  </div>
                ) : (
                  <>
                    <div className="ted-sources">
                      {sourceDrafts.map((item, index) => (
                        <SourceCard
                          key={item.id}
                          source={item}
                          index={index}
                          dataSources={dataSources}
                          primaryKeyColumns={index === 0 ? [] : primaryKeyColumns}
                          propertyCount={properties.filter((property) => (property.sourceId || primarySourceId) === item.id).length}
                          onChange={(patch) => updateSource(item.id, patch)}
                          onPickDataSource={(dataSourceId) => pickSourceDataSource(item.id, dataSourceId)}
                          onPickView={(view, schema) => pickSourceView(item.id, view, schema)}
                          onToggleKeyColumn={index === 0 ? toggleSourceKeyColumn : undefined}
                          onPickJoinKey={index === 0 ? undefined : (position, column) => setSourceJoinKey(item.id, position, column)}
                          onRemove={index === 0 ? undefined : () => removeSource(item.id)}
                          onFields={rememberFields}
                        />
                      ))}
                      <button type="button" className="ted-add-button ted-add-source" disabled={!dataSources.length} onClick={addSource}><Plus size={13} />添加补充来源</button>
                    </div>
                    <div className="ted-field">
                      <span>属性映射</span>
                      {properties.length ? (
                        <div className="ted-maps">
                          {properties.map((prop) => {
                            const activeSourceId = prop.sourceId || primarySourceId;
                            const columns = columnsOfSource(sourceDrafts.find((item) => item.id === activeSourceId));
                            return (
                              <div className={sourceDrafts.length > 1 ? "ted-map ted-map-source" : "ted-map"} key={prop.name}>
                                <b>{prop.name}</b>
                                {sourceDrafts.length > 1 && (
                                  <select className="ted-select" value={activeSourceId} onChange={(event) => mapPropertySource(prop.name, event.target.value)}>
                                    {sourceDrafts.map((item, index) => <option key={item.id} value={item.id}>{sourceRoleLabel(index)} · {sourceName(item)}</option>)}
                                  </select>
                                )}
                                <select className="ted-select" value={prop.sourceField ?? ""} disabled={!columns.length && !prop.sourceField} onChange={(event) => mapProperty(prop.name, event.target.value)}>
                                  <option value="">未映射</option>
                                  {prop.sourceField && !columns.some((field) => field.name === prop.sourceField) && <option value={prop.sourceField}>{prop.sourceField} · 当前映射</option>}
                                  {columns.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
                                </select>
                              </div>
                            );
                          })}
                        </div>
                      ) : <p className="ted-props-empty">先在上面加属性，再回来把属性指到列上。</p>}
                    </div>
                  </>
                )}
                {sourceIssues.length > 0 && (
                  <ul className="ted-source-issues">
                    {sourceIssues.map((issue) => (
                      <li key={`${issue.rule}-${issue.message}`} data-warn={issue.severity === "WARN"}>
                        <AlertTriangle size={12} />
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="ted-source-note">对象不单独绑表：一个对象就是主来源里的一行，靠主键认身份；补充来源按主键连过去，只往对象上补属性。</p>
              </section>
            )}
          </div>

          <aside className="ted-preview">
            <div className="ted-preview-head">
              <b>画布预览</b>
              <span>{kind === "entity" ? "保存后，它就以这颗圆点出现在本体草稿画布上。" : "保存后，它就以这条连线出现在两个对象类型之间。"}</span>
            </div>
            <div className="ted-stage">
              {kind === "entity" ? (
                <div className="ted-node" data-empty={!named} style={named ? { background: color, boxShadow: `0 0 0 6px ${color}1a` } : undefined}>
                  {named ? compactGraphLabel(trimmedName) : "未命名"}
                </div>
              ) : (
                <div className="ted-edge">
                  <span className="ted-edge-endpoint" data-empty={!sourceEntity} style={sourceEntity ? { background: graphColor(sourceEntity.name) } : undefined}>
                    {sourceEntity ? compactGraphLabel(sourceEntity.name) : "起点"}
                  </span>
                  <span className="ted-edge-line" data-empty={!named}>
                    <i className="ted-edge-label">{named ? compactGraphLabel(trimmedName) : "未命名"}</i>
                  </span>
                  <span className="ted-edge-endpoint" data-empty={!targetEntity} style={targetEntity ? { background: graphColor(targetEntity.name) } : undefined}>
                    {targetEntity ? compactGraphLabel(targetEntity.name) : "终点"}
                  </span>
                </div>
              )}
            </div>
            {kind === "entity" && sourceDrafts.length > 0 && (
              <div className="ted-preview-sources">
                <em>数据来源</em>
                {sourceDrafts.map((item, index) => (
                  <span key={item.id}>
                    <code>{index === 0 ? "主" : `+${index}`}</code>
                    <b>{sourceName(item)}</b>
                    <i>{index === 0
                      ? (item.primaryKey.length ? `主键 ${item.primaryKey.join(" + ")}` : "未定主键")
                      : (item.primaryKey.filter(Boolean).length ? `连接 ${primaryKeyColumns.map((column, position) => `${column}→${item.primaryKey[position] || "?"}`).join(" ")}` : "未定连接键")}</i>
                  </span>
                ))}
              </div>
            )}
            <div className="ted-preview-props">
              {kind === "entity" && (
                <span><em>显示属性</em><code>{displayProperty || "自动"}</code></span>
              )}
              {previewProperties.map((prop) => (
                <span key={prop.name}>
                  <em>{prop.name}</em>
                  <code>{prop.required ? `${prop.dataType} · 必填` : prop.dataType}</code>
                </span>
              ))}
              {properties.length === 0 && inheritedProperties.length === 0 && <span className="ted-preview-empty">{kind === "entity" ? "还没有属性" : "这条关系类型没有额外属性"}</span>}
            </div>
            {properties.length > previewProperties.length && <p className="ted-preview-more">还有 {properties.length - previewProperties.length} 条属性未列出</p>}
            {kind === "entity" && inheritedProperties.length > 0 && (
              <div className="ted-inherit-list">
                <em>从父类继承</em>
                {inheritedProperties.slice(0, 6).map(({ property, from }) => (
                  <span key={property.name}>
                    <CornerDownRight size={11} />
                    <b>{property.name}</b>
                    <i>来自 {from}</i>
                    <code>{property.dataType}</code>
                  </span>
                ))}
                {inheritedProperties.length > 6 && <p className="ted-preview-more">还有 {inheritedProperties.length - 6} 条继承属性未列出</p>}
              </div>
            )}
            <p className="ted-note">画布按对象类型名取色：名字改了，这里的颜色和画布上的圆点一起变。</p>
          </aside>
        </div>

        <footer className="ted-foot">
          {localError
            ? <p className="ted-error"><AlertTriangle size={13} />{localError}</p>
            : <p className="ted-hint">按 Ctrl / ⌘ + Enter 保存</p>}
          <div className="ted-foot-actions">
            <button type="button" className="quiet-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || !name.trim()}>{busy ? "保存中…" : mode === "create" ? "加入草稿" : "保存修改"}</button>
          </div>
        </footer>
      </form>
    </div>
  );
}

type SourceCardProps = {
  source: EntitySource;
  index: number;
  dataSources: PublicDataSource[];
  /** 主来源的主键列；补充来源按它对位连接。 */
  primaryKeyColumns: string[];
  propertyCount: number;
  onChange: (patch: Partial<EntitySource>) => void;
  onPickDataSource: (dataSourceId: string) => void;
  onPickView: (view: string, schema: string) => void;
  onToggleKeyColumn?: (column: string) => void;
  onPickJoinKey?: (position: number, column: string) => void;
  onRemove?: () => void;
  onFields: (sourceId: string, key: string, fields: DataViewField[]) => void;
};

/**
 * 一份来源的编辑卡：选资源、选表；主来源再定主键与标题，补充来源按主键列逐个对位。
 * 每份来源自己读自己的结构，读到字段就报给上层——属性映射要用这份清单。
 */
function SourceCard({ source, index, dataSources, primaryKeyColumns, propertyCount, onChange, onPickDataSource, onPickView, onToggleKeyColumn, onPickJoinKey, onRemove, onFields }: SourceCardProps) {
  const primary = index === 0;
  // 拆成基本值：下面的请求只跟这些值走，父组件重渲染不会顺手把请求重发一遍。
  const dataSourceId = source.dataSourceId;
  const view = source.view;
  const schema = source.schema;
  const sourceId = source.id;
  // 读到的结构跟着「表身份」走：换资源或换表，旧的那份自动不算数，不用额外清空。
  const [viewsState, setViewsState] = useState<{ dataSourceId: string; rows: DataViewSummary[] }>({ dataSourceId: "", rows: [] });
  const [fieldsState, setFieldsState] = useState<{ key: string; rows: DataViewField[] }>({ key: "", rows: [] });
  const [error, setError] = useState("");
  const viewListId = useId();
  const fieldsKey = sourceFieldsKey({ dataSourceId, view });
  const views = viewsState.dataSourceId === dataSourceId ? viewsState.rows : [];
  const fields = fieldsState.key === fieldsKey ? fieldsState.rows : [];
  // 回调存进 ref：请求重发时不会因为回调换了个身份而多跑一轮。
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // 选定资源后拉它的结构清单，给「表 / 视图」那个输入框做候选。
  useEffect(() => {
    if (!dataSourceId) return;
    let cancelled = false;
    void api<{ views: DataViewSummary[] }>(`/api/data-sources/${dataSourceId}/views?limit=5000`)
      .then((data) => {
        if (cancelled) return;
        setViewsState({ dataSourceId, rows: data.views });
        // 表名可能是手打的：结构清单到了之后把 schema 补回去，别存下一份缺 schema 的绑定。
        const match = data.views.find((item) => item.name === view);
        if (match?.schema && match.schema !== schema) onChangeRef.current({ schema: match.schema });
      })
      .catch(() => { if (!cancelled) setViewsState({ dataSourceId, rows: [] }); });
    return () => { cancelled = true; };
  }, [dataSourceId, view, schema]);

  // 选定表之后取字段：主键、连接键和属性映射都从这份字段清单里选。
  useEffect(() => {
    if (!dataSourceId || !view) return;
    const key = fieldsKey;
    const query = schema ? `limit=1&schema=${encodeURIComponent(schema)}` : "limit=1";
    let cancelled = false;
    void api<{ fields: DataViewField[] }>(`/api/data-sources/${dataSourceId}/views/${encodeURIComponent(view)}?${query}`)
      .then((data) => { if (!cancelled) { setFieldsState({ key, rows: data.fields }); setError(""); onFields(sourceId, key, data.fields); } })
      .catch((reason) => { if (!cancelled) { setFieldsState({ key, rows: [] }); onFields(sourceId, key, []); setError(reason instanceof Error ? reason.message : "读取字段失败。"); } });
    return () => { cancelled = true; };
  }, [dataSourceId, view, schema, sourceId, fieldsKey, onFields]);
  const joinKeys = primaryKeyColumns.map((_, position) => source.primaryKey[position] ?? "");

  return (
    <div className="ted-source-card" data-primary={primary}>
      <div className="ted-source-rail" aria-hidden="true">
        <span className="ted-source-dot" />
        <em>{primary ? "主" : index}</em>
      </div>
      <div className="ted-source-body">
        <div className="ted-source-head">
          <b>{primary ? "主来源" : `补充来源 ${index}`}</b>
          <span>{sourceName(source)}{propertyCount ? ` · ${propertyCount} 条属性` : " · 暂无属性"}</span>
          {onRemove && <button type="button" className="ted-icon-button danger" onClick={onRemove} title="移除这份来源"><Trash2 size={13} /></button>}
        </div>
        <div className="ted-grid-2">
          <label className="ted-field">
            <span>数据资源</span>
            <select className="ted-select" value={source.dataSourceId} onChange={(event) => onPickDataSource(event.target.value)}>
              <option value="">不绑定（只做建模）</option>
              {source.dataSourceId && !dataSources.some((item) => item.id === source.dataSourceId) && <option value={source.dataSourceId}>这个数据资源已不在清单里</option>}
              {dataSources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kindLabel}</option>)}
            </select>
          </label>
          <label className="ted-field">
            <span><Table2 size={12} />表 / 视图</span>
            <input
              className="ted-input"
              list={viewListId}
              value={source.view}
              disabled={!source.dataSourceId}
              onChange={(event) => onPickView(event.target.value, views.find((item) => item.name === event.target.value)?.schema ?? source.schema)}
              placeholder={source.dataSourceId ? "输入或从下拉里选一个表名" : "先选数据资源"}
            />
            <datalist id={viewListId}>{views.map((item) => <option key={`${item.schema}.${item.name}`} value={item.name}>{item.comment || `${item.columnCount} 个字段`}</option>)}</datalist>
          </label>
        </div>
        {error && <p className="ted-source-error"><AlertTriangle size={13} />{error}</p>}
        {primary ? (
          fields.length > 0 && <>
            <label className="ted-field">
              <span>对象的显示名</span>
              <select className="ted-select" value={source.titleField} onChange={(event) => onChange({ titleField: event.target.value })}>
                <option value="">跟随「显示属性」</option>
                {source.titleField && !fields.some((field) => field.name === source.titleField) && <option value={source.titleField}>{source.titleField} · 当前映射</option>}
                {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.comment ? ` · ${field.comment}` : ""}</option>)}
              </select>
              <small>对象在列表和图谱上的标题取这一列；留空就按上面的「显示属性」。</small>
            </label>
            <div className="ted-field">
              <span>主键字段（对象身份）</span>
              <div className="ted-source-picker">
                {fields.map((field) => <label key={field.name} className={source.primaryKey.includes(field.name) ? "ted-chip active" : "ted-chip"}>
                  <input type="checkbox" checked={source.primaryKey.includes(field.name)} onChange={() => onToggleKeyColumn?.(field.name)} />
                  {field.primaryKey && <KeyRound size={11} />}
                  {field.name}
                </label>)}
                {/* 表换过之后，老的键不在字段清单里了：也显示出来，点一下就能去掉。 */}
                {source.primaryKey.filter((column) => column && !fields.some((field) => field.name === column)).map((column) => <label key={`stored-${column}`} className="ted-chip active stored" title="当前表里没有这一列，可能表已经换过">
                  <input type="checkbox" checked onChange={() => onToggleKeyColumn?.(column)} />
                  {column}
                </label>)}
              </div>
              <small>一个对象就是这张表里的一行，靠这几列认身份；表自己有主键的话用钥匙标出来了。</small>
            </div>
          </>
        ) : (
          <div className="ted-field">
            <span><KeyRound size={12} />连接键</span>
            {primaryKeyColumns.length ? (
              <div className="ted-key-map">
                {primaryKeyColumns.map((column, position) => (
                  <div className="ted-key-row" key={`${column}-${position}`}>
                    <code>{column}</code>
                    <ArrowGlyph />
                    <select className="ted-select" value={joinKeys[position]} disabled={!fields.length && !joinKeys[position]} onChange={(event) => onPickJoinKey?.(position, event.target.value)}>
                      <option value="">选择本表的列</option>
                      {joinKeys[position] && !fields.some((field) => field.name === joinKeys[position]) && <option value={joinKeys[position]}>{joinKeys[position]} · 当前映射</option>}
                      {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.primaryKey ? " · 主键" : ""}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ) : <p className="ted-props-empty">先在主来源里指定主键列，这里才知道要和哪几列对齐。</p>}
            <small>这张表里对应对象主键的列；按顺序一一对齐，就是两份来源的连接条件。</small>
          </div>
        )}
      </div>
    </div>
  );
}

/** 方向和对齐都用这个小箭头：比文字省地方，也一眼能看出从哪指到哪。 */
function ArrowGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}
