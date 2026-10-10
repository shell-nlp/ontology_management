"use client";

import { ClearGraphDialog } from "@/components/workbench/graph-manager";
import { type User, may, type Target, type Version, type DisplaySettings, DEFAULT_DISPLAY_SETTINGS } from "@/components/workbench/shared";
import { useState } from "react";
import { Eraser, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/framework/api-client";





export function SettingsManager({ target, user, versions, displaySettings, onSaveDisplaySettings, onResetDisplaySettings, onReset, notify, fail }: { target: Target | null; user: User; versions: Version[]; displaySettings: DisplaySettings; onSaveDisplaySettings: (next: DisplaySettings) => void; onResetDisplaySettings: () => void; onReset: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [draft, setDraft] = useState<DisplaySettings>(displaySettings);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const initialize = async () => {
    if (!target) return;
    setResetting(true);
    try {
      const result = await api<{ deletedVersions: number }>(`/api/targets/${target.id}/reset`, { method: "POST" });
      await onReset();
      setConfirmOpen(false);
      notify(`版本数据已初始化：删除 ${result.deletedVersions} 个版本记录及其快照文件。可重新创建草稿以导入当前图数据。`);
    } catch (reason) { fail(reason); } finally { setResetting(false); }
  };

  return <section className="manager-grid">
    <form className="panel functional-panel form-panel" onSubmit={(event) => { event.preventDefault(); onSaveDisplaySettings(draft); notify("展示条数配置已保存。"); }}>
      <span className="eyebrow">列表展示</span>
      <h2>默认展示条数</h2>
      <p className="subtle">「对象」与「关系」列表页每次加载时默认展示的记录数量，保存后即时生效。</p>
      <div className="settings-grid">
        <label className="settings-field"><span>对象展示条数</span><input type="number" min={1} max={10000} value={draft.entityLimit} onChange={(event) => setDraft({ ...draft, entityLimit: Number(event.target.value) })} /><small>对象列表单次加载最多返回的节点数量。</small></label>
        <label className="settings-field"><span>关系展示条数</span><input type="number" min={1} max={10000} value={draft.relationshipLimit} onChange={(event) => setDraft({ ...draft, relationshipLimit: Number(event.target.value) })} /><small>关系列表单次加载最多返回的关系数量。</small></label>
      </div>
      <div className="functional-actions">
        <button type="button" className="action" onClick={() => { onResetDisplaySettings(); setDraft(DEFAULT_DISPLAY_SETTINGS); }}>恢复默认</button>
        <button className="action primary" type="submit">保存配置</button>
      </div>
    </form>
    <div className="panel functional-panel target-list">
      <span className="eyebrow">危险操作</span>
      <h2>版本数据初始化</h2>
      {target ? <>
        <p className="subtle">将当前本体存储「{target.name}」的全部版本记录（共 {versions.length} 个）与对应快照文件删除，回到「尚无版本」状态。图数据不受影响，下次创建草稿时从当前图数据重新导出。</p>
        <div className="functional-actions">
          <button className="action danger" disabled={!may(user, "ontology.publish") || resetting} onClick={() => setConfirmOpen(true)}><RotateCcw size={15} />{resetting ? "初始化中…" : "初始化版本数据"}</button>
        </div>
        <div className="danger-split">
          <h2>清空图数据</h2>
          <p className="subtle">删除「{target.name}」图库里的<b>全部节点与关系</b>（只动图库，平台的版本记录与快照保留）。清空后重新发布一次，就能把快照重新写回图库；适合把演示数据清掉、从干净状态重来。</p>
          <div className="functional-actions">
            <button className="action danger" disabled={!may(user, "ontology.publish")} onClick={() => setClearOpen(true)}><Eraser size={15} />清空图数据</button>
          </div>
        </div>
      </> : <p className="empty">请先选择一个本体存储。</p>}
    </div>
    {clearOpen && target && <ClearGraphDialog target={target} onClose={() => setClearOpen(false)} onCleared={async () => { await onReset(); notify(`「${target.name}」的图数据已清空。重新发布一次即可把快照写回图库。`); }} fail={fail} />}
    {confirmOpen && target && <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); void initialize(); }}><button type="button" className="close-button" onClick={() => setConfirmOpen(false)} title="关闭"><X size={18} /></button><div className="dialog-icon"><RotateCcw size={22} /></div><span className="eyebrow">危险操作</span><h2>初始化「{target.name}」？</h2><p>将删除该本体存储的 {versions.length} 个版本记录及全部快照文件，此操作无法撤销。图数据不会被修改。</p><div className="dialog-actions"><button type="button" className="quiet-button" onClick={() => setConfirmOpen(false)}>取消</button><button className="primary-button" disabled={resetting}>{resetting ? "初始化中…" : "确认初始化"}</button></div></form></div>}
  </section>;
}

/**
 * 清空图数据的确认弹窗。
 *
 * 这是会把图库清空的动作，所以：先统计要删多少、再要求键入本体存储名称才能提交，
 * 并且明确说明平台的版本记录与快照不受影响（重新发布即可写回）。
 */
