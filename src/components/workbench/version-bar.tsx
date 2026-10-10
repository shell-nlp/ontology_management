"use client";

import { type User, may, type Version } from "@/components/workbench/shared";
import { useState } from "react";
import { History, Plus, RotateCcw } from "lucide-react";





export function VersionBar({ versions, draft, published, user, onCreate, onActivate, fail }: { versions: Version[]; draft: Version | null; published: Version | null; user: User; onCreate: () => Promise<Version>; onActivate: (version: Version) => Promise<void>; fail: (reason: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const activate = async (version: Version) => {
    if (!window.confirm(`确认将图数据切换到历史版本 v${version.version_number}？当前图数据会由该版本快照完整替换。`)) return;
    try { setBusyId(version.id); await onActivate(version); setOpen(false); } catch (reason) { fail(reason); } finally { setBusyId(null); }
  };
  return (
    <div className="version-bar header-version-bar">
      <div className="version-status">
        <span className={published ? "state-dot" : "state-dot is-unpublished"} aria-hidden="true" />
        <b>{published ? `当前版本 v${published.version_number}` : "尚未发布"}</b>
        {draft && <span className="version-draft">草稿 v{draft.version_number}</span>}
      </div>
      <div className="functional-actions">
        {may(user, "ontology.write") && !draft && <button className="action primary" onClick={() => void onCreate().catch(fail)}><Plus size={14} />创建草稿</button>}
        <button className="action" aria-expanded={open} onClick={() => setOpen((value) => !value)}><History size={14} />版本记录</button>
      </div>
      {open && <div className="version-menu">{versions.map((version) => <div className="version-menu-row" key={version.id}><span><b>v{version.version_number}</b><small>{version.status === "DRAFT" ? "草稿" : version.status === "PUBLISHED" ? "当前生效" : "历史归档"}</small></span><span>{version.entity_count ?? 0} 对象 · {version.relationship_count ?? 0} 关系</span>{version.artifact_path ? <code>{version.content_hash?.slice(0, 10) ?? "snapshot"}</code> : <em>无实例快照</em>}{may(user, "ontology.publish") && version.status === "ARCHIVED" && <button className="action compact" disabled={Boolean(draft) || !version.artifact_path || busyId === version.id} onClick={() => void activate(version)} title={!version.artifact_path ? "旧版本未保存实例快照，不能激活" : draft ? "请先发布当前草稿" : "重新导入该版本快照"}><RotateCcw size={13} />{busyId === version.id ? "切换中" : "激活"}</button>}</div>)}{!versions.length && <p className="empty">尚无版本记录。</p>}</div>}
    </div>
  );
}
