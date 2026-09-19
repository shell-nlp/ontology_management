"use client";

import { useMemo, useState } from "react";
import { Check, Link2, Plus, Save, ShieldAlert, Trash2, X } from "lucide-react";
import { newId } from "@/lib/ids";
import {
  checkImplementations,
  effectiveInterfaceLinkConstraints,
  effectiveInterfaceProperties,
  implementersOf,
  interfaceAncestorsOf,
  interfacePropertyRows,
  validateInterfaces,
  validateInterfaceImplementations,
} from "@/lib/interfaces";
import { useSplitPane } from "@/components/split-pane";
import { propertyTypeOptions, type Definition, type InterfaceLinkConstraint, type InterfaceType, type Property, type PropertyDataType } from "@/lib/ontology-draft";
import "./interface-manager.css";

/**
 * 接口（Palantir 的 Interface）的配置区 —— 「本体草稿」页的一级标签之一（可视化建模 → 概念分组 → 对象类型 → 关系类型 → 接口）。
 *
 * 接口是**抽象契约**：只描述"实现我的对象类型必须有哪些属性、哪些关系"，
 * 不绑数据、不能被实例化。谁实现了它，就按这套形状被应用统一消费。
 *
 * 左栏是接口清单（图标画成虚线框 —— 接口在 Palantir 里就是这个视觉约定），
 * 右栏改名字 / 说明、勾继承的接口、编接口属性与关系约束，并显示当前谁实现了它、还差什么。
 * 改动先落在右栏草稿里，点「保存接口」才写进草稿定义。
 */
type Props = {
  definition: Definition;
  canEdit: boolean;
  save: (next: Definition) => Promise<void>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
  /** 从画布点「编辑接口」进来时要选中的那一个（同一页的「可视化建模」标签跳过来）。 */
  focusId?: string;
};

function cloneInterface(item: InterfaceType): InterfaceType {
  // 不直接改 definition 里的对象：右栏草稿要能整体丢弃，所以复制一份再编辑。
  return {
    ...item,
    properties: item.properties.map((property) => ({ ...property })),
    extends: [...item.extends],
    linkConstraints: item.linkConstraints.map((constraint) => ({ ...constraint })),
  };
}function interfaceNameOf(definition: Definition, id: string) {
  return definition.interfaces.find((item) => item.id === id)?.name ?? "";
}

export function InterfaceManager({ definition, canEdit, save, notify, fail, focusId = "" }: Props) {
  const [selectedId, setSelectedId] = useState(focusId);
  const [draft, setDraft] = useState<InterfaceType | null>(null);
  const [busy, setBusy] = useState(false);
  const interfaces = definition.interfaces;

  /*
   * 画布上的「编辑接口」会带着 id 切到这一档：渲染期直接换选中项（和下面重装草稿一个套路），
   * 用 effect 会多一帧、也会把用户刚打的字冲掉。同一个 id 只认领一次，之后用户自己点列表不再被拉回。
   */
  const [claimedFocus, setClaimedFocus] = useState(focusId);
  if (focusId && claimedFocus !== focusId) {
    setClaimedFocus(focusId);
    if (interfaces.some((item) => item.id === focusId)) setSelectedId(focusId);
  }
  const selected = interfaces.find((item) => item.id === selectedId) ?? null;

  // 选中的接口换了（第一次点开、或刚新建）就在渲染期重装一份右栏草稿：
  // 用 effect 会多一次渲染，用户打字打到一半也可能被覆盖。
  if (selected && draft?.id !== selected.id) setDraft(cloneInterface(selected));
  const current = selected && draft?.id === selected.id ? draft : null;
  const dirty = Boolean(current && selected) && JSON.stringify(current) !== JSON.stringify(selected);

  const implementers = useMemo(
    () => (selected ? implementersOf(interfaces, definition.entityTypes, selected.id) : []),
    [interfaces, definition.entityTypes, selected],
  );
  const checks = useMemo(
    () => definition.entityTypes
      .map((entity) => ({ entity, check: checkImplementations(entity, interfaces, definition.relationshipTypes, definition.entityTypes).find((item) => item.interfaceId === selectedId) }))
      .filter((row) => row.check && (row.check.interfaceId === selectedId)),
    [definition.entityTypes, definition.relationshipTypes, interfaces, selectedId],
  );
  const issues = useMemo(() => [...validateInterfaces(definition), ...validateInterfaceImplementations(definition)], [definition]);

  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey: "interface-split",
    defaultWidth: 300,
    minLeft: 250,
    minDetail: 460,
    maxLeft: 600,
    label: "拖动调整接口清单宽度，双击恢复默认",
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

  const selectInterface = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm(`「${current?.name ?? ""}」还有未保存的改动，切换接口会丢掉它们。继续？`)) return;
    setSelectedId(id);
  };

  const addInterface = () => {
    let name = "新接口";
    let index = 2;
    while (interfaces.some((item) => item.name.trim().toLowerCase() === name.trim().toLowerCase())) { name = `新接口 ${index}`; index += 1; }
    const created: InterfaceType = { id: newId(), name, description: "", properties: [], extends: [], linkConstraints: [] };
    setSelectedId(created.id);
    void commit({ ...definition, interfaces: [...interfaces, created] }, `已新建接口，写清楚它要求实现方具备什么。`);
  };

  const saveDraft = () => {
    if (!selected || !current) return;
    const name = current.name.trim();
    if (!name) { fail(new Error("接口名称不能为空。")); return; }
    if (interfaces.some((item) => item.id !== selected.id && item.name.trim().toLowerCase() === name.toLowerCase())) {
      fail(new Error(`已经有叫「${name}」的接口了。`));
      return;
    }
    void commit(
      {
        ...definition,
        interfaces: interfaces.map((item) => (item.id === selected.id
          ? { ...current, name, properties: current.properties.map((property) => ({ ...property, name: property.name.trim() })) }
          : item)),
      },
      `接口「${name}」已保存到草稿。`,
    );
  };

  const removeInterface = () => {
    if (!selected) return;
    const users = definition.entityTypes.filter((entity) => (entity.implements ?? []).includes(selected.id));
    const tail = users.length ? `实现它的 ${users.length} 个对象类型（${users.map((item) => item.name).join("、")}）会失去这个实现声明。` : "还没有对象类型实现它。";
    if (!window.confirm(`删除接口「${selected.name}」？${tail}`)) return;
    setSelectedId("");
    void commit(
      {
        ...definition,
        interfaces: interfaces.filter((item) => item.id !== selected.id).map((item) => ({ ...item, extends: item.extends.filter((id) => id !== selected.id) })),
        entityTypes: definition.entityTypes.map((entity) => ({ ...entity, implements: (entity.implements ?? []).filter((id) => id !== selected.id) })),
      },
      "接口已删除，实现声明也一并清掉了。",
    );
  };

  /** 取消某个对象类型对这个接口的实现：只摘掉对象类型身上的实现声明，接口定义本身不动。 */
  const cancelImplementation = (entityId: string, entityName: string) => {
    if (!selected) return;
    void commit(
      { ...definition, entityTypes: definition.entityTypes.map((entity) => (entity.id === entityId ? { ...entity, implements: (entity.implements ?? []).filter((id) => id !== selected.id) } : entity)) },
      `已取消对象类型「${entityName}」对接口「${selected.name}」的实现。`,
    );
  };

  /**
   * 在这里加一个实现（Palantir 的接口总览页也有「Implementations → + New」这一条路）。
   * 加的时候不拦人：缺哪些必填属性会立刻在下面的实现情况里标出来，发布前校验再兜底。
   */
  const addImplementation = (entityId: string, entityName: string) => {
    if (!selected) return;
    void commit(
      { ...definition, entityTypes: definition.entityTypes.map((entity) => (entity.id === entityId ? { ...entity, implements: [...(entity.implements ?? []), selected.id] } : entity)) },
      `已让对象类型「${entityName}」实现接口「${selected.name}」。`,
    );
  };

  const patchDraft = (patch: Partial<InterfaceType>) => setDraft((state) => (state ? { ...state, ...patch } : state));

  const toggleExtend = (id: string) => {
    setDraft((state) => (state ? { ...state, extends: state.extends.includes(id) ? state.extends.filter((item) => item !== id) : [...state.extends, id] } : state));
  };

  const addProperty = () => {
    setDraft((state) => (state ? { ...state, properties: [...state.properties, { name: "", displayName: "", description: "", dataType: "TEXT" as PropertyDataType, required: true, unique: false, indexed: false }] } : state));
  };
  const patchProperty = (index: number, patch: Partial<Property>) => {
    setDraft((state) => (state ? { ...state, properties: state.properties.map((item, position) => (position === index ? { ...item, ...patch } : item)) } : state));
  };
  const removeProperty = (index: number) => {
    setDraft((state) => (state ? { ...state, properties: state.properties.filter((_, position) => position !== index) } : state));
  };

  const addConstraint = () => {
    const constraint: InterfaceLinkConstraint = { id: newId(), name: "", description: "", targetKind: "OBJECT_TYPE", targetId: "", cardinality: "MANY", required: true };
    setDraft((state) => (state ? { ...state, linkConstraints: [...state.linkConstraints, constraint] } : state));
  };
  const patchConstraint = (id: string, patch: Partial<InterfaceLinkConstraint>) => {
    setDraft((state) => (state ? { ...state, linkConstraints: state.linkConstraints.map((item) => (item.id === id ? { ...item, ...patch } : item)) } : state));
  };
  const removeConstraint = (id: string) => {
    setDraft((state) => (state ? { ...state, linkConstraints: state.linkConstraints.filter((item) => item.id !== id) } : state));
  };

  const implementerIds = new Set(implementers.map((entry) => entry.id));
  const addCandidates = selected ? definition.entityTypes.filter((entity) => !implementerIds.has(entity.id)) : [];
  const requiredNames = selected ? effectiveInterfaceProperties(interfaces, selected.id).filter((property) => property.required !== false).map((property) => property.name) : [];
  const missingRequiredCount = (entity: (typeof definition.entityTypes)[number]) => requiredNames.filter((name) => !entity.properties.some((property) => property.name === name)).length;
  const inheritedRows = current ? interfacePropertyRows(interfaces, current.id).filter((row) => row.inherited) : [];
  const ownNames = new Set(current?.properties.map((property) => property.name) ?? []);
  const constraintTargets = current
    ? (current.linkConstraints ?? []).map((constraint) => (constraint.targetKind === "INTERFACE"
      ? interfaces.filter((item) => item.id !== current.id).map((item) => ({ id: item.id, name: item.name }))
      : definition.entityTypes.map((item) => ({ id: item.id, name: item.name }))))
    : [];

  return <section className="manager-grid interface-grid" ref={containerRef} style={containerStyle}>
    <div className="panel functional-panel iface-rail">
      <span className="eyebrow">接口</span>
      <h2>{interfaces.length} 个接口</h2>
      <p className="iface-rail-note">{interfaces.length ? "抽象契约：实现它的对象类型必须满足这里的属性与关系。" : "还没有接口。接口用来表达「不同的对象类型可以被同一套应用按同一个形状消费」。"}</p>
      <div className="iface-rail-actions">
        <button className="action compact" disabled={!canEdit || busy} onClick={addInterface}><Plus size={14} />新建接口</button>
      </div>
      <div className="iface-rows">
        {interfaces.map((item) => {
          const count = implementersOf(interfaces, definition.entityTypes, item.id).length;
          const ancestors = interfaceAncestorsOf(interfaces, item.id).map((id) => interfaceNameOf(definition, id)).filter(Boolean);
          return <button key={item.id} className={selectedId === item.id ? "iface-row selected" : "iface-row"} onClick={() => selectInterface(item.id)}>
            <i className="iface-mark" aria-hidden="true" />
            <span>
              <b>{item.name}</b>
              <small>{`${item.properties.length} 个属性 · ${count} 个实现`}{ancestors.length ? ` · 继承 ${ancestors.join("、")}` : ""}</small>
            </span>
          </button>;
        })}
        {!interfaces.length && <p className="iface-empty">点上面的「新建接口」开始，例如「设施」「指标」，再把实现它的对象类型挂上去。</p>}
      </div>
      {issues.length > 0 && <div className="iface-issues">
        <b><ShieldAlert size={13} />接口待处理</b>
        {issues.slice(0, 4).map((issue, index) => <p key={`${issue.rule}-${index}`}>{issue.message}</p>)}
      </div>}
    </div>
    <div {...handleProps}><span aria-hidden="true" /></div>
    <div className="panel functional-panel iface-sheet">
      {selected && current ? <>
        <div className="iface-sheet-head">
          <span className="eyebrow">接口定义</span>
          <div className="iface-title-row">
            <i className="iface-mark" aria-hidden="true" />
            <input aria-label="接口名称" disabled={!canEdit} placeholder="例如：设施" value={current.name} onChange={(event) => patchDraft({ name: event.target.value })} />
            {dirty && <em>未保存</em>}
          </div>
          <input aria-label="接口说明" className="iface-desc" disabled={!canEdit} placeholder="这个契约表达什么能力？例如：有名称与位置的一类设施。" value={current.description} onChange={(event) => patchDraft({ description: event.target.value })} />
        </div>

        <div className="iface-block">
          <span className="iface-block-label">继承的接口（{current.extends.length}）</span>
          <p className="iface-hint">接口可以继承多个接口：继承来的属性与关系约束会自动出现在实现方那一侧。</p>
          <div className="iface-chips">
            {interfaces.filter((item) => item.id !== current.id).map((item) => (
              <button key={item.id} type="button" disabled={!canEdit} className={current.extends.includes(item.id) ? "iface-chip borrowed" : "iface-chip"} onClick={() => toggleExtend(item.id)}>
                <i />{item.name}{current.extends.includes(item.id) && <Check size={11} />}
              </button>
            ))}
            {interfaces.length <= 1 && <p className="iface-empty">还没有别的接口可以继承。</p>}
          </div>
        </div>

        <div className="iface-block">
          <span className="iface-block-label">接口属性（{current.properties.length}）· 必填的实现在对象类型上必须同名</span>
          <div className="iface-table">
            <div className="iface-table-head"><span>名称</span><span>显示名</span><span>类型</span><span>必填</span><span /></div>
            {current.properties.map((property, index) => (
              <div className="iface-table-row" key={`${property.name}-${index}`}>
                <input aria-label={`属性 ${index + 1} 名称`} disabled={!canEdit} placeholder="例如：位置" value={property.name} onChange={(event) => patchProperty(index, { name: event.target.value })} />
                <input aria-label={`属性 ${index + 1} 显示名`} disabled={!canEdit} placeholder="留空用名称" value={property.displayName ?? ""} onChange={(event) => patchProperty(index, { displayName: event.target.value })} />
                <select aria-label={`属性 ${index + 1} 类型`} disabled={!canEdit} value={property.dataType} onChange={(event) => patchProperty(index, { dataType: event.target.value as PropertyDataType })}>
                  {propertyTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
                <label className="iface-check"><input type="checkbox" disabled={!canEdit} checked={property.required} onChange={(event) => patchProperty(index, { required: event.target.checked })} /></label>
                <button type="button" className="action compact danger" disabled={!canEdit} onClick={() => removeProperty(index)} title="删除属性"><Trash2 size={13} /></button>
              </div>
            ))}
            {!current.properties.length && <p className="iface-empty">还没有接口属性。实现它的对象类型必须有这里所有必填的同名属性。</p>}
          </div>
          <button className="action compact" disabled={!canEdit} onClick={addProperty}><Plus size={13} />添加属性</button>
          {inheritedRows.length > 0 && <p className="iface-hint">继承来的属性：{inheritedRows.map((row) => `${row.property.name}（来自 ${row.from}）`).join("、")}。同名属性以本接口为准。</p>}
        </div>

        <div className="iface-block">
          <span className="iface-block-label">关系约束（{current.linkConstraints.length}）</span>
          <p className="iface-hint">约束描述的是“从这里出去的一条关系”：实现方要有一条具体关系类型满足它（起点是实现它的对象类型，终点是选中的对象类型或接口）。</p>
          <div className="iface-table iface-table-link">
            <div className="iface-table-head"><span>约束名</span><span>另一端</span><span>目标</span><span>基数</span><span>必填</span><span /></div>
            {current.linkConstraints.map((constraint, index) => (
              <div className="iface-table-row" key={constraint.id}>
                <input aria-label={`约束 ${index + 1} 名称`} disabled={!canEdit} placeholder="例如：服务的航司" value={constraint.name} onChange={(event) => patchConstraint(constraint.id, { name: event.target.value })} />
                <select aria-label={`约束 ${index + 1} 另一端类型`} disabled={!canEdit} value={constraint.targetKind} onChange={(event) => patchConstraint(constraint.id, { targetKind: event.target.value as InterfaceLinkConstraint["targetKind"], targetId: "" })}>
                  <option value="OBJECT_TYPE">对象类型</option>
                  <option value="INTERFACE">接口</option>
                </select>
                <select aria-label={`约束 ${index + 1} 目标`} disabled={!canEdit} value={constraint.targetId} onChange={(event) => patchConstraint(constraint.id, { targetId: event.target.value })}>
                  <option value="">选择目标</option>
                  {(constraintTargets[index] ?? []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                </select>
                <select aria-label={`约束 ${index + 1} 基数`} disabled={!canEdit} value={constraint.cardinality} onChange={(event) => patchConstraint(constraint.id, { cardinality: event.target.value as InterfaceLinkConstraint["cardinality"] })}>
                  <option value="MANY">一对多</option>
                  <option value="ONE">一对一</option>
                </select>
                <label className="iface-check"><input type="checkbox" disabled={!canEdit} checked={constraint.required} onChange={(event) => patchConstraint(constraint.id, { required: event.target.checked })} /></label>
                <button type="button" className="action compact danger" disabled={!canEdit} onClick={() => removeConstraint(constraint.id)} title="删除约束"><Trash2 size={13} /></button>
              </div>
            ))}
            {!current.linkConstraints.length && <p className="iface-empty">还没有关系约束。只有确实要求实现方具备某条关系时才需要加。</p>}
          </div>
          <button className="action compact" disabled={!canEdit} onClick={addConstraint}><Plus size={13} /><Link2 size={13} />添加关系约束</button>
        </div>

        <div className="iface-block">
          <div className="iface-block-head">
            <span className="iface-block-label">实现情况（{implementers.length}）</span>
            {canEdit && addCandidates.length > 0 && (
              <label className="iface-add" title="给这个接口挂一个实现；缺哪些必填属性会立刻标出来">
                <Plus size={12} />
                <select value="" disabled={busy} onChange={(event) => { const picked = addCandidates.find((item) => item.id === event.target.value); if (picked) addImplementation(picked.id, picked.name); }}>
                  <option value="">添加实现…</option>
                  {addCandidates.map((item) => { const gap = missingRequiredCount(item); return <option key={item.id} value={item.id}>{item.name}{gap ? ` · 还缺 ${gap} 条必填属性` : " · 已满足"}</option>; })}
                </select>
              </label>
            )}
          </div>
          <div className="iface-chips">
            {checks.map(({ entity, check }) => {
              const missing = [...(check?.missingProperties ?? []), ...(check?.missingLinks ?? []).map((item) => `关系「${item.name}」`)];
              return <span key={entity.id} className={missing.length ? "iface-chip missing" : "iface-chip borrowed"} title={missing.length ? `还差：${missing.join("、")}` : "已满足接口要求"}>
                <i />{entity.name}{missing.length ? ` · 还差 ${missing.length} 项` : ""}
                <button type="button" className="iface-chip-x" disabled={!canEdit || busy} aria-label={`取消对象类型「${entity.name}」的实现`} title={`取消「${entity.name}」对这个接口的实现`} onClick={() => cancelImplementation(entity.id, entity.name)}><X size={11} /></button>
              </span>;
            })}
            {implementers.filter((entry) => !entry.direct).map((entry) => <span key={entry.id} className="iface-chip" title="通过继承的子接口间接实现：要取消得去实现方的对象类型上摘掉那个子接口"><i />{entry.name} · 间接</span>)}
            {!implementers.length && <p className="iface-empty">还没有对象类型实现它。到「可视化建模」或「对象类型」标签里打开那个对象类型，在「实现接口」里勾上。</p>}
          </div>
          <p className="iface-hint">实现 = 对象类型提供同名属性 + 满足必填的关系约束；发布前校验会拦住没满足的实现。摘掉实现可以点实现项尾巴上的 ✕，也可以到对象类型那一侧的「实现接口」里取消勾选。</p>
        </div>

        <div className="iface-sheet-foot">
          <button className="action danger" disabled={!canEdit || busy} onClick={removeInterface}><Trash2 size={15} />删除接口</button>
          <button className="action primary" disabled={!canEdit || busy || !dirty} onClick={saveDraft}><Save size={15} />{busy ? "保存中…" : "保存接口"}</button>
        </div>
      </> : <div className="iface-blank">
        <span className="iface-mark large" aria-hidden="true" />
        <b>{interfaces.length ? "选择一个接口" : "先建一个接口"}</b>
        <span>{interfaces.length ? "左边挑一个接口，这里改名字与说明、勾继承、编属性与关系约束。" : "接口是抽象契约：描述一类对象类型必须长什么样，应用就能按它统一消费。"}</span>
      </div>}
    </div>
  </section>;
}
