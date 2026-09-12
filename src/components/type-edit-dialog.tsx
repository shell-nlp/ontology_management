"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, CircleDot, Database, KeyRound, Link2, Pencil, Plus, Table2, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { DataViewField, DataViewSummary, PublicDataSource } from "@/lib/data-source/types";
import { compactGraphLabel, graphColor } from "@/lib/graph-palette";
import { emptyEntitySource, propertyTypeOptions, type EntitySource, type EntityType, type Property, type RelationType } from "@/lib/ontology-draft";
import "./type-edit-dialog.css";

export type TypeEditPayload = {
  name: string;
  description?: string;
  displayProperty?: string;
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  properties: Property[];
  /** 类绑定的数据来源；关系类型不带这一项。 */
  source?: EntitySource;
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
 * 类 / 关系类型的定义面板：左栏写契约（身份、端点、属性规则），
 * 右栏按画布的真实规则预览——取色用 graphColor(name)，标签用 compactGraphLabel，
 * 所以改一个名字，这里的圆点和画布上的圆点一起换色。
 *
 * 表单模式和可视化模式共用这一个面板，两种入口写出来的草稿结构完全一致。
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
  // 数据来源绑定：只有类需要这一段，关系类型不显示。
  const [sources, setSources] = useState<PublicDataSource[]>([]);
  const [views, setViews] = useState<DataViewSummary[]>([]);
  const [fields, setFields] = useState<DataViewField[]>([]);
  const [sourceDraft, setSourceDraft] = useState<EntitySource>(() => entity?.source ?? emptyEntitySource());
  const [sourceError, setSourceError] = useState("");
  const viewListId = useId();

  // 已登记的数据资源：只取一次，用来填下拉。
  useEffect(() => {
    if (kind !== "entity") return;
    let cancelled = false;
    void api<PublicDataSource[]>("/api/data-sources")
      .then((rows) => { if (!cancelled) setSources(rows); })
      .catch(() => { if (!cancelled) setSources([]); });
    return () => { cancelled = true; };
  }, [kind]);

  // 选定资源后拉它的结构清单，给「表 / 视图」那个输入框做候选。
  useEffect(() => {
    if (kind !== "entity" || !sourceDraft.dataSourceId) return;
    let cancelled = false;
    void api<{ views: DataViewSummary[] }>(`/api/data-sources/${sourceDraft.dataSourceId}/views?limit=5000`)
      .then((data) => { if (!cancelled) setViews(data.views); })
      .catch(() => { if (!cancelled) setViews([]); });
    return () => { cancelled = true; };
  }, [kind, sourceDraft.dataSourceId]);

  // 选定表之后取字段，属性映射和主键都从这份字段清单里选。
  useEffect(() => {
    if (kind !== "entity" || !sourceDraft.dataSourceId || !sourceDraft.view) return;
    let cancelled = false;
    void api<{ fields: DataViewField[] }>(`/api/data-sources/${sourceDraft.dataSourceId}/views/${encodeURIComponent(sourceDraft.view)}?limit=1`)
      .then((data) => { if (!cancelled) { setFields(data.fields); setSourceError(""); } })
      .catch((reason) => { if (!cancelled) { setFields([]); setSourceError(reason instanceof Error ? reason.message : "读取字段失败。"); } });
    return () => { cancelled = true; };
  }, [kind, sourceDraft.dataSourceId, sourceDraft.view]);

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
  /** 换数据源：旧的表、字段映射都不再成立，一起清掉，避免留下指向别处的映射。 */
  const pickDataSource = (dataSourceId: string) => {
    setViews([]);
    setFields([]);
    setSourceError("");
    setSourceDraft({ dataSourceId, schema: "", view: "", primaryKey: [], titleField: "" });
    setProperties((current) => current.map((item) => ({ ...item, sourceField: "" })));
  };
  /** 换表：字段清单会重新拉，主键与显示名也跟着换成新表的字段。 */
  const pickView = (view: string) => {
    const known = views.find((item) => item.name === view);
    const same = sourceDraft.view === view;
    setSourceError("");
    if (!same) setFields([]);
    setSourceDraft((current) => ({ ...current, view, schema: known?.schema ?? current.schema, primaryKey: same ? current.primaryKey : [], titleField: same ? current.titleField : "" }));
    if (!same) setProperties((current) => current.map((item) => ({ ...item, sourceField: "" })));
  };
  const togglePrimaryKey = (field: string) => {
    setSourceDraft((current) => ({
      ...current,
      primaryKey: current.primaryKey.includes(field) ? current.primaryKey.filter((item) => item !== field) : [...current.primaryKey, field],
    }));
  };
  const mapProperty = (name: string, sourceField: string) => {
    setProperties((current) => current.map((item) => (item.name === name ? { ...item, sourceField } : item)));
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      await onSave(kind === "entity"
        ? { name, description, displayProperty, properties, source: { ...sourceDraft, view: sourceDraft.view.trim(), primaryKey: sourceDraft.primaryKey.filter(Boolean) } }
        : { name, sourceEntityTypeId: source, targetEntityTypeId: target, properties });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const noun = kind === "entity" ? "类" : "关系类型";
  const title = mode === "create" ? `新增${noun}` : `编辑${noun}`;
  const trimmedName = name.trim();
  const named = trimmedName.length > 0;
  const color = graphColor(trimmedName);
  const sourceEntity = entityTypes.find((item) => item.id === source) ?? null;
  const targetEntity = entityTypes.find((item) => item.id === target) ?? null;
  const previewProperties = properties.slice(0, 8);
  const boundSource = sources.find((item) => item.id === sourceDraft.dataSourceId) ?? null;
  const boundLabel = boundSource ? `${boundSource.name}${sourceDraft.view ? ` · ${sourceDraft.view}` : ""}` : "未绑定";

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
                    <small>类在画布上的标题，也是它取色的依据。</small>
                  </label>
                  <label className="ted-field">
                    <span>说明</span>
                    <input className="ted-input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个类代表什么" />
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
              </>
            ) : (
              <>
                <div className="ted-grid-2">
                  <label className="ted-field">
                    <span>名称</span>
                    <input className="ted-input" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：负责" required />
                    <small>画布上这条连线标注的关系名。</small>
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
                    <span>起始类</span>
                    <select className="ted-select" value={source} onChange={(event) => setSource(event.target.value)} required>
                      <option value="">选择类型</option>
                      {entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                  <label className="ted-field">
                    <span>终止类</span>
                    <select className="ted-select" value={target} onChange={(event) => setTarget(event.target.value)} required>
                      <option value="">选择类型</option>
                      {entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                </div>
              </>
            )}

            <section className="ted-section">
              <div className="ted-section-head">
                <h3>{kind === "entity" ? "属性规则" : "关系属性"}</h3>
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
                <p className="ted-props-empty">还没有属性规则。在下面加一条，右侧预览会同步出现。</p>
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
                  <em>{boundLabel}</em>
                </div>
                {sources.length ? (
                  <>
                    <div className="ted-grid-2">
                      <label className="ted-field">
                        <span>数据资源</span>
                        <select className="ted-select" value={sourceDraft.dataSourceId} onChange={(event) => pickDataSource(event.target.value)}>
                          <option value="">不绑定（只做建模）</option>
                          {sources.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kindLabel}</option>)}
                        </select>
                      </label>
                      <label className="ted-field">
                        <span><Table2 size={12} />表 / 视图</span>
                        <input
                          className="ted-input"
                          list={viewListId}
                          value={sourceDraft.view}
                          onChange={(event) => pickView(event.target.value)}
                          placeholder={sourceDraft.dataSourceId ? "输入或从下拉里选一个表名" : "先选数据资源"}
                          disabled={!sourceDraft.dataSourceId}
                        />
                        <datalist id={viewListId}>{views.map((item) => <option key={`${item.schema}.${item.name}`} value={item.name}>{item.comment || `${item.columnCount} 个字段`}</option>)}</datalist>
                      </label>
                    </div>
                    {sourceError && <p className="ted-source-error"><AlertTriangle size={13} />{sourceError}</p>}
                    {fields.length > 0 && <>
                      <label className="ted-field">
                        <span>对象的显示名</span>
                        <select className="ted-select" value={sourceDraft.titleField} onChange={(event) => setSourceDraft((current) => ({ ...current, titleField: event.target.value }))}>
                          <option value="">跟随「显示属性」</option>
                          {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.comment ? ` · ${field.comment}` : ""}</option>)}
                        </select>
                        <small>对象在列表和图谱上的标题取这一列；留空就按上面的「显示属性」。</small>
                      </label>
                      <div className="ted-field">
                        <span>主键字段（对象身份）</span>
                        <div className="ted-source-picker">
                          {fields.map((field) => <label key={field.name} className={sourceDraft.primaryKey.includes(field.name) ? "ted-chip active" : "ted-chip"}>
                            <input type="checkbox" checked={sourceDraft.primaryKey.includes(field.name)} onChange={() => togglePrimaryKey(field.name)} />
                            {field.primaryKey && <KeyRound size={11} />}
                            {field.name}
                          </label>)}
                        </div>
                        <small>一个对象就是这张表里的一行，靠这几列认身份；表自己有主键的话用钥匙标出来了。</small>
                      </div>
                      <div className="ted-field">
                        <span>属性映射</span>
                        {properties.length ? <div className="ted-maps">
                          {properties.map((prop) => <div className="ted-map" key={prop.name}>
                            <b>{prop.name}</b>
                            <select className="ted-select" value={prop.sourceField ?? ""} onChange={(event) => mapProperty(prop.name, event.target.value)}>
                              <option value="">未映射</option>
                              {fields.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
                            </select>
                          </div>)}
                        </div> : <p className="ted-props-empty">先在上面加属性，再回来把属性指到列上。</p>}
                      </div>
                    </>}
                  </>
                ) : <p className="ted-props-empty">还没有数据资源。先去左侧「数据资源」页登记一个数据库连接。</p>}
                <p className="ted-source-note">对象不单独绑表：一个对象就是这张表里的一行，所以来源写在类上。</p>
              </section>
            )}
          </div>

          <aside className="ted-preview">
            <div className="ted-preview-head">
              <b>画布预览</b>
              <span>{kind === "entity" ? "保存后，它就以这颗圆点出现在本体草稿画布上。" : "保存后，它就以这条连线出现在两个类之间。"}</span>
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
              {properties.length === 0 && <span className="ted-preview-empty">{kind === "entity" ? "还没有属性" : "这条关系没有额外属性"}</span>}
            </div>
            {properties.length > previewProperties.length && <p className="ted-preview-more">还有 {properties.length - previewProperties.length} 条属性未列出</p>}
            <p className="ted-note">画布按类型名取色：名字改了，这里的颜色和画布上的圆点一起变。</p>
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

/** 关系方向用的小箭头：和画布上的白底连线区分开，这里只需要一个方向提示。 */
function ArrowGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h13" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}
