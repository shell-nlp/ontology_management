"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Check, LayoutGrid, Palette, Pencil, Plus, Trash2 } from "lucide-react";
import { GROUP_PALETTE, paletteColor, summarizeGroups } from "@/lib/concept-groups";
import { newId } from "@/lib/ids";
import { useSplitPane } from "@/components/split-pane";
import type { ConceptGroup, Definition } from "@/lib/ontology-draft";
import "./concept-group-manager.css";

/**
 * 概念分组（业务域）的配置区 —— 「本体草稿」页里与「可视化建模 / 表单」并列的第三个标签。
 *
 * 只做一件事：把对象类型按业务域归堆。分组是展示层的归类 —— 不进图库、不改对象类型的定义，
 * 图谱切到「按逻辑分组」时才看得见效果：分组的颜色就是那时画在那一堆节点外面的虚线框。
 *
 * 左栏是色卡式的分组清单（色条就是图上那个框的颜色），右栏改名 / 换色 / 勾成员。
 * 一个对象类型同时只属于一个分组：点一个已经在别组的类型会把它移过来。
 * 改动先落在右栏草稿里，点「保存分组」才写进草稿定义（一次性覆盖，避免两次写互相盖掉）。
 */
type GroupDraft = { id: string; name: string; color: string; memberIds: string[] };

type Props = {
  definition: Definition;
  canEdit: boolean;
  save: (next: Definition) => Promise<void>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

/** 分组没自己填颜色就按它在清单里的位置取调色板色：左栏色条、右栏预览、图上的框是同一个颜色。 */
function colorOf(groups: readonly ConceptGroup[], group: ConceptGroup) {
  return group.color.trim() || paletteColor(groups.findIndex((item) => item.id === group.id));
}

function draftFor(group: ConceptGroup, groups: readonly ConceptGroup[], entityTypes: Definition["entityTypes"]): GroupDraft {
  return {
    id: group.id,
    name: group.name,
    color: colorOf(groups, group),
    memberIds: entityTypes.filter((item) => item.groupId === group.id).map((item) => item.id),
  };
}

export function ConceptGroupManager({ definition, canEdit, save, notify, fail }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = definition.groups;
  const selected = groups.find((group) => group.id === selectedId) ?? null;
  const summary = useMemo(() => summarizeGroups(groups, definition.entityTypes), [groups, definition.entityTypes]);
  const groupOf = useMemo(() => new Map(definition.entityTypes.map((item) => [item.id, item.groupId ?? ""])), [definition.entityTypes]);

  // 选中的分组换了（第一次点开、或刚新建）就在渲染期把右栏草稿重装一份：
  // 用 effect 会多一次渲染，而且用户打字打到一半可能被覆盖。
  if (selected && draft?.id !== selected.id) setDraft(draftFor(selected, groups, definition.entityTypes));
  const current = selected && draft?.id === selected.id ? draft : null;
  const autoColor = selected ? paletteColor(groups.findIndex((group) => group.id === selected.id)) : "";
  const savedColor = selected ? colorOf(groups, selected) : "";
  const savedMembers = selected ? definition.entityTypes.filter((item) => item.groupId === selected.id).map((item) => item.id) : [];
  const dirty = current && selected
    ? current.name !== selected.name
      || current.color.toLowerCase() !== savedColor.toLowerCase()
      || [...current.memberIds].sort().join("|") !== [...savedMembers].sort().join("|")
    : false;
  const keyword = filter.trim().toLowerCase();
  const visible = keyword ? definition.entityTypes.filter((item) => item.name.toLowerCase().includes(keyword)) : definition.entityTypes;

  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey: "concept-group-split",
    defaultWidth: 320,
    minLeft: 260,
    minDetail: 420,
    maxLeft: 620,
    label: "拖动调整分组清单宽度，双击恢复默认",
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

  /** 切换分组会丢掉右栏还没保存的改动，先问一句。 */
  const selectGroup = (id: string) => {
    if (id === selectedId) return;
    if (dirty && !window.confirm(`「${current?.name ?? ""}」还有未保存的改动，切换分组会丢掉它们。继续？`)) return;
    setSelectedId(id);
  };

  const addGroup = () => {
    if (dirty && !window.confirm(`「${current?.name ?? ""}」还有未保存的改动，新建分组会丢掉它们。继续？`)) return;
    let name = "新分组";
    let index = 2;
    while (groups.some((group) => group.name.trim().toLowerCase() === name.trim().toLowerCase())) { name = `新分组 ${index}`; index += 1; }
    const group: ConceptGroup = { id: newId(), name, color: paletteColor(groups.length) };
    setSelectedId(group.id);
    void commit({ ...definition, groups: [...groups, group] }, "已新建概念分组，改个名字并勾选它包含的对象类型。");
  };

  const saveDraft = () => {
    if (!selected || !current) return;
    const name = current.name.trim();
    if (!name) { fail(new Error("概念分组名不能为空。")); return; }
    if (groups.some((group) => group.id !== selected.id && group.name.trim().toLowerCase() === name.toLowerCase())) {
      fail(new Error(`已经有叫「${name}」的概念分组了。`));
      return;
    }
    const chosen = new Set(current.memberIds);
    const entityTypes = definition.entityTypes.map((item) => {
      if (chosen.has(item.id)) return item.groupId === selected.id ? item : { ...item, groupId: selected.id };
      return item.groupId === selected.id ? { ...item, groupId: "" } : item;
    });
    void commit(
      { ...definition, groups: groups.map((group) => (group.id === selected.id ? { ...group, name, color: current.color } : group)), entityTypes },
      `概念分组「${name}」已保存到草稿。`,
    );
  };

  const removeGroup = () => {
    if (!selected) return;
    const members = definition.entityTypes.filter((item) => item.groupId === selected.id);
    const tail = members.length ? `组里的 ${members.length} 个对象类型（${members.map((item) => item.name).join("、")}）会变成未归组，它们的定义不受影响。` : "这个分组还没有成员。";
    if (!window.confirm(`删除概念分组「${selected.name}」？${tail}`)) return;
    setSelectedId("");
    void commit(
      { ...definition, groups: groups.filter((group) => group.id !== selected.id), entityTypes: definition.entityTypes.map((item) => (item.groupId === selected.id ? { ...item, groupId: "" } : item)) },
      "概念分组已删除，成员回到未归组。",
    );
  };

  const toggleMember = (entityId: string) => {
    setDraft((state) => state
      ? { ...state, memberIds: state.memberIds.includes(entityId) ? state.memberIds.filter((id) => id !== entityId) : [...state.memberIds, entityId] }
      : state);
  };

  return <section className="manager-grid concept-group-grid" ref={containerRef} style={containerStyle}>
    <div className="panel functional-panel cg-rail">
      <span className="eyebrow">概念分组</span>
      <h2>{groups.length} 个分组</h2>
      <p className="cg-rail-note">{definition.entityTypes.length ? (summary.ungrouped.length ? `${summary.ungrouped.length} 个对象类型还没归组` : "所有对象类型都已归组") : "草稿里还没有对象类型"}</p>
      <div className="cg-rail-actions">
        <button className="action compact" disabled={!canEdit || busy} onClick={addGroup}><Plus size={14} />新建分组</button>
        <p>分组只影响图谱上怎么摆、怎么画框。</p>
      </div>
      <div className="cg-rows">
        {summary.groups.map((group) => (
          <button key={group.id} className={selectedId === group.id ? "cg-row selected" : "cg-row"} style={{ "--cg": group.color } as CSSProperties} onClick={() => selectGroup(group.id)}>
            <span>
              <b>{group.name}</b>
              <small>{group.objectTypes.length ? `${group.objectTypes.length} 个对象类型 · ${group.objectTypes.join("、")}` : "还没有对象类型"}</small>
            </span>
          </button>
        ))}
        {!groups.length && <p className="cg-empty">还没有分组。按业务域建几个（客户域 / 账务域 / 字典域…），图谱上就能按组看这张图。</p>}
      </div>
      {summary.ungrouped.length > 0 && <p className="cg-ungrouped">未归组（{summary.ungrouped.length}）：{summary.ungrouped.join("、")}</p>}
    </div>
    <div {...handleProps}><span aria-hidden="true" /></div>
    <div className="panel functional-panel cg-sheet">
      {selected && current ? <>
        <div className="cg-sheet-head">
          <span className="eyebrow">分组配置</span>
          <div className="cg-title-row">
            <i aria-hidden="true" style={{ background: current.color }} />
            <input aria-label="分组名称" disabled={!canEdit} placeholder="例如：客户域" value={current.name} onChange={(event) => setDraft({ ...current, name: event.target.value })} />
            {dirty && <em>未保存</em>}
          </div>
        </div>

        <div className="cg-block">
          <span className="cg-block-label"><Palette size={12} />图谱上的框色</span>
          <div className="cg-frame" style={{ color: current.color }}>
            <b>{current.name.trim() || "未命名分组"}</b>
            <span className="cg-frame-nodes" aria-hidden="true"><i /><i /><i /></span>
          </div>
          <p className="cg-hint">图谱切到「按逻辑分组」时，同组的对象类型就装进这样一个虚线框。</p>
          <div className="cg-colors">
            <button type="button" className={current.color.toLowerCase() === autoColor.toLowerCase() ? "auto active" : "auto"} disabled={!canEdit} onClick={() => setDraft({ ...current, color: autoColor })}>按位置自动</button>
            {GROUP_PALETTE.map((color) => (
              <button key={color} type="button" aria-label={`用颜色 ${color}`} className={current.color.toLowerCase() === color.toLowerCase() ? "swatch active" : "swatch"} style={{ background: color }} disabled={!canEdit} onClick={() => setDraft({ ...current, color })} />
            ))}
          </div>
        </div>

        <div className="cg-block">
          <span className="cg-block-label">包含哪些对象类型（{current.memberIds.length} / {definition.entityTypes.length}）</span>
          <input className="cg-filter" value={filter} disabled={!definition.entityTypes.length} onChange={(event) => setFilter(event.target.value)} placeholder="筛选对象类型" />
          <div className="cg-chips">
            {visible.map((entity) => {
              const checked = current.memberIds.includes(entity.id);
              const otherId = checked ? "" : groupOf.get(entity.id) ?? "";
              const other = otherId && otherId !== selected.id ? groups.find((group) => group.id === otherId) : undefined;
              return (
                <button
                  key={entity.id}
                  type="button"
                  className={checked ? "cg-chip checked" : other ? "cg-chip borrowed" : "cg-chip"}
                  disabled={!canEdit}
                  onClick={() => toggleMember(entity.id)}
                  style={{ "--chip": current.color, "--other": other ? colorOf(groups, other) : "#94a3b8" } as CSSProperties}
                  title={other ? `现在在「${other.name}」，点一下移过来` : checked ? "点一下移出这个分组" : "点一下归到这个分组"}
                >
                  <i aria-hidden="true" />
                  <span>{entity.name}</span>
                  {checked && <Check size={11} />}
                  {other && <em>{other.name}</em>}
                </button>
              );
            })}
            {!definition.entityTypes.length && <p className="cg-empty">草稿里还没有对象类型，先回「可视化建模」建几个。</p>}
            {definition.entityTypes.length > 0 && !visible.length && <p className="cg-empty">没有名字里带「{filter.trim()}」的对象类型。</p>}
          </div>
          <p className="cg-hint">点一下归到这一组，再点一下移出。一个对象类型同时只属于一个分组，点别组的成员会把它移过来。</p>
        </div>

        <div className="cg-sheet-foot">
          <button className="action danger" disabled={!canEdit || busy} onClick={removeGroup}><Trash2 size={15} />删除分组</button>
          <button className="action primary" disabled={!canEdit || busy || !dirty} onClick={saveDraft}><Pencil size={15} />{busy ? "保存中…" : "保存分组"}</button>
        </div>
      </> : <div className="cg-blank">
        <LayoutGrid size={20} />
        <b>{groups.length ? "选择一个分组" : "先建一个分组"}</b>
        <span>{groups.length ? "左边挑一个分组，这里改名字、换框色，以及它包含哪些对象类型。" : "按业务域把对象类型归堆，图谱上就能按组看这张图。"}</span>
      </div>}
    </div>
  </section>;
}