"use client";

import { useState, type FormEvent } from "react";
import { Boxes, Diamond, Plus, Trash2, X } from "lucide-react";
import { newId } from "@/lib/ids";
import { propertyTypeOptions, type Definition, type InterfaceLinkConstraint, type InterfaceType, type Property, type PropertyDataType } from "@/lib/ontology-draft";
import "./type-edit-dialog.css";
import "./interface-edit-dialog.css";

type Props = {
  definition: Definition;
  /** 正在编辑的接口（定义里的那一份真身）。 */
  value: InterfaceType;
  canEdit: boolean;
  onSave: (next: Definition) => Promise<void>;
  onNotify?: (text: string) => void;
  onFail: (reason: unknown) => void;
  onClose: () => void;
};

function cloneInterface(item: InterfaceType): InterfaceType {
  return {
    ...item,
    properties: item.properties.map((property) => ({ ...property })),
    extends: [...item.extends],
    linkConstraints: item.linkConstraints.map((constraint) => ({ ...constraint })),
  };
}

/**
 * 「编辑接口」对话框 —— 和「编辑对象类型」同一个壳（`ted-*` 样式），
 * 左栏改契约本身，右栏是画布预览，底部「取消 / 保存修改」。
 *
 * 能改：名称、说明、继承的接口、属性、关系约束，以及**谁实现了它**。
 * 实现方虽然写在对象类型那一侧（`entityTypes[].implements`），但对用户来说就是这张对话框里的一个勾选，
 * 所以这里一起收进草稿、点保存时一次写回。
 */
export function InterfaceEditDialog({ definition, value, canEdit, onSave, onNotify, onFail, onClose }: Props) {
  const [draft, setDraft] = useState<InterfaceType>(() => cloneInterface(value));
  const [implementerIds, setImplementerIds] = useState<string[]>(() => definition.entityTypes.filter((entity) => (entity.implements ?? []).includes(value.id)).map((entity) => entity.id));
  const [busy, setBusy] = useState(false);

  const patch = (next: Partial<InterfaceType>) => setDraft((state) => ({ ...state, ...next }));
  const patchProperty = (index: number, next: Partial<Property>) => setDraft((state) => ({ ...state, properties: state.properties.map((item, position) => (position === index ? { ...item, ...next } : item)) }));
  const patchConstraint = (id: string, next: Partial<InterfaceLinkConstraint>) => setDraft((state) => ({ ...state, linkConstraints: state.linkConstraints.map((item) => (item.id === id ? { ...item, ...next } : item)) }));
  const toggleImplementer = (entityId: string) => setImplementerIds((list) => (list.includes(entityId) ? list.filter((item) => item !== entityId) : [...list, entityId]));

  const constraintTargets = (constraint: InterfaceLinkConstraint) => constraint.targetKind === "INTERFACE"
    ? definition.interfaces.filter((item) => item.id !== value.id).map((item) => ({ id: item.id, name: item.name }))
    : definition.entityTypes.filter((entity) => !definition.interfaces.some((item) => item.promotedFromEntityTypeId === entity.id)).map((entity) => ({ id: entity.id, name: entity.name }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const name = draft.name.trim();
    if (!name) { onFail(new Error("接口名称不能为空。")); return; }
    if (definition.interfaces.some((item) => item.id !== value.id && item.name.trim().toLowerCase() === name.toLowerCase())) {
      onFail(new Error(`已经有叫「${name}」的接口了。`));
      return;
    }
    const blankProperty = draft.properties.findIndex((property) => !property.name.trim());
    if (blankProperty >= 0) { onFail(new Error(`第 ${blankProperty + 1} 个属性还没写名字。`)); return; }
    const blankConstraintName = draft.linkConstraints.findIndex((constraint) => !constraint.name.trim());
    if (blankConstraintName >= 0) { onFail(new Error(`第 ${blankConstraintName + 1} 条关系约束还没写名字。`)); return; }
    const blankConstraintTarget = draft.linkConstraints.findIndex((constraint) => !constraint.targetId);
    if (blankConstraintTarget >= 0) { onFail(new Error(`关系约束「${draft.linkConstraints[blankConstraintTarget].name}」还没选另一端。`)); return; }

    setBusy(true);
    try {
      await onSave({
        ...definition,
        interfaces: definition.interfaces.map((item) => (item.id === value.id ? { ...draft, name } : item)),
        entityTypes: definition.entityTypes.map((entity) => (implementerIds.includes(entity.id)
          ? { ...entity, implements: [...new Set([...(entity.implements ?? []), value.id])] }
          : { ...entity, implements: (entity.implements ?? []).filter((id) => id !== value.id) })),
      });
      onNotify?.(`接口「${name}」已保存到草稿。`);
      onClose();
    } catch (reason) {
      onFail(reason);
    } finally {
      setBusy(false);
    }
  };

  const named = draft.name.trim().length > 0;
  const shadowName = value.promotedFromEntityTypeId ? definition.entityTypes.find((item) => item.id === value.promotedFromEntityTypeId)?.name ?? "" : "";

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
          <span className="ted-mark ifx-mark"><Diamond size={20} /></span>
          <div className="ted-title">
            <span className="ted-eyebrow">编辑</span>
            <h2>编辑接口</h2>
          </div>
          <button type="button" className="ted-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="ted-body">
          <div className="ted-form">
            <div className="ted-grid-2">
              <label className="ted-field">
                <span>名称</span>
                <input className="ted-input" autoFocus value={draft.name} disabled={!canEdit} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：可服务对象" required />
                <small>接口是抽象契约：它只描述形状，不绑数据、也不能被实例化。</small>
              </label>
              <label className="ted-field">
                <span>说明</span>
                <input className="ted-input" value={draft.description} disabled={!canEdit} onChange={(event) => patch({ description: event.target.value })} placeholder="这个契约表达什么能力" />
                <small>写清「实现它的对象类型应该长成什么样」，给人和模型看。</small>
              </label>
            </div>

            <div className="ted-field">
              <span className="ted-iface-head"><Boxes size={12} />继承的接口{draft.extends.length > 0 && <em>已继承 {draft.extends.length}</em>}</span>
              {definition.interfaces.filter((item) => item.id !== value.id).length > 0 ? (
                <div className="ted-source-picker">
                  {definition.interfaces.filter((item) => item.id !== value.id).map((item) => (
                    <label key={item.id} className={draft.extends.includes(item.id) ? "ted-chip iface active" : "ted-chip iface"} title={draft.extends.includes(item.id) ? "再点一下取消继承" : "点一下继承这个接口"}>
                      <input type="checkbox" checked={draft.extends.includes(item.id)} disabled={!canEdit} onChange={() => patch({ extends: draft.extends.includes(item.id) ? draft.extends.filter((id) => id !== item.id) : [...draft.extends, item.id] })} />
                      {item.name}
                    </label>
                  ))}
                </div>
              ) : <p className="ted-props-empty">草稿里还没有别的接口可以继承。</p>}
              <small>继承来的属性与关系约束会自动算到实现方那一侧。</small>
            </div>

            <section className="ted-section">
              <div className="ted-section-head">
                <h3>接口属性</h3>
                <span>{draft.properties.length} 条</span>
              </div>
              <div className="ted-props">
                {draft.properties.map((property, index) => (
                  <div className="ted-prop editing" key={`${property.name}-${index}`}>
                    <input className="ted-input" value={property.name} disabled={!canEdit} onChange={(event) => patchProperty(index, { name: event.target.value })} placeholder="属性名" />
                    <select className="ted-select" value={property.dataType} disabled={!canEdit} onChange={(event) => patchProperty(index, { dataType: event.target.value as PropertyDataType })}>
                      {propertyTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                    <label className="ted-toggle" title="必填：实现它的对象类型必须同名提供这个属性"><input type="checkbox" checked={property.required !== false} disabled={!canEdit} onChange={(event) => patchProperty(index, { required: event.target.checked })} />必填</label>
                    <button type="button" className="ted-icon-button danger" disabled={!canEdit} title={`删除 ${property.name || "这条属性"}`} onClick={() => patch({ properties: draft.properties.filter((_, position) => position !== index) })}><Trash2 size={13} /></button>
                  </div>
                ))}
                {!draft.properties.length && <p className="ted-props-empty">还没有属性。实现它的对象类型必须同名提供这里所有必填的属性。</p>}
              </div>
              <div className="ted-add">
                <button type="button" className="ted-add-button" disabled={!canEdit} onClick={() => patch({ properties: [...draft.properties, { name: "", displayName: "", description: "", dataType: "TEXT" as PropertyDataType, required: true, unique: false, indexed: false }] })}><Plus size={14} />添加属性</button>
              </div>
            </section>

            <section className="ted-section">
              <div className="ted-section-head">
                <h3>关系约束</h3>
                <span>{draft.linkConstraints.length} 条</span>
              </div>
              <p className="ted-hint">约束说清「实现方必须连到什么」：另一端可以是对象类型，也可以是另一个接口；具体由哪条关系类型满足，交给实现方自己决定。</p>
              <div className="ted-props">
                {draft.linkConstraints.map((constraint) => (
                  <div className="ted-constraint" key={constraint.id}>
                    <input className="ted-input" value={constraint.name} disabled={!canEdit} onChange={(event) => patchConstraint(constraint.id, { name: event.target.value })} placeholder="约束名，例如：服务的对象" />
                    <select className="ted-select" value={constraint.targetKind} disabled={!canEdit} onChange={(event) => patchConstraint(constraint.id, { targetKind: event.target.value as InterfaceLinkConstraint["targetKind"], targetId: "" })}>
                      <option value="OBJECT_TYPE">连到对象类型</option>
                      <option value="INTERFACE">连到接口</option>
                    </select>
                    <select className="ted-select" value={constraint.targetId} disabled={!canEdit} onChange={(event) => patchConstraint(constraint.id, { targetId: event.target.value })}>
                      <option value="">选择另一端</option>
                      {constraintTargets(constraint).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                    </select>
                    <label className="ted-toggle" title="必填：实现方没有满足它的关系类型时，发布前校验会拦下来"><input type="checkbox" checked={constraint.required} disabled={!canEdit} onChange={(event) => patchConstraint(constraint.id, { required: event.target.checked })} />必填</label>
                    <button type="button" className="ted-icon-button danger" disabled={!canEdit} title="删掉这条约束" onClick={() => patch({ linkConstraints: draft.linkConstraints.filter((item) => item.id !== constraint.id) })}><Trash2 size={13} /></button>
                  </div>
                ))}
                {!draft.linkConstraints.length && <p className="ted-props-empty">还没有关系约束。只有确实要求实现方具备某条关系时才需要加。</p>}
              </div>
              <div className="ted-add">
                <button type="button" className="ted-add-button" disabled={!canEdit} onClick={() => patch({ linkConstraints: [...draft.linkConstraints, { id: newId(), name: "", description: "", targetKind: "OBJECT_TYPE", targetId: "", cardinality: "MANY", required: true }] })}><Plus size={14} />添加约束</button>
              </div>
            </section>

            <div className="ted-field">
              <span className="ted-iface-head"><Boxes size={12} />谁实现了它{implementerIds.length > 0 && <em>已实现 {implementerIds.length}</em>}{implementerIds.length > 0 && <button type="button" className="ted-iface-clear" onClick={() => setImplementerIds([])}>全部取消</button>}</span>
              {definition.entityTypes.filter((entity) => !definition.interfaces.some((item) => item.promotedFromEntityTypeId === entity.id)).length > 0 ? (
                <div className="ted-source-picker">
                  {definition.entityTypes.filter((entity) => !definition.interfaces.some((item) => item.promotedFromEntityTypeId === entity.id)).map((entity) => (
                    <label key={entity.id} className={implementerIds.includes(entity.id) ? "ted-chip iface active" : "ted-chip iface"} title={implementerIds.includes(entity.id) ? "再点一下取消实现" : "点一下让这个对象类型实现接口"}>
                      <input type="checkbox" checked={implementerIds.includes(entity.id)} disabled={!canEdit} onChange={() => toggleImplementer(entity.id)} />
                      {entity.name}
                    </label>
                  ))}
                </div>
              ) : <p className="ted-props-empty">本体里还没有对象类型。</p>}
              <small>实现方写在对象类型那一侧的「实现接口」上；保存后画布会连一条紫色虚线过去。</small>
            </div>
          </div>

          <aside className="ted-preview">
            <div className="ted-preview-head">
              <b>画布预览</b>
              <span>保存后，它就以这个带虚线圈的节点出现在本体草稿画布上。</span>
            </div>
            <div className="ted-stage">
              <div className="ifx-node" data-empty={!named}>
                <span>{named ? draft.name.trim() : "未命名"}</span>
              </div>
            </div>
            {value.promotedFromEntityTypeId && <p className="ted-preview-more">由无数据源对象类型「{shadowName || value.name}」提取而来；原对象类型与它的关系仍保留在底层。</p>}
            <div className="ted-preview-props">
              <em>属性</em>
              {draft.properties.slice(0, 8).map((property) => <span key={property.name}><b>{property.name || "未命名"}</b><code>{property.dataType}{property.required !== false ? " · 必填" : ""}</code></span>)}
              {!draft.properties.length && <span className="ted-preview-empty">还没有属性</span>}
            </div>
            {draft.properties.length > 8 && <p className="ted-preview-more">还有 {draft.properties.length - 8} 条属性未列出</p>}
            <div className="ted-preview-sources">
              <em>关系约束</em>
              {draft.linkConstraints.slice(0, 6).map((constraint) => {
                const target = constraint.targetKind === "INTERFACE"
                  ? definition.interfaces.find((item) => item.id === constraint.targetId)?.name ?? "未选"
                  : definition.entityTypes.find((item) => item.id === constraint.targetId)?.name ?? "未选";
                return <span key={constraint.id}><code>{constraint.targetKind === "INTERFACE" ? "接口" : "对象"}</code><b>{constraint.name || "未命名"} → {target}{constraint.required ? "（必填）" : ""}</b></span>;
              })}
              {!draft.linkConstraints.length && <span><code>—</code><b>还没有关系约束</b></span>}
            </div>
          </aside>
        </div>

        <footer className="ted-foot">
          <p className="ted-hint">按 Ctrl / ⌘ + Enter 保存</p>
          <div className="ted-foot-actions">
            <button type="button" className="quiet-button" onClick={onClose}>取消</button>
            <button className="primary-button" disabled={busy || !canEdit || !named}>{busy ? "保存中…" : "保存修改"}</button>
          </div>
        </footer>
      </form>
    </div>
  );
}
