"use client";

import { FormEvent, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, BookOpen, CheckCircle2, CircleDot, Database, FileCheck2, GitBranch, Link2, Loader2, LogOut, Network, Pencil, Plus, Search, Settings2, ShieldCheck, TableProperties, Trash2, UserRound, X } from "lucide-react";
import { GraphCanvas } from "@/components/graph-canvas";
import { PropertyEditor } from "@/components/property-editor";
import type { GraphData } from "@/lib/neo4j";
import type { RuntimeTypeSet } from "@/lib/instances";

type User = { id: string; email: string; role: "ADMIN" | "VIEWER" };
type Target = { id: string; name: string; uri: string; databaseName: string; username: string };
type Property = { name: string; dataType: "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "DATETIME" | "TEXT_ARRAY" | "JSON"; required: boolean; unique: boolean; indexed: boolean };
type EntityType = { id: string; name: string; description: string; displayProperty?: string; properties: Property[] };
type RelationType = { id: string; name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
type Definition = { entityTypes: EntityType[]; relationshipTypes: RelationType[] };
type Version = { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: Definition };
type View = "overview" | "ontology" | "graph" | "entities" | "relations" | "targets";
type QueryResult = { keys: string[]; records: Record<string, unknown>[]; graph: GraphData; summary: string };
type EntityRow = { id: string; labels: string[]; properties: Record<string, unknown> };
type RelationshipRow = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; sourceLabels?: string[]; sourceProperties?: Record<string, unknown>; targetLabels?: string[]; targetProperties?: Record<string, unknown> };

const emptyDefinition: Definition = { entityTypes: [], relationshipTypes: [] };
const typeOptions: Property["dataType"][] = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function Notice({ message, error }: { message: string | null; error?: boolean }) {
  if (!message) return null;
  return <div className={error ? "notice error" : "notice"}>{error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{message}</div>;
}

function entityTitle(node: Pick<EntityRow, "labels" | "properties">) {
  const preferred = ["name", "名称", "title", "id"].map((key) => node.properties[key]).find((value) => typeof value === "string" || typeof value === "number");
  return String(preferred ?? node.labels[0] ?? "未命名");
}

function propertySummary(properties: Record<string, unknown>, limit = 3) {
  const entries = Object.entries(properties).filter(([key]) => key !== "fx" && key !== "fy");
  return entries.slice(0, limit).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
}

type GraphSettings = { nodeLimit: number; maxNeighbors: number; recordLimit: number };
const DEFAULT_GRAPH_SETTINGS: GraphSettings = { nodeLimit: 300, maxNeighbors: 200, recordLimit: 5000 };
const GRAPH_SETTINGS_KEY = "atlas.graph-settings";

function clampLimit(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function loadGraphSettings(): GraphSettings {
  if (typeof window === "undefined") return DEFAULT_GRAPH_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRAPH_SETTINGS_KEY) ?? "{}") as Partial<GraphSettings>;
    return {
      nodeLimit: clampLimit(parsed.nodeLimit, DEFAULT_GRAPH_SETTINGS.nodeLimit, 1, 10000),
      maxNeighbors: clampLimit(parsed.maxNeighbors, DEFAULT_GRAPH_SETTINGS.maxNeighbors, 1, 10000),
      recordLimit: clampLimit(parsed.recordLimit, DEFAULT_GRAPH_SETTINGS.recordLimit, 1, 100000),
    };
  } catch { return DEFAULT_GRAPH_SETTINGS; }
}

function useGraphSettings() {
  const [settings, setSettings] = useState<GraphSettings>(loadGraphSettings);
  const update = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((current) => {
      const next: GraphSettings = {
        nodeLimit: clampLimit(patch.nodeLimit, current.nodeLimit, 1, 10000),
        maxNeighbors: clampLimit(patch.maxNeighbors, current.maxNeighbors, 1, 10000),
        recordLimit: clampLimit(patch.recordLimit, current.recordLimit, 1, 100000),
      };
      try { window.localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(GRAPH_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_GRAPH_SETTINGS); }, []);
  return { settings, update, reset };
}

function capResult(result: QueryResult, recordLimit: number): QueryResult {
  return { ...result, records: result.records.slice(0, recordLimit), graph: { nodes: result.graph.nodes.slice(0, recordLimit), relationships: result.graph.relationships.slice(0, recordLimit) } };
}

function GraphSettingsDialog({ settings, onSave, onReset, onClose }: { settings: GraphSettings; onSave: (next: GraphSettings) => void; onReset: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  const field = (key: keyof GraphSettings, label: string, note: string, max: number) => (
    <label className="settings-field" key={key}>
      <span>{label}</span>
      <input type="number" min={1} max={max} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />
      <small>{note}</small>
    </label>
  );
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); onSave(draft); onClose(); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><Settings2 size={22} /></div>
        <span className="eyebrow">可视化配置</span>
        <h2>图谱渲染限制</h2>
        <p>默认不会一次性加载全部图数据，按下述上限控制每次取数规模。</p>
        <div className="settings-grid">
          {field("nodeLimit", "可视化节点上限", "首次加载与刷新时最多渲染的节点数。", 10000)}
          {field("maxNeighbors", "最大新增邻居数", "扩展一度邻居时最多加入的邻居数量。", 10000)}
          {field("recordLimit", "单次记录上限", "单条 Cypher 查询最多获取并展示的记录条数。", 100000)}
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onReset}>恢复默认</button>
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit">保存配置</button>
        </div>
      </form>
    </div>
  );
}

export function FunctionalWorkbench() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState("");
  const [draft, setDraft] = useState<Version | null>(null);
  const [published, setPublished] = useState<Version | null>(null);
  const [runtimeTypes, setRuntimeTypes] = useState<RuntimeTypeSet | null>(null);
  const [view, setView] = useState<View>("overview");
  const [graphMode, setGraphMode] = useState<"instances" | "ontology">("instances");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedTarget = targets.find((target) => target.id === targetId) ?? null;
  const definition = draft?.definition ?? published?.definition ?? emptyDefinition;

  const notify = (text: string) => { setMessage(text); setError(null); if (messageTimer.current) clearTimeout(messageTimer.current); messageTimer.current = setTimeout(() => setMessage(null), 5000); };
  const fail = (reason: unknown) => { setError(reason instanceof Error ? reason.message : "操作失败。"); setMessage(null); if (messageTimer.current) clearTimeout(messageTimer.current); };

  const loadTargets = async () => {
    const data = await api<Target[]>("/api/targets");
    setTargets(data);
    setTargetId((current) => current || data[0]?.id || "");
  };

  const loadVersions = async (id: string) => {
    if (!id) return;
    const versions = await api<Version[]>(`/api/ontology?targetId=${encodeURIComponent(id)}`);
    setDraft(versions.find((item) => item.status === "DRAFT") ?? null);
    setPublished(versions.find((item) => item.status === "PUBLISHED") ?? null);
  };

  useEffect(() => {
    api<{ user: User | null }>("/api/auth/session").then(async (data) => {
      setUser(data.user);
      if (data.user) await loadTargets();
    }).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!targetId) return;
    void api<Version[]>(`/api/ontology?targetId=${encodeURIComponent(targetId)}`).then((versions) => {
      setDraft(versions.find((item) => item.status === "DRAFT") ?? null);
      setPublished(versions.find((item) => item.status === "PUBLISHED") ?? null);
    }).catch(fail);
    void api<RuntimeTypeSet>(`/api/instances/types?targetId=${encodeURIComponent(targetId)}`).then(setRuntimeTypes).catch(() => setRuntimeTypes(null));
  }, [targetId]);

  const ensureDraft = async () => {
    if (!targetId) throw new Error("请先登记并选择一个 Neo4j 目标。");
    if (draft) return draft;
    const result = await api<{ id: string; versionNumber: number }>("/api/ontology", { method: "POST", body: JSON.stringify({ targetId, definition: published?.definition ?? emptyDefinition }) });
    const next: Version = { id: result.id, target_id: targetId, version_number: result.versionNumber, status: "DRAFT", definition: published?.definition ?? emptyDefinition };
    setDraft(next);
    notify(`已创建草稿 v${result.versionNumber}。`);
    return next;
  };

  const saveDefinition = async (next: Definition) => {
    const current = await ensureDraft();
    const saved = await api<{ definition: Definition }>(`/api/ontology/${current.id}`, { method: "PATCH", body: JSON.stringify({ definition: next }) });
    setDraft({ ...current, definition: saved.definition });
    notify("草稿已保存到 PostgreSQL。");
  };

  const validate = async () => {
    try { const current = await ensureDraft(); const result = await api<{ valid: boolean; violations: { message: string; count: number }[] }>(`/api/ontology/${current.id}/validate`, { method: "POST" }); result.valid ? notify("草稿校验通过，可以发布。") : fail(result.violations.map((item) => `${item.message} (${item.count})`).join("；")); } catch (reason) { fail(reason); }
  };

  const publish = async () => {
    try { const current = await ensureDraft(); const result = await api<{ published: boolean; communityEdition?: boolean; violations?: { message: string; count: number }[] }>(`/api/ontology/${current.id}/publish`, { method: "POST" }); if (result.published) { notify(result.communityEdition ? "本体已发布。当前为 Neo4j Community，必填属性由发布时校验保证，未创建数据库约束。" : "本体已发布，实例管理现在可以使用该类型。 "); await loadVersions(targetId); } } catch (reason) { fail(reason); }
  };

  if (user === undefined) return <div className="loading-screen">正在加载 Ontology...</div>;
  if (!user) return <Login onSuccess={async (next) => { setUser(next); await loadTargets(); }} />;

  const userProp = user;

  return <main className="functional-shell">
    <aside className="functional-sidebar"><div className="functional-brand"><GitBranch size={23} /><span><b>ONTOLOGY</b><small>GRAPH GOVERNANCE</small></span></div><label className="target-picker"><span>当前 Neo4j 目标</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择目标</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><nav>{([
      ["overview", "总览", Activity], ["ontology", "本体草稿", BookOpen], ["graph", "图谱", Network], ["entities", "实体", CircleDot], ["relations", "关系", Link2], ["targets", "连接目标", Database],
    ] as const).map(([id, label, Icon]) => <button key={id} className={view === id ? "functional-nav selected" : "functional-nav"} onClick={() => { if (id === "graph") setGraphMode("instances"); setView(id); }}><Icon size={17} />{label}</button>)}</nav><div className="functional-user"><UserRound size={17} /><span><b>{user.email}</b><small>{user.role === "ADMIN" ? "管理员" : "查看者"}</small></span><button title="退出登录" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setUser(null); }}><LogOut size={16} /></button></div></aside>
    <section className="functional-content"><header><div><p>图谱治理 / {view}</p><h1>{selectedTarget?.name ?? "连接 Neo4j 目标"}</h1></div><div className="header-state">{selectedTarget ? <><span className="state-dot" />已选择目标</> : "需要登记目标"}</div></header><Notice message={error ?? message} error={Boolean(error)} />
      {view === "overview" && <Overview target={selectedTarget} draft={draft} published={published} runtimeTypes={runtimeTypes} onNavigate={setView} onOpenOntology={() => { setGraphMode("ontology"); setView("graph"); }} />}
      {view === "targets" && <TargetManager targets={targets} refresh={loadTargets} onSelect={(id) => { setTargetId(id); setView("overview"); }} notify={notify} fail={fail} />}
      {view === "ontology" && <OntologyManager definition={definition} draft={draft} user={userProp} save={saveDefinition} validate={validate} publish={publish} notify={notify} fail={fail} />}
      {view === "graph" && <GraphManager target={selectedTarget} user={userProp} published={published} runtimeTypes={runtimeTypes} mode={graphMode} onModeChange={setGraphMode} notify={notify} fail={fail} />}
      {view === "entities" && <EntityManager target={selectedTarget} user={userProp} published={published} runtimeTypes={runtimeTypes} notify={notify} fail={fail} />}
      {view === "relations" && <RelationshipManager target={selectedTarget} user={userProp} published={published} runtimeTypes={runtimeTypes} notify={notify} fail={fail} />}
    </section>
  </main>;
}

function Login({ onSuccess }: { onSuccess: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState("admin@example.com"); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  return <main className="login-screen"><form className="login-card" onSubmit={async (event) => { event.preventDefault(); try { setError(""); const user = await api<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); await onSuccess(user); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } }}><div className="login-mark"><GitBranch size={25} /></div><p>ONTOLOGY CONTROL</p><h1>登录本体平台</h1><label>邮箱<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required autoFocus /></label><Notice message={error || null} error /><button className="action primary" type="submit">登录</button></form></main>;
}

function Overview({ target, draft, published, runtimeTypes, onNavigate, onOpenOntology }: { target: Target | null; draft: Version | null; published: Version | null; runtimeTypes: RuntimeTypeSet | null; onNavigate: (view: View) => void; onOpenOntology: () => void }) {
  const entityTypes = published?.definition.entityTypes.length ?? runtimeTypes?.labels.length ?? 0;
  const relationshipTypes = published?.definition.relationshipTypes.length ?? runtimeTypes?.relationshipTypes.length ?? 0;
  const entities = runtimeTypes?.entityCount ?? runtimeTypes?.labels.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const relationships = runtimeTypes?.relationshipCount ?? runtimeTypes?.relationshipTypes.reduce((sum, item) => sum + item.count, 0) ?? 0;
  return <section className="panel functional-panel overview-panel"><span className="eyebrow">本体控制室</span><h2>{target ? "本体与运行时状态" : "开始登记第一个目标"}</h2>{target ? <><div className="overview-stats"><div className="overview-stat"><b>{entityTypes}</b><span>实体类型</span><small>已发布本体定义</small></div><div className="overview-stat"><b>{entities}</b><span>实体</span><small>数据库中的节点</small></div><div className="overview-stat"><b>{relationshipTypes}</b><span>关系类型</span><small>已发布本体定义</small></div><div className="overview-stat"><b>{relationships}</b><span>关系</span><small>数据库中的关系</small></div></div><div className="overview-status"><span>草稿：<b>{draft ? `v${draft.version_number}` : "无"}</b></span><span>已发布：<b>{published ? `v${published.version_number}` : "无"}</b></span></div></> : <p>先在“连接目标”登记 Neo4j URI、数据库、用户名与密码。密码会加密保存。</p>}<div className="functional-actions">{target && <button className="action" onClick={() => onNavigate("graph")}><Network size={16} />打开图谱管理</button>}{target && <button className="action" onClick={() => onNavigate("ontology")}><BookOpen size={16} />配置本体草稿</button>}<button className="action primary" onClick={() => target ? onOpenOntology() : onNavigate("targets")}><span className="arrow">→</span>{target ? "查看本体" : "登记 Neo4j 目标"}</button></div></section>;
}

function TargetManager({ targets, refresh, onSelect, notify, fail }: { targets: Target[]; refresh: () => Promise<void>; onSelect: (id: string) => void; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [form, setForm] = useState({ name: "", uri: "bolt://", databaseName: "neo4j", username: "neo4j", password: "" }); const [testing, setTesting] = useState(""); const [editing, setEditing] = useState<Target | null>(null); const [deleting, setDeleting] = useState("");
  const add = async (event: FormEvent) => { event.preventDefault(); try { const target = await api<Target>("/api/targets", { method: "POST", body: JSON.stringify(form) }); await refresh(); onSelect(target.id); notify("Neo4j 目标已登记，密码已加密保存。"); setForm({ name: "", uri: "bolt://", databaseName: "neo4j", username: "neo4j", password: "" }); } catch (reason) { fail(reason); } };
  const remove = async (target: Target) => { if (!window.confirm(`确定删除目标“${target.name}”及其全部本体版本？`)) return; try { setDeleting(target.id); await api(`/api/targets/${target.id}`, { method: "DELETE" }); notify("目标已删除。"); await refresh(); } catch (reason) { fail(reason); } finally { setDeleting(""); } };
  return <section className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={add}><span className="eyebrow">登记目标</span><h2>新建 Neo4j 连接</h2><label>目标名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：生产知识图谱" required /></label><label>Neo4j URI<input value={form.uri} onChange={(event) => setForm({ ...form, uri: event.target.value })} placeholder="neo4j+s://host:7687" required /></label><label>数据库名称<input value={form.databaseName} onChange={(event) => setForm({ ...form, databaseName: event.target.value })} required /></label><label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label><label>密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label><button className="action primary"><Plus size={16} />登记并选择</button></form><div className="panel functional-panel target-list"><span className="eyebrow">已登记目标</span><h2>{targets.length} 个目标</h2>{targets.length ? targets.map((target) => <div className="target-row" key={target.id}><Database size={18} /><span><b>{target.name}</b><small>{target.uri} / {target.databaseName}</small></span><button className="action compact" disabled={testing === target.id} onClick={async () => { try { setTesting(target.id); const info = await api<{ connected: boolean; agent: string }>(`/api/targets/${target.id}/test`, { method: "POST" }); notify(`连接成功：${info.agent}`); } catch (reason) { fail(reason); } finally { setTesting(""); } }}>{testing === target.id ? "测试中" : "测试连接"}</button><button className="action compact" onClick={() => setEditing(target)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={deleting === target.id} onClick={() => void remove(target)}><Trash2 size={13} />{deleting === target.id ? "删除中" : "删除"}</button></div>) : <p className="empty">尚未登记目标。</p>}</div>{editing && <TargetEditDialog target={editing} onClose={() => setEditing(null)} onSaved={async () => { await refresh(); notify("目标已更新。"); }} fail={fail} />}</section>;
}

function TargetEditDialog({ target, onClose, onSaved, fail }: { target: Target; onClose: () => void; onSaved: () => Promise<void>; fail: (reason: unknown) => void }) {
  const [form, setForm] = useState({ name: target.name, uri: target.uri, databaseName: target.databaseName, username: target.username, password: "" });
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => { event.preventDefault(); try { setBusy(true); const payload: Record<string, string> = { name: form.name, uri: form.uri, databaseName: form.databaseName, username: form.username }; if (form.password) payload.password = form.password; await api<Target>(`/api/targets/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) }); await onSaved(); onClose(); } catch (reason) { fail(reason); } finally { setBusy(false); } };
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={save}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Database size={22} /></div><span className="eyebrow">编辑目标</span><h2>{target.name}</h2><p>修改连接信息，留空密码表示保持原密码不变。</p><label>目标名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label><label>Neo4j URI<input value={form.uri} onChange={(event) => setForm({ ...form, uri: event.target.value })} placeholder="neo4j+s://host:7687" required /></label><label>数据库名称<input value={form.databaseName} onChange={(event) => setForm({ ...form, databaseName: event.target.value })} required /></label><label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label><label>密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder="留空保持不变" /></label><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存修改"}</button></div></form></div>;
}

function OntologyManager({ definition, draft, user, save, validate, publish, notify, fail }: { definition: Definition; draft: Version | null; user: User; save: (definition: Definition) => Promise<void>; validate: () => Promise<void>; publish: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [rel, setRel] = useState({ name: "", source: "", target: "" });
  const [editingEntity, setEditingEntity] = useState<EntityType | null>(null);
  const [editingRelation, setEditingRelation] = useState<RelationType | null>(null);
  const [tab, setTab] = useState<"entity" | "relation">("entity");
  const switchTab = (next: "entity" | "relation") => { setTab(next); };
  const addEntity = async (event: FormEvent) => { event.preventDefault(); try { if (!name.trim()) return; if (definition.entityTypes.some((item) => item.name === name.trim())) throw new Error("实体类型名称已存在。"); await save({ ...definition, entityTypes: [...definition.entityTypes, { id: crypto.randomUUID(), name: name.trim(), description: description.trim(), properties: [] }] }); setName(""); setDescription(""); } catch (reason) { fail(reason); } };
  const addRelation = async (event: FormEvent) => { event.preventDefault(); try { if (!rel.name || !rel.source || !rel.target) throw new Error("请填写关系类型和两个端点。"); await save({ ...definition, relationshipTypes: [...definition.relationshipTypes, { id: crypto.randomUUID(), name: rel.name, sourceEntityTypeId: rel.source, targetEntityTypeId: rel.target, properties: [] }] }); setRel({ name: "", source: "", target: "" }); } catch (reason) { fail(reason); } };
  const updateEntity = async (id: string, patch: { name: string; description: string; displayProperty?: string; properties: Property[] }) => { try { const next = structuredClone(definition); const idx = next.entityTypes.findIndex((item) => item.id === id); if (idx < 0) return; if (next.entityTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("实体类型名称已存在。"); next.entityTypes[idx] = { ...next.entityTypes[idx], name: patch.name.trim(), description: patch.description.trim(), displayProperty: (patch.displayProperty ?? "").trim(), properties: patch.properties }; await save(next); notify("实体类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const updateRelation = async (id: string, patch: { name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] }) => { try { const next = structuredClone(definition); const idx = next.relationshipTypes.findIndex((item) => item.id === id); if (idx < 0) return; if (next.relationshipTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("关系类型名称已存在。"); next.relationshipTypes[idx] = { ...next.relationshipTypes[idx], name: patch.name.trim(), sourceEntityTypeId: patch.sourceEntityTypeId, targetEntityTypeId: patch.targetEntityTypeId, properties: patch.properties }; await save(next); notify("关系类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const copyGrass = async () => {
    const rules = definition.entityTypes.filter((item) => item.displayProperty).map((item) => `node.${item.name} {\n  caption: "{${item.displayProperty}}";\n}`);
    const content = ["/* Ontology 导出：Neo4j Browser 样式（GraSS）。运行 :style 打开样式查看器，粘贴以下规则或另存为 .grass 后拖入即可。 */", ...rules].join("\n");
    try { await navigator.clipboard.writeText(content); notify("已复制 Neo4j Browser 显示样式规则。"); } catch (reason) { fail(reason); }
  };
  return <section className="stack"><div className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">本体草稿</span><h2>{draft ? `v${draft.version_number} · 未发布` : "尚无草稿"}</h2></div><div className="functional-actions"><button className="action" onClick={() => void copyGrass()} title="生成可在 Neo4j Browser 样式查看器（:style）使用的节点 caption 规则"><TableProperties size={16} />复制显示样式</button><button className="action" disabled={user.role !== "ADMIN"} onClick={() => validate().catch(fail)}><FileCheck2 size={16} />校验</button><button className="action primary" disabled={user.role !== "ADMIN"} onClick={() => publish().catch(fail)}><ShieldCheck size={16} />发布</button></div></div><p className="subtle">类型修改会先保存为草稿；发布前将检查既有 Neo4j 数据、端点契约和必填属性。请先在下方切换到「实体类型」或「关系类型」标签，再对单个类型点击「编辑」一并配置其属性。</p></div><div className="graph-view-switcher" aria-label="本体编辑视图"><button className={tab === "entity" ? "active" : ""} aria-pressed={tab === "entity"} onClick={() => switchTab("entity")}>实体类型</button><button className={tab === "relation" ? "active" : ""} aria-pressed={tab === "relation"} onClick={() => switchTab("relation")}>关系类型</button></div>{tab === "entity" ? <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addEntity}><span className="eyebrow">实体类型</span><h2>新增实体类型</h2><label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户" required /></label><label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label><button className="action primary"><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">实体类型清单</span><h2>{definition.entityTypes.length} 个实体类型</h2>{definition.entityTypes.map((item) => <div className="type-row" key={item.id}><CircleDot size={17} /><b>{item.name}</b><span>{item.description || "未填写说明"}</span><em>{item.properties.length} 属性</em><button className="action compact" disabled={user.role !== "ADMIN"} onClick={() => setEditingEntity(item)}><Pencil size={13} />编辑</button></div>)}{!definition.entityTypes.length && <p className="empty">尚未创建实体类型。</p>}</div></div> : <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addRelation}><span className="eyebrow">关系契约</span><h2>新增关系类型</h2><label>关系名称<input value={rel.name} onChange={(event) => setRel({ ...rel, name: event.target.value })} placeholder="例如：负责" required /></label><label>起始实体类型<select value={rel.source} onChange={(event) => setRel({ ...rel, source: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>终止实体类型<select value={rel.target} onChange={(event) => setRel({ ...rel, target: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="action primary"><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">关系契约清单</span><h2>{definition.relationshipTypes.length} 个关系类型</h2>{definition.relationshipTypes.map((item) => <div className="type-row" key={item.id}><Link2 size={17} /><b>{item.name}</b><span>{definition.entityTypes.find((e) => e.id === item.sourceEntityTypeId)?.name ?? "?"} → {definition.entityTypes.find((e) => e.id === item.targetEntityTypeId)?.name ?? "?"}</span><em>{item.properties.length} 属性</em><button className="action compact" disabled={user.role !== "ADMIN"} onClick={() => setEditingRelation(item)}><Pencil size={13} />编辑</button></div>)}{!definition.relationshipTypes.length && <p className="empty">尚未创建关系类型。</p>}</div></div>}{editingEntity && <TypeEditDialog kind="entity" entity={editingEntity} entityTypes={definition.entityTypes} onClose={() => setEditingEntity(null)} onSave={async (payload) => { await updateEntity(editingEntity.id, { name: payload.name, description: payload.description ?? "", displayProperty: payload.displayProperty ?? "", properties: payload.properties }); setEditingEntity(null); }} />}{editingRelation && <TypeEditDialog kind="relation" relation={editingRelation} entityTypes={definition.entityTypes} onClose={() => setEditingRelation(null)} onSave={async (payload) => { await updateRelation(editingRelation.id, { name: payload.name, sourceEntityTypeId: payload.sourceEntityTypeId ?? "", targetEntityTypeId: payload.targetEntityTypeId ?? "", properties: payload.properties }); setEditingRelation(null); }} />}</section>;
}

function TypeEditDialog({ kind, entity, relation, entityTypes, onClose, onSave }: { kind: "entity" | "relation"; entity?: EntityType | null; relation?: RelationType | null; entityTypes: EntityType[]; onClose: () => void; onSave: (payload: { name: string; description?: string; displayProperty?: string; sourceEntityTypeId?: string; targetEntityTypeId?: string; properties: Property[] }) => Promise<void> }) {
  const [name, setName] = useState(kind === "entity" ? entity?.name ?? "" : relation?.name ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [displayProperty, setDisplayProperty] = useState(kind === "entity" ? entity?.displayProperty ?? "" : "");
  const [source, setSource] = useState(relation?.sourceEntityTypeId ?? "");
  const [target, setTarget] = useState(relation?.targetEntityTypeId ?? "");
  const [properties, setProperties] = useState<Property[]>(kind === "entity" ? entity?.properties ?? [] : relation?.properties ?? []);
  const [propName, setPropName] = useState(""); const [dataType, setDataType] = useState<Property["dataType"]>("TEXT"); const [required, setRequired] = useState(false);
  const [editingProp, setEditingProp] = useState<number | null>(null);
  const [propDraft, setPropDraft] = useState<Property | null>(null);
  const [localError, setLocalError] = useState("");
  const [busy, setBusy] = useState(false);

  const addProperty = (event: FormEvent) => { event.preventDefault(); try { const trimmed = propName.trim(); if (!trimmed) throw new Error("请填写属性名称。"); if (properties.some((item) => item.name === trimmed)) throw new Error("属性名称已存在。"); const prop: Property = { name: trimmed, dataType, required, unique: false, indexed: false }; setProperties((current) => [...current, prop]); setPropName(""); setLocalError(""); } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "添加属性失败。"); } };
  const startEditProperty = (index: number) => { setEditingProp(index); setPropDraft({ ...properties[index] }); setLocalError(""); };
  const saveProperty = () => { try { const draft = propDraft; if (!draft) return; const trimmed = draft.name.trim(); if (!trimmed) throw new Error("请填写属性名称。"); if (properties.some((item, i) => i !== editingProp && item.name === trimmed)) throw new Error("属性名称已存在。"); setProperties((current) => current.map((item, i) => i === editingProp ? { ...draft, name: trimmed } : item)); setEditingProp(null); setPropDraft(null); setLocalError(""); } catch (reason) { setLocalError(reason instanceof Error ? reason.message : "保存属性失败。"); } };
  const removeProperty = (index: number) => { const removed = properties[index]; setProperties((current) => current.filter((_, i) => i !== index)); if (removed && displayProperty === removed.name) setDisplayProperty(""); if (editingProp === index) { setEditingProp(null); setPropDraft(null); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onSave(kind === "entity" ? { name, description, displayProperty, properties } : { name, sourceEntityTypeId: source, targetEntityTypeId: target, properties }); onClose(); } finally { setBusy(false); } };
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog type-dialog" onSubmit={submit}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon">{kind === "entity" ? <CircleDot size={22} /> : <Link2 size={22} />}</div><span className="eyebrow">{kind === "entity" ? "实体类型" : "关系契约"}</span><h2>编辑{kind === "entity" ? "实体类型" : "关系类型"}</h2><label>名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label>{kind === "entity" ? <><label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label><label>显示属性<select value={displayProperty} onChange={(event) => setDisplayProperty(event.target.value)}><option value="">默认（按 name/名称/title/id 自动选择）</option>{properties.map((prop) => <option key={prop.name} value={prop.name}>{prop.name}</option>)}</select><small>节点在可视化中的标题；在本体草稿页「复制显示样式」可导出对应 Neo4j Browser caption 规则。</small></label></> : <><label>起始实体类型<select value={source} onChange={(event) => setSource(event.target.value)} required><option value="">选择类型</option>{entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>终止实体类型<select value={target} onChange={(event) => setTarget(event.target.value)} required><option value="">选择类型</option>{entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></>}<div className="dialog-divider" /><div className="dialog-section-head"><span className="eyebrow">属性配置</span><h3>{kind === "entity" ? "实体属性" : "关系属性"}</h3></div><p className="dialog-hint">在同一处维护该类型全部属性，保存时一并写入草稿。</p>{properties.length > 0 && <div className="dialog-prop-list">{properties.map((prop, index) => editingProp === index && propDraft ? <div className="dialog-prop-row editing" key={`${prop.name}-${index}`}><input value={propDraft.name} onChange={(event) => setPropDraft({ ...propDraft, name: event.target.value })} /><select value={propDraft.dataType} onChange={(event) => setPropDraft({ ...propDraft, dataType: event.target.value as Property["dataType"] })}>{typeOptions.map((item) => <option key={item}>{item}</option>)}</select><label className="check-label"><input type="checkbox" checked={propDraft.required} onChange={(event) => setPropDraft({ ...propDraft, required: event.target.checked })} />必填</label><button type="button" className="action compact" onClick={saveProperty}><CheckCircle2 size={13} />保存</button><button type="button" className="action compact" onClick={() => { setEditingProp(null); setPropDraft(null); setLocalError(""); }}>取消</button></div> : <div className="dialog-prop-row" key={`${prop.name}-${index}`}><TableProperties size={15} /><b>{prop.name}</b><span>{prop.dataType}</span><em>{prop.required ? "必填" : "可选"}</em><button type="button" className="action compact" onClick={() => startEditProperty(index)}><Pencil size={12} />编辑</button><button type="button" className="action compact danger" onClick={() => removeProperty(index)}><Trash2 size={12} />删除</button></div>)}</div>}<form className="inline-form dialog-prop-add" onSubmit={addProperty}><input value={propName} onChange={(event) => setPropName(event.target.value)} placeholder="新属性名称" /><select value={dataType} onChange={(event) => setDataType(event.target.value as Property["dataType"])}>{typeOptions.map((item) => <option key={item}>{item}</option>)}</select><label className="check-label"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />必填</label><button className="action primary"><Plus size={14} />添加属性</button></form>{localError && <p className="dialog-error">{localError}</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存修改"}</button></div></form></div>;
}

type CypherSuggestion = { text: string; kind: string };
const CYPHER_KEYWORDS = ["MATCH", "OPTIONAL MATCH", "WHERE", "WITH", "RETURN", "UNWIND", "ORDER BY", "SKIP", "LIMIT", "UNION", "CREATE", "MERGE", "SET", "REMOVE", "DELETE", "DETACH DELETE", "CALL", "YIELD", "AS", "DISTINCT", "USING", "INDEX", "EXISTS", "EXPLAIN", "PROFILE", "FOREACH", "LOAD CSV", "START", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "XOR", "IN", "IS NULL", "IS NOT NULL", "CONTAINS", "STARTS WITH", "ENDS WITH"];
const CYPHER_FUNCTIONS = ["count", "sum", "avg", "min", "max", "collect", "count(*)", "coalesce", "exists", "size", "length", "keys", "properties", "labels", "type", "elementId", "id", "startNode", "endNode", "toString", "toInteger", "toFloat", "toBoolean", "toUpper", "toLower", "trim", "ltrim", "rtrim", "substring", "replace", "split", "left", "right", "reverse", "head", "last", "tail", "range", "reduce", "abs", "ceil", "floor", "round", "sign", "sqrt", "exp", "log", "log10", "rand", "pi", "date", "datetime", "time", "duration", "point", "distance", "randomUUID", "timestamp"];
const DEFAULT_CYPHER_SUGGESTIONS: CypherSuggestion[] = ["MATCH", "OPTIONAL MATCH", "WHERE", "WITH", "RETURN", "UNWIND", "ORDER BY", "LIMIT", "SKIP", "CREATE", "MERGE", "SET", "REMOVE", "DELETE", "CALL", "YIELD", "DISTINCT", "CASE", "FOREACH"].map((text) => ({ text, kind: "关键字" }));

function cypherFilter(items: string[], partial: string, kind: string): CypherSuggestion[] {
  const p = partial.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(p)).map((item) => {
    const lower = item.toLowerCase();
    return { text: item, kind, score: (lower.startsWith(p) ? 0 : 1) + lower.indexOf(p) / 1000 };
  }).sort((a, b) => a.score - b.score).map(({ text, kind: k }) => ({ text, kind: k }));
}

function CypherEditor({ value, onChange, labels, relationshipTypes, propertyKeys, placeholder }: { value: string; onChange: (next: string) => void; labels: string[]; relationshipTypes: string[]; propertyKeys: string[]; placeholder?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [wordStart, setWordStart] = useState(0);
  const [suggestions, setSuggestions] = useState<CypherSuggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const refresh = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    setCaret(cursor);
    const before = textarea.value.slice(0, cursor);
    const match = /[\p{L}\p{N}_]+$/u.exec(before);
    const word = match ? match[0] : "";
    const start = match ? cursor - word.length : cursor;
    const head = before.slice(0, start);
    const trimmed = head.trimEnd();
    const prev = trimmed[trimmed.length - 1] ?? "";
    let list: CypherSuggestion[];
    if (prev === ".") {
      list = cypherFilter(propertyKeys, word, "属性").slice(0, 12);
    } else if (prev === ":") {
      const inBrackets = (head.match(/\[/g) ?? []).length > (head.match(/\]/g) ?? []).length;
      list = cypherFilter(inBrackets ? relationshipTypes : labels, word, inBrackets ? "关系" : "标签").slice(0, 12);
    } else if (!word) {
      list = DEFAULT_CYPHER_SUGGESTIONS;
    } else {
      list = [...cypherFilter(CYPHER_KEYWORDS, word, "关键字"), ...cypherFilter(CYPHER_FUNCTIONS, word, "函数")].slice(0, 12);
    }
    setWordStart(start);
    setSuggestions(list);
    setHighlight(0);
  }, [labels, relationshipTypes, propertyKeys]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const marker = markerRef.current;
    if (!textarea || !marker || suggestions.length === 0) { setPos(null); return; }
    const rect = marker.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    setPos({ top: rect.top - textarea.scrollTop + lineHeight + 4, left: rect.left - textarea.scrollLeft });
  }, [caret, suggestions]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(event.target as Node)) setSuggestions([]); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const accept = (suggestion: CypherSuggestion) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = textarea.value.slice(0, wordStart);
    const after = textarea.value.slice(textarea.selectionStart);
    const insert = suggestion.text + (suggestion.kind === "关键字" ? " " : "");
    const next = before + insert + after;
    onChange(next);
    setSuggestions([]);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const position = (before + insert).length;
      textarea.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((h) => (h + 1) % Math.min(suggestions.length, 8)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => (h - 1 + Math.min(suggestions.length, 8)) % Math.min(suggestions.length, 8)); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); accept(suggestions[highlight] ?? suggestions[0]); }
    else if (event.key === "Escape") { setSuggestions([]); }
  };

  return <div className="cypher-editor" ref={containerRef}><div className="cypher-input cypher-mirror" aria-hidden="true">{value.slice(0, caret)}<span ref={markerRef}>&#8203;</span>{value.slice(caret)}</div><textarea ref={textareaRef} className="cypher-input" value={value} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => onChange(event.target.value)} onSelect={refresh} onKeyUp={refresh} onClick={refresh} onKeyDown={onKeyDown} />{suggestions.length > 0 && pos && <div className="cypher-suggest" style={{ top: pos.top, left: pos.left }} onMouseDown={(event) => event.preventDefault()}>{suggestions.slice(0, 8).map((suggestion, index) => <button key={`${suggestion.kind}-${suggestion.text}`} className={index === highlight ? "active" : ""} onClick={() => accept(suggestion)}><span className="cypher-suggest-kind">{suggestion.kind}</span>{suggestion.text}</button>)}</div>}</div>;
}

function GraphManager({ target, user, published, runtimeTypes, mode, onModeChange, notify, fail }: { target: Target | null; user: User; published: Version | null; runtimeTypes: RuntimeTypeSet | null; mode: "instances" | "ontology"; onModeChange: (mode: "instances" | "ontology") => void; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [graph, setGraph] = useState<GraphData>({ nodes: [], relationships: [] });
  const [ontologyGraph, setOntologyGraph] = useState<GraphData | null>(null);
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilters, setTypeFilters] = useState({ labels: [] as string[], relationshipTypes: [] as string[] });
  const [loading, setLoading] = useState(false);
  const { settings, update, reset } = useGraphSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ontologyTargetId = target?.id;
  const [cypher, setCypher] = useState("MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100");
  const [running, setRunning] = useState(false);
  const cypherIsWrite = /\b(create|merge|delete|detach|set|remove|drop|alter)\b/i.test(cypher);
  const [cypherMeta, setCypherMeta] = useState<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>({ labels: [], relationshipTypes: [], propertyKeys: [] });

  useEffect(() => {
    if (!target) return;
    void api<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>(`/api/instances/meta?targetId=${encodeURIComponent(target.id)}`).then(setCypherMeta).catch(() => {});
    // Schema metadata is re-fetched only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  const cypherLabels = useMemo(() => [...new Set([...cypherMeta.labels, ...(published?.definition.entityTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.labels, published]);
  const cypherRelationshipTypes = useMemo(() => [...new Set([...cypherMeta.relationshipTypes, ...(published?.definition.relationshipTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.relationshipTypes, published]);
  const cypherPropertyKeys = useMemo(() => [...new Set([...cypherMeta.propertyKeys, ...(published?.definition.entityTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? []), ...(published?.definition.relationshipTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.propertyKeys, published]);

  const load = useCallback(async (nextLabel: string, nextSearch: string, nodeLimit: number, filters = typeFilters) => {
    if (!target) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      for (const type of filters.labels) params.append("graphLabel", type);
      for (const type of filters.relationshipTypes) params.append("relationshipType", type);
      params.set("nodeLimit", String(nodeLimit));
      setGraph(await api<GraphData>(`/api/instances/graph?${params.toString()}`));
    } catch (reason) { fail(reason); } finally { setLoading(false); }
  }, [target, fail, typeFilters]);

  const loadOntology = useCallback(async () => {
    if (!target) return;
    setLoading(true);
    try {
      const result = await api<QueryResult>(`/api/targets/${target.id}/schema`);
      setOntologyGraph(result.graph);
    } catch (reason) { fail(reason); } finally { setLoading(false); }
  }, [target, fail]);

  useEffect(() => {
    if (!target) return;
    void api<GraphData>(`/api/instances/graph?targetId=${encodeURIComponent(target.id)}&nodeLimit=${settings.nodeLimit}`).then(setGraph).catch(fail);
    // Graph is re-fetched when the selected target or the node limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, settings.nodeLimit]);

  useEffect(() => {
    if (mode !== "ontology" || !ontologyTargetId) return;
    void api<QueryResult>(`/api/targets/${ontologyTargetId}/schema`).then((result) => setOntologyGraph(result.graph)).catch(fail);
  }, [fail, mode, ontologyTargetId]);

  const expand = useCallback(async (nodeId: string) => {
    if (!target) return;
    const expanded = await api<QueryResult>("/api/cypher", { method: "POST", body: JSON.stringify({ targetId: target.id, cypher: `MATCH (focus) WHERE elementId(focus) = $nodeId OPTIONAL MATCH (focus)-[relationship]-(neighbor) RETURN focus, relationship, neighbor LIMIT ${Math.max(1, settings.maxNeighbors)}`, parameters: { nodeId } }) });
    setGraph((current) => ({ nodes: [...new Map([...current.nodes, ...expanded.graph.nodes].map((node) => [node.id, node])).values()], relationships: [...new Map([...current.relationships, ...expanded.graph.relationships].map((relationship) => [relationship.id, relationship])).values()] }));
  }, [target, settings.maxNeighbors]);

  const runCypher = useCallback(async () => {
    if (!target) return;
    try {
      if (cypherIsWrite && user.role !== "ADMIN") throw new Error("查看者不能执行写入 Cypher。");
      if (cypherIsWrite && !window.confirm("确认执行写入 Cypher？此操作会修改目标图谱。")) return;
      setRunning(true);
      const result = await api<QueryResult>("/api/cypher", { method: "POST", body: JSON.stringify({ targetId: target.id, cypher, confirmWrite: cypherIsWrite }) });
      setGraph(capResult(result, settings.recordLimit).graph);
    } catch (reason) { fail(reason); } finally { setRunning(false); }
  }, [target, user, cypher, cypherIsWrite, settings.recordLimit, fail]);

  return <section className="stack">
    <div className="graph-view-switcher" aria-label="图谱视图">
      <button className={mode === "instances" ? "active" : ""} aria-pressed={mode === "instances"} onClick={() => onModeChange("instances")}>实例图谱</button>
      <button className={mode === "ontology" ? "active" : ""} aria-pressed={mode === "ontology"} onClick={() => onModeChange("ontology")}>查看本体</button>
    </div>
    {mode === "instances" ? <>
      <div className="panel functional-panel graph-head-panel"><div className="title-row"><div><span className="eyebrow">图谱管理</span><h2>画布编辑并写回 Neo4j</h2></div><div className="functional-actions"><label className="graph-head-filter">标签筛选<select value={label} onChange={(event) => { const filters = { labels: [], relationshipTypes: [] }; setLabel(event.target.value); setTypeFilters(filters); void load(event.target.value, search, settings.nodeLimit, filters); }}><option value="">全部</option>{(runtimeTypes?.labels ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}（{item.count}）</option>)}</select></label><button className="action" disabled={loading} onClick={() => void load(label, search, settings.nodeLimit)}><Search size={15} />{loading ? "加载中…" : "刷新"}</button><button className="action" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />可视化配置</button></div></div><p className="subtle">管理员：拖拽节点保存位置，从节点详情发起新建关系后选择目标节点；可在详情面板编辑属性或删除元素。当前按“可视化节点上限”{settings.nodeLimit} 个节点加载，可在“可视化配置”中调整。未发布本体时按运行时类型直接管理。</p></div>
      <div className="panel functional-panel cypher-bar"><div className="title-row"><div><span className="eyebrow">Cypher 查询</span><h2>运行语句并可视化</h2></div></div><CypherEditor value={cypher} onChange={setCypher} labels={cypherLabels} relationshipTypes={cypherRelationshipTypes} propertyKeys={cypherPropertyKeys} placeholder="MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100" /><div className="cypher-controls"><span className={cypherIsWrite ? "write-warning" : "read-state"}>{cypherIsWrite ? "写入语句，执行前需要确认" : "只读语句"}</span><button className="action primary" disabled={running || !target} onClick={() => void runCypher()}><PlayIcon />{running ? "执行中" : "运行并可视化"}</button></div></div>
      <GraphCanvas graph={graph} targetId={target?.id} user={user} editable definition={published?.definition ?? null} runtimeTypes={runtimeTypes ?? undefined} onExpand={expand} onRefresh={() => load(label, search, settings.nodeLimit)} onTypeFilterChange={(filters) => { setTypeFilters(filters); void load(label, search, settings.nodeLimit, filters); }} notify={notify} fail={fail} />
      {settingsOpen && <GraphSettingsDialog settings={settings} onSave={update} onReset={reset} onClose={() => setSettingsOpen(false)} />}
    </> : <>
      <div className="panel functional-panel graph-head-panel"><div className="title-row"><div><span className="eyebrow">本体骨架</span><h2>查看本体{published ? ` · v${published.version_number}` : ""}</h2><p className="subtle">骨架由 <code>CALL db.schema.visualization()</code> 读取当前数据库的实体类型与关系类型；点击类型可查看已发布本体定义的属性规则和关系端点契约。</p></div><button className="action" disabled={loading} onClick={() => void loadOntology()}><Network size={15} />{loading ? "加载中…" : "刷新本体骨架"}</button></div></div>
      {ontologyGraph ? <GraphCanvas graph={ontologyGraph} targetId={target?.id} user={user} editable={false} definition={published?.definition ?? null} viewMode="ontology" notify={notify} fail={fail} /> : <div className="graph-empty"><Network size={27} /><b>正在读取本体骨架</b><span>将从目标 Neo4j 加载实际存在的实体类型和关系类型。</span></div>}
    </>}
  </section>;
}

function EntityManager({ target, user, published, runtimeTypes, notify, fail }: { target: Target | null; user: User; published: Version | null; runtimeTypes: RuntimeTypeSet | null; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [rows, setRows] = useState<EntityRow[]>([]);
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextLabel: string, nextSearch: string) => {
    if (!target) return;
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      setRows(await api<{ rows: EntityRow[] }>(`/api/instances/entities?${params.toString()}`).then((data) => data.rows));
    } catch (reason) { fail(reason); }
  }, [target, fail]);

  useEffect(() => {
    if (!target) return;
    void api<{ rows: EntityRow[] }>(`/api/instances/entities?targetId=${encodeURIComponent(target.id)}`).then((data) => setRows(data.rows)).catch(fail);
    // Entity list is re-fetched only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const definitions = selected ? (published?.definition.entityTypes.find((item) => selected.labels.includes(item.name))?.properties ?? null) : null;
  const managed = Boolean(definitions);

  const save = async () => {
    if (!target || !selected) return;
    try { setBusy(true); const updated = await api<EntityRow>(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) }); setRows((current) => current.map((row) => row.id === updated.id ? updated : row)); notify("属性已保存到 Neo4j。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || !selected) return;
    if (!window.confirm("删除该节点及其所有关系？")) return;
    try { setBusy(true); await api(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}`, { method: "DELETE" }); setSelectedId(null); setRows((current) => current.filter((row) => row.id !== selected.id)); notify("已删除。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <section className="manager-grid">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">实体</span>
      <h2>{rows.length} 条</h2>
      <div className="manager-toolbar">
        <select value={label} onChange={(event) => { setLabel(event.target.value); void load(event.target.value, search); }}><option value="">全部标签</option>{[...new Set([...(published?.definition.entityTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.labels.map((item) => item.name) ?? [])])].map((name) => <option key={name} value={name}>{name}</option>)}</select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(label, search); }} placeholder="搜索属性" />
        <button className="action compact" onClick={() => void load(label, search)}><Search size={14} /></button>
        <button className="action compact" onClick={() => setCreateOpen(true)}><Plus size={14} />新建</button>
      </div>
      <div className="manager-rows">{rows.map((row) => <button key={row.id} className={selectedId === row.id ? "manager-row selected" : "manager-row"} onClick={() => { setSelectedId(row.id); setDraftProps(Object.fromEntries(Object.entries(row.properties).filter(([key]) => key !== "fx" && key !== "fy"))); }}><CircleDot size={15} /><span><b>{entityTitle(row)}</b><small>{row.labels.join(", ")} · {propertySummary(row.properties)}</small></span></button>)}{!rows.length && <p className="empty">没有匹配的实体。</p>}</div>
    </div>
    <div className="panel functional-panel detail-panel">
      {selected ? <><span className="eyebrow">选中实体</span><h2>{entityTitle(selected)}</h2><div className="detail-meta"><span>{selected.labels.join(", ") || "无标签"}</span><code>{selected.id}</code></div>{user.role === "ADMIN" ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存属性</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />删除节点</button></div><p className="subtle">{managed ? "按已发布本体校验属性。" : "未受管类型，属性值直接写入。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}</> : <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一条实体</b><span>点击左侧列表中的实体查看与编辑属性。</span></div>}
    </div>
    {user.role === "ADMIN" && createOpen && <EntityCreateDialog published={published} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (label, properties) => { try { if (!target) throw new Error("请先选择目标。"); await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId: target.id, entityType: label, properties }) }); notify("实体已写入 Neo4j。"); setCreateOpen(false); await load(label, search); } catch (reason) { fail(reason); } }} />}
  </section>;
}

function RelationshipManager({ target, user, published, runtimeTypes, notify, fail }: { target: Target | null; user: User; published: Version | null; runtimeTypes: RuntimeTypeSet | null; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [rows, setRows] = useState<RelationshipRow[]>([]);
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextType: string, nextSearch: string) => {
    if (!target) return;
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (nextType) params.set("type", nextType);
      if (nextSearch) params.set("search", nextSearch);
      setRows(await api<{ rows: RelationshipRow[] }>(`/api/instances/relationships?${params.toString()}`).then((data) => data.rows));
    } catch (reason) { fail(reason); }
  }, [target, fail]);

  useEffect(() => {
    if (!target) return;
    void api<{ rows: RelationshipRow[] }>(`/api/instances/relationships?targetId=${encodeURIComponent(target.id)}`).then((data) => setRows(data.rows)).catch(fail);
    // Relationship list is re-fetched only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const definition = published?.definition ?? null;
  const selectedEnds = selected ? relationshipEndpoints(selected, definition) : null;
  const definitions = selected ? (published?.definition.relationshipTypes.find((item) => item.name === selected.type)?.properties ?? null) : null;
  const managed = Boolean(definitions);

  const save = async () => {
    if (!target || !selected) return;
    try { setBusy(true); const updated = await api<RelationshipRow>(`/api/instances/relationships/${encodeURIComponent(selected.id)}?targetId=${target.id}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) }); setRows((current) => current.map((row) => row.id === updated.id ? updated : row)); notify("属性已保存到 Neo4j。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || !selected) return;
    if (!window.confirm("删除该关系？")) return;
    try { setBusy(true); await api(`/api/instances/relationships/${encodeURIComponent(selected.id)}?targetId=${target.id}`, { method: "DELETE" }); setSelectedId(null); setRows((current) => current.filter((row) => row.id !== selected.id)); notify("已删除。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <section className="manager-grid">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">关系</span>
      <h2>{rows.length} 条</h2>
      <div className="manager-toolbar">
        <select value={type} onChange={(event) => { setType(event.target.value); void load(event.target.value, search); }}><option value="">全部类型</option>{(runtimeTypes?.relationshipTypes ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(type, search); }} placeholder="搜索属性" />
        <button className="action compact" onClick={() => void load(type, search)}><Search size={14} /></button>
        <button className="action compact" onClick={() => setCreateOpen(true)}><Plus size={14} />新建</button>
      </div>
      <div className="manager-rows">{rows.map((row) => { const ends = relationshipEndpoints(row, definition); return <button key={row.id} className={selectedId === row.id ? "manager-row selected" : "manager-row"} onClick={() => { setSelectedId(row.id); setDraftProps(row.properties); }}><Link2 size={15} /><span><b>{row.type}</b><small>{ends.source || row.sourceId} <span className="arrow">→</span> {ends.target || row.targetId} · {propertySummary(row.properties)}</small></span></button>; })}{!rows.length && <p className="empty">没有匹配的关系。</p>}</div>
    </div>
    <div className="panel functional-panel detail-panel">
      {selected ? <><span className="eyebrow">选中关系</span><h2>{selected.type}</h2><div className="detail-meta"><span>{selectedEnds?.source || selected.sourceId} <span className="arrow">→</span> {selectedEnds?.target || selected.targetId}</span><code>{selected.id}</code></div>{user.role === "ADMIN" ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存属性</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />删除关系</button></div><p className="subtle">{managed ? "按已发布本体校验属性。" : "未受管类型，属性值直接写入。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}</> : <div className="graph-inspector-empty"><Link2 size={20} /><b>选择一条关系</b><span>点击左侧列表中的关系查看与编辑属性。</span></div>}
    </div>
    {user.role === "ADMIN" && createOpen && <RelationshipCreateDialog targetId={target?.id ?? ""} published={published} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (type, sourceId, targetId, properties) => { try { if (!target) throw new Error("请先选择目标。"); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId: target.id, relationshipType: type, sourceId, targetIdValue: targetId, properties }) }); notify("关系已写入 Neo4j。"); setCreateOpen(false); await load(type, search); } catch (reason) { fail(reason); } }} />}
  </section>;
}

type EntitySearchResult = { id: string; labels: string[]; properties: Record<string, unknown>; matched: string[]; rank: number };

function nodeDisplayName(labels: string[] | undefined, properties: Record<string, unknown> | undefined, definition: Definition | null): string {
  if (!properties) return "";
  const entityType = definition?.entityTypes.find((item) => labels?.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && properties[primary] != null) return String(properties[primary]);
  for (const key of ["name", "名称", "title", "label"]) if (properties[key] != null) return String(properties[key]);
  return "";
}

function relationshipEndpoints(row: RelationshipRow, definition: Definition | null) {
  return { source: nodeDisplayName(row.sourceLabels, row.sourceProperties, definition), target: nodeDisplayName(row.targetLabels, row.targetProperties, definition) };
}

function entityDisplayName(node: EntitySearchResult, definition: Definition | null): string {
  const entityType = definition?.entityTypes.find((item) => node.labels.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && node.properties[primary] != null) return String(node.properties[primary]);
  for (const key of ["name", "名称", "title", "label"]) if (node.properties[key] != null) return String(node.properties[key]);
  return node.id;
}

function EntitySearchPicker({ targetId, labels, definition, placeholder, value, onChange }: { targetId: string; labels: string[]; definition: Definition | null; placeholder: string; value: EntitySearchResult | null; onChange: (node: EntitySearchResult | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelKey = labels.join("|");
  const runSearch = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) { setResults([]); setSearched(false); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ targetId, q: trimmed, limit: "12" });
      if (labelKey) params.set("labels", JSON.stringify(labelKey.split("|")));
      const data = await api<{ results: EntitySearchResult[] }>(`/api/instances/search?${params.toString()}`);
      setResults(data.results); setSearched(true); setHighlight(0);
    } catch (reason) {
      setResults([]); setSearched(true); setError(reason instanceof Error ? reason.message : "搜索失败。");
    } finally { setLoading(false); }
  }, [targetId, labelKey]);
  useEffect(() => { const handle = window.setTimeout(() => { void runSearch(query); }, 250); return () => window.clearTimeout(handle); }, [query, runSearch]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const select = (node: EntitySearchResult) => { onChange(node); setQuery(""); setResults([]); setOpen(false); setSearched(false); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { setOpen(true); setHighlight((h) => Math.min(h + 1, results.length - 1)); } }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const candidate = results[highlight] ?? results[0]; if (candidate) select(candidate); }
    else if (event.key === "Escape") { setOpen(false); }
  };
  const menuOpen = open && !value && query.trim().length > 0;
  return <div className="entity-picker" ref={boxRef}>{value ? <div className="entity-picker-selected"><span className="entity-chip"><span className="entity-chip-label">{value.labels[0] ?? "?"}</span><b>{entityDisplayName(value, definition)}</b></span><span className="entity-chip-id">{value.id}</span><button type="button" className="entity-chip-clear" title="移除" onClick={() => onChange(null)}><X size={13} /></button></div> : <div className="entity-picker-input"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={onKeyDown} onFocus={() => { if (query.trim() && results.length) setOpen(true); }} placeholder={placeholder} autoComplete="off" spellCheck={false} />{loading && <Loader2 size={14} className="entity-spinner" />}</div>}{menuOpen && <div className="entity-picker-menu">{loading && !results.length && !error ? <div className="entity-picker-empty"><Loader2 size={14} className="entity-spinner" />正在搜索…</div> : error ? <div className="entity-picker-empty">{error}</div> : results.length ? results.map((node, index) => <button type="button" className={index === highlight ? "entity-result selected" : "entity-result"} key={node.id} onMouseEnter={() => setHighlight(index)} onClick={() => select(node)}><span className="entity-result-label">{node.labels.slice(0, 2).join(" · ") || "?"}</span><span className="entity-result-name">{entityDisplayName(node, definition)}</span><span className="entity-result-id">{node.id.slice(0, 12)}</span></button>) : <div className="entity-picker-empty"><Search size={14} />没有匹配的实体</div>}</div>}</div>;
}

function EntityCreateDialog({ published, runtimeTypes, onClose, onCreate }: { published: Version | null; runtimeTypes: RuntimeTypeSet | null; onClose: () => void; onCreate: (label: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const definitions = published?.definition.entityTypes.find((item) => item.name === label)?.properties ?? null;
  const options = useMemo(() => [...new Set([...(published?.definition.entityTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.labels.map((item) => item.name) ?? [])])], [published, runtimeTypes]);
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!label.trim()) return; setBusy(true); void onCreate(label.trim(), properties).finally(() => setBusy(false)); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><CircleDot size={22} /></div><span className="eyebrow">新建实体</span><h2>选择节点标签</h2><label>标签<select value={label} onChange={(event) => setLabel(event.target.value)} required><option value="">选择标签</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><PropertyEditor definitions={definitions ?? []} values={properties} mode="managed" onChange={setProperties} /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!label.trim() || busy}>{busy ? "创建中…" : "创建实体"}</button></div></form></div>;
}

function RelationshipCreateDialog({ targetId, published, runtimeTypes, onClose, onCreate }: { targetId: string; published: Version | null; runtimeTypes: RuntimeTypeSet | null; onClose: () => void; onCreate: (type: string, sourceId: string, targetId: string, properties: Record<string, unknown>) => Promise<void> }) {
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
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog dialog-wide" onSubmit={(event) => { event.preventDefault(); if (!type.trim() || !source || !target) return; setBusy(true); void onCreate(type.trim(), source.id, target.id, properties).finally(() => setBusy(false)); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Link2 size={22} /></div><span className="eyebrow">新建关系</span><h2>选择关系类型</h2><label>关系类型<select value={type} onChange={(event) => { setType(event.target.value); setSource(null); setTarget(null); }} required><option value="">选择类型</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><div className="dialog-field"><span>起始实体</span><EntitySearchPicker targetId={targetId} labels={sourceLabels} definition={published?.definition ?? null} placeholder="按名称搜索起始实体…" value={source} onChange={setSource} /></div><div className="dialog-field"><span>终止实体</span><EntitySearchPicker targetId={targetId} labels={targetLabels} definition={published?.definition ?? null} placeholder="按名称搜索终止实体…" value={target} onChange={setTarget} /></div>{selfLoop && <p className="dialog-hint">起始与终止为同一实体（自环关系）。</p>}<PropertyEditor definitions={definitions ?? []} values={properties} mode="managed" onChange={setProperties} /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!type.trim() || !source || !target || busy}>{busy ? "创建中…" : "创建关系"}</button></div></form></div>;
}

function PlayIcon() { return <span className="arrow">▶</span>; }
