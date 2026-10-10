"use client";

import { type User, may, type Target, type Version, type RelationshipRow, propertySummary, ResizableManagerGrid, relationshipEndpoints } from "@/components/workbench/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { EntitySearchPicker, type EntitySearchResult } from "@/components/entity-search-picker";
import { PropertyEditor } from "@/components/property-editor";
import { api } from "@/lib/framework/api-client";
import { type RuntimeTypeSet } from "@/lib/framework/graph/types";
import { sourceName } from "@/lib/ontology/draft";





export function RelationshipManager({ target, user, version, draft, runtimeTypes, ensureDraft, onSnapshotChange, notify, fail, relationshipLimit }: { target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; ensureDraft: () => Promise<Version>; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void; relationshipLimit: number }) {
  const [rows, setRows] = useState<RelationshipRow[]>([]);
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [endpointDetails, setEndpointDetails] = useState<Record<string, { labels: string[]; properties: Record<string, unknown> }>>({});
  const [endpointLoading, setEndpointLoading] = useState<Record<string, boolean>>({});
  const [openEnd, setOpenEnd] = useState<"source" | "target" | null>(null);

  const loadEndpoint = useCallback(async (elementId: string) => {
    if (!target || endpointDetails[elementId] || endpointLoading[elementId]) return;
    setEndpointLoading((current) => ({ ...current, [elementId]: true }));
    try {
      const versionParam = version ? `&versionId=${version.id}` : "";
      const entity = await api<{ id: string; labels: string[]; properties: Record<string, unknown> }>(`/api/instances/entities/${encodeURIComponent(elementId)}?targetId=${target.id}${versionParam}`);
      setEndpointDetails((current) => ({ ...current, [elementId]: { labels: entity.labels, properties: entity.properties } }));
    } catch (reason) {
      fail(reason);
    } finally {
      setEndpointLoading((current) => ({ ...current, [elementId]: false }));
    }
  }, [target, version, endpointDetails, endpointLoading, fail]);

  const toggleEnd = (which: "source" | "target", elementId: string) => {
    if (openEnd === which) { setOpenEnd(null); return; }
    setOpenEnd(which);
    void loadEndpoint(elementId);
  };

  const resetEndpoints = () => { setOpenEnd(null); setEndpointDetails({}); setEndpointLoading({}); };

  const load = useCallback(async (nextType: string, nextSearch: string, versionId = version?.id) => {
    if (!target) return;
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (versionId) params.set("versionId", versionId);
      if (nextType) params.set("type", nextType);
      if (nextSearch) params.set("search", nextSearch);
      params.set("limit", String(relationshipLimit));
      setRows(await api<{ rows: RelationshipRow[] }>(`/api/instances/relationships?${params.toString()}`).then((data) => data.rows));
    } catch (reason) { fail(reason); }
  }, [target, version?.id, fail, relationshipLimit]);

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<{ rows: RelationshipRow[] }>(`/api/instances/relationships?targetId=${encodeURIComponent(target.id)}${versionParam}&limit=${relationshipLimit}`).then((data) => setRows(data.rows)).catch(fail);
    // Relationship list is re-fetched when the selected target, version or display limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, relationshipLimit]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const definition = version?.definition ?? null;
  const selectedEnds = selected ? relationshipEndpoints(selected, definition) : null;
  const definitions = selected ? (version?.definition.relationshipTypes.find((item) => item.name === selected.type)?.properties ?? null) : null;
  const managed = Boolean(definitions);

  const save = async () => {
    if (!target || !selected) return;
    try { setBusy(true); const current = await ensureDraft(); const updated = await api<RelationshipRow>(`/api/instances/relationships/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) }); setRows((rows) => rows.map((row) => row.id === updated.id ? updated : row)); await onSnapshotChange(); notify("关系属性已保存到草稿快照。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || !selected) return;
    if (!window.confirm("删除该关系？")) return;
    try { setBusy(true); const current = await ensureDraft(); await api(`/api/instances/relationships/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "DELETE" }); setSelectedId(null); resetEndpoints(); setRows((rows) => rows.filter((row) => row.id !== selected.id)); await onSnapshotChange(); notify("关系已从草稿快照删除。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <ResizableManagerGrid storageKey="ontology.manager-split.relationships">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">关系</span>
      <h2>{rows.length} 条</h2>
      <div className="manager-toolbar">
        <select value={type} onChange={(event) => { setType(event.target.value); void load(event.target.value, search); }}><option value="">全部类型</option>{(runtimeTypes?.relationshipTypes ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(type, search); }} placeholder="搜索关系或端点属性…" />
        <button className="action compact" onClick={() => void load(type, search)}><Search size={14} /></button>
        <button className="action compact" onClick={() => setCreateOpen(true)}><Plus size={14} />新建</button>
      </div>
      <div className="manager-rows">{rows.map((row) => { const ends = relationshipEndpoints(row, definition); return <button key={row.id} className={selectedId === row.id ? "manager-row selected" : "manager-row"} onClick={() => { setSelectedId(row.id); resetEndpoints(); setDraftProps(row.properties); }}><Link2 size={15} /><span><b>{row.type}</b><small>{ends.source || row.sourceId} <span className="arrow">→</span> {ends.target || row.targetId} · {propertySummary(row.properties)}</small></span></button>; })}{!rows.length && <p className="empty">没有匹配的关系。</p>}</div>
    </div>
    <div className="panel functional-panel detail-panel">
      {selected ? <><span className="eyebrow">选中关系</span><h2>{selected.type}</h2><div className="detail-meta"><span>{selectedEnds?.source || selected.sourceId} <span className="arrow">→</span> {selectedEnds?.target || selected.targetId}</span><code>{selected.id}</code></div><div className="endpoint-cards"><EndpointCard side="头对象" elementId={selected.sourceId} displayName={selectedEnds?.source || selected.sourceId} labels={selected.sourceLabels} detail={endpointDetails[selected.sourceId]} loading={Boolean(endpointLoading[selected.sourceId])} open={openEnd === "source"} onToggle={() => toggleEnd("source", selected.sourceId)} /><EndpointCard side="尾对象" elementId={selected.targetId} displayName={selectedEnds?.target || selected.targetId} labels={selected.targetLabels} detail={endpointDetails[selected.targetId]} loading={Boolean(endpointLoading[selected.targetId])} open={openEnd === "target"} onToggle={() => toggleEnd("target", selected.targetId)} /></div>{may(user, "instance.write") ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存到草稿</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />从草稿删除</button></div><p className="subtle">{draft ? "修改当前草稿快照。" : may(user, "ontology.write") ? "首次修改会基于当前发布版本自动创建草稿。" : "当前还没有草稿：创建草稿要「编辑草稿」权限，先让有该权限的账号建一次草稿，或者给当前角色补上这个权限。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}</> : <div className="graph-inspector-empty"><Link2 size={20} /><b>选择一条关系</b><span>点击左侧列表中的关系查看与编辑属性。</span></div>}
    </div>
    {may(user, "instance.write") && createOpen && <RelationshipCreateDialog targetId={target?.id ?? ""} versionId={version?.id ?? ""} published={version} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (type, sourceId, targetId, properties) => { try { if (!target) throw new Error("请先选择本体存储。"); const current = await ensureDraft(); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId: target.id, versionId: current.id, relationshipType: type, sourceId, targetIdValue: targetId, properties }) }); notify("关系已加入草稿快照。"); setCreateOpen(false); await load(type, search, current.id); await onSnapshotChange(); } catch (reason) { fail(reason); } }} />}
  </ResizableManagerGrid>;
}


export function EndpointCard({ side, elementId, displayName, labels, detail, loading, open, onToggle }: { side: string; elementId: string; displayName: string; labels: string[] | undefined; detail: { labels: string[]; properties: Record<string, unknown> } | undefined; loading: boolean; open: boolean; onToggle: () => void }) {
  return <div className="endpoint-card">
    <div className="endpoint-card-head">
      <div className="endpoint-card-title"><span className="endpoint-side">{side}</span><div><b>{displayName}</b><small>{labels?.join(", ") || "无标签"} · <code>{elementId}</code></small></div></div>
      <button className="action compact" onClick={onToggle} disabled={loading}>{loading ? <Loader2 size={13} className="endpoint-spinner" /> : open ? "收起" : "查看属性"}</button>
    </div>
    {open && detail && <div className="endpoint-props">{Object.entries(detail.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div>}
    {open && !detail && !loading && <p className="empty">暂无数据。</p>}
  </div>;
}


export function RelationshipCreateDialog({ targetId, versionId, published, runtimeTypes, onClose, onCreate }: { targetId: string; versionId: string; published: Version | null; runtimeTypes: RuntimeTypeSet | null; onClose: () => void; onCreate: (type: string, sourceId: string, targetId: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [type, setType] = useState("");
  const [source, setSource] = useState<EntitySearchResult | null>(null);
  const [target, setTarget] = useState<EntitySearchResult | null>(null);
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const definitions = published?.definition.relationshipTypes.find((item) => item.name === type)?.properties ?? null;
  const relationDef = published?.definition.relationshipTypes.find((item) => item.name === type) ?? null;
  const sourceName = relationDef ? published?.definition.entityTypes.find((item) => item.id === relationDef.sourceEntityTypeId)?.name : undefined;
  const targetName = relationDef ? published?.definition.entityTypes.find((item) => item.id === relationDef.targetEntityTypeId)?.name : undefined;
  const sourceLabels = sourceName ? [sourceName] : [];
  const targetLabels = targetName ? [targetName] : [];
  const options = useMemo(() => [...new Set([...(published?.definition.relationshipTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.relationshipTypes.map((item) => item.name) ?? [])])], [published, runtimeTypes]);
  const selfLoop = Boolean(source && target && source.id === target.id);
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog dialog-wide" onSubmit={(event) => { event.preventDefault(); if (!type.trim() || !source || !target) return; setBusy(true); void onCreate(type.trim(), source.id, target.id, properties).finally(() => setBusy(false)); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Link2 size={22} /></div><span className="eyebrow">新建关系</span><h2>选择关系类型</h2><label>关系类型<select value={type} onChange={(event) => { setType(event.target.value); setSource(null); setTarget(null); }} required><option value="">选择类型</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><div className="dialog-field"><span>起始对象</span><EntitySearchPicker targetId={targetId} versionId={versionId} labels={sourceLabels} definition={published?.definition ?? null} placeholder="按名称搜索起始对象…" value={source} onChange={setSource} /></div><div className="dialog-field"><span>终止对象</span><EntitySearchPicker targetId={targetId} versionId={versionId} labels={targetLabels} definition={published?.definition ?? null} placeholder="按名称搜索终止对象…" value={target} onChange={setTarget} /></div>{selfLoop && <p className="dialog-hint">起始与终止为同一对象（自环关系）。</p>}<PropertyEditor definitions={definitions ?? []} values={properties} mode="managed" onChange={setProperties} /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!type.trim() || !source || !target || busy}>{busy ? "创建中…" : "创建关系"}</button></div></form></div>;
}
