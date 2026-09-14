"use client";

import { useMemo, useState } from "react";
import { LayoutGrid, Pencil, Plus, Trash2 } from "lucide-react";
import { GROUP_PALETTE, paletteColor, summarizeGroups } from "@/lib/concept-groups";
import { newId } from "@/lib/ids";
import type { ConceptGroup, Definition } from "@/lib/ontology-draft";
import "./concept-group-manager.css";

/**
 * 概念分组（业务域）的配置页。
 *
 * 只做一件事：把对象类型按业务域归堆。分组是展示层的归类 —— 不进图库、不改对象类型的定义，
 * 图谱切到「按逻辑分组」时才看得见效果（一组一个虚线框）。
 *
 * 左侧挑分组，右侧改名字 / 颜色 / 成员：勾选即归组，**一个对象类型同时只属于一个分组**，
 * 勾一个已经在别组的类型会把它移过来。改动先落在右侧草稿里，点「保存分组」才写进草稿定义。
 */
type GroupDraft = { id: string; name: string; color: string; memberIds: string[] };

type Props = {
  definition: Definition;
  canEdit: boolean;
  save: (next: Definition) => Promise<void>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

function draftFor(group: ConceptGroup, groups: readonly ConceptGroup[], entityTypes: Definition["entityTypes"]): GroupDraft {
  return {
    id: group.id,
    name: group.name,
    // 分组没自己填颜色就按它在清单里的位置取调色板色：画布上的框、这里的色点、左栏都是同一个颜色。
    color: group.color.trim() || paletteColor(groups.findIndex((item) => item.id === group.id)),
    memberIds: entityTypes.filter((item) => item.groupId === group.id).map((item) => item.id),
  };
}

export function ConceptGroupManager({ definition, canEdit, save, notify, fail }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<GroupDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = definition.groups;
  const selected = groups.find((group) => group.id === selectedId) ?? null;
  const summary = useMemo(() => summarizeGroups(groups, definition.entityTypes), [groups, definition.entityTypes]);

  // 选中的分组换了（第一次点开、或刚新建）就在渲染期把右侧草稿重装一份：
  // 用 effect 会多一次渲染，而且用户打字打到一半可能被覆盖。
  if (selected && draft?.id !== selected.id) setDraft(draftFor(selected, groups, definition.entityTypes));
  const current = selected && draft?.id === selected.id ? draft : null;
  const autoColor = selected ? paletteColor(groups.findIndex((group) => group.id === selected.id)) : "";

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

  const addGroup = () => {
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
    if (!window.confirm(`删除概念分组「${selected.name}」？${members.length ? `组里的 ${members.length} 个对象类型（${members.map((item) => item.name).join("、")}）会变成未归组，它们的定义不受影响。` : "这个分组还没有成员。"}`)) return;
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

  return <section className="manager-grid">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">概念分组</span>
      <h2>{groups.length} 个分组 · {summary.ungrouped.length} 个对象类型未归组</h2>
      <div className="cg-toolbar">
        <button className="action compact" disabled={!canEdit || busy} onClick={addGroup}><Plus size={14} />新建分组</button>
        <p>分组只影响图谱上怎么摆、怎么画框，不进图库、也不改对象类型的定义。</p>
      </div>
      <div className="manager-rows">
        {summary.groups.map((group) => (
          <button key={group.id} className={selectedId === group.id ? "manager-row selected" : "manager-row"} onClick={() => setSelectedId(group.id)}>
            <i className="cg-dot" style={{ background: group.color }} />
            <span><b>{group.name}</b><small>{group.objectTypes.length ? `${group.objectTypes.length} 个对象类型 · ${group.objectTypes.join("、")}` : "还没有对象类型"}</small></span>
          </button>
        ))}
        {!groups.length && <p className="empty">还没有概念分组。按业务域建几个（客户域 / 账务域 / 字典域…），图谱上就能按组看这张图。</p>}
      </div>
      {summary.ungrouped.length > 0 && <p className="cg-ungrouped">未归组（{summary.ungrouped.length}）：{summary.ungrouped.join("、")}</p>}
    </div>
    <div className="panel functional-panel detail-panel">
      {selected && current ? <>
        <span className="eyebrow">分组配置</span>
        <h2>{selected.name}</h2>
        <label className="cg-field"><span>名称</span>
          <input value={current.name} disabled={!canEdit} onChange={(event) => setDraft({ ...current, name: event.target.value })} placeholder="例如：客户域" />
        </label>
        <div className="cg-field"><span>颜色（图谱上的分组框用的就是它）</span>
          <div className="cg-colors">
            <button type="button" className={current.color.toLowerCase() === autoColor.toLowerCase() ? "auto active" : "auto"} disabled={!canEdit} onClick={() => setDraft({ ...current, color: autoColor })}>按位置自动</button>
            {GROUP_PALETTE.map((color) => (
              <button key={color} type="button" aria-label={`用颜色 ${color}`} className={current.color.toLowerCase() === color.toLowerCase() ? "swatch active" : "swatch"} style={{ background: color }} disabled={!canEdit} onClick={() => setDraft({ ...current, color })} />
            ))}
          </div>
        </div>
        <div className="cg-field">
          <span>包含哪些对象类型（{current.memberIds.length}）</span>
          <p className="cg-hint">勾上就归到这个分组。勾一个已经在别的分组的类型，会把它从那边移过来 —— 一个对象类型同时只属于一个分组。</p>
          <div className="cg-members">
            {definition.entityTypes.map((entity) => {
              const checked = current.memberIds.includes(entity.id);
              const other = checked ? undefined : groups.find((group) => group.id === entity.groupId && group.id !== selected.id);
              return (
                <label key={entity.id} className={checked ? "checked" : ""}>
                  <input type="checkbox" checked={checked} disabled={!canEdit} onChange={() => toggleMember(entity.id)} />
                  <span>{entity.name}</span>
                  {other && <em>现在在「{other.name}」</em>}
                </label>
              );
            })}
            {!definition.entityTypes.length && <p className="empty">草稿里还没有对象类型，先去「本体草稿」建几个。</p>}
          </div>
        </div>
        <div className="functional-actions">
          <button className="action primary" disabled={!canEdit || busy} onClick={saveDraft}><Pencil size={15} />保存分组</button>
          <button className="action danger" disabled={!canEdit || busy} onClick={removeGroup}><Trash2 size={15} />删除分组</button>
        </div>
        <p className="subtle">保存写进当前草稿；发布之后，图谱的「按逻辑分组」与工具 list_concept_groups 才能看到它。</p>
      </> : <div className="graph-inspector-empty"><LayoutGrid size={20} /><b>选择一个概念分组</b><span>左边挑一个分组，这里改名字、颜色，以及它包含哪些对象类型。</span></div>}
    </div>
  </section>;
}
