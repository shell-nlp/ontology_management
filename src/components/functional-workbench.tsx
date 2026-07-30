"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, BookOpen, CheckCircle2, CircleDot, Database, Eye, FileCheck2, GitBranch, Link2, LogOut, Network, Plus, Play, ShieldCheck, TableProperties, TerminalSquare, UserRound, X } from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./graph-canvas.css";

type User = { id: string; email: string; role: "ADMIN" | "VIEWER" };
type Target = { id: string; name: string; uri: string; databaseName: string; username: string };
type Property = { name: string; dataType: "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "DATETIME" | "TEXT_ARRAY" | "JSON"; required: boolean; unique: boolean; indexed: boolean };
type EntityType = { id: string; name: string; description: string; properties: Property[] };
type RelationType = { id: string; name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
type Definition = { entityTypes: EntityType[]; relationshipTypes: RelationType[] };
type Version = { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: Definition };
type View = "overview" | "ontology" | "entities" | "relations" | "properties" | "runtime" | "cypher" | "targets";
type GraphData = { nodes: { id: string; labels: string[]; properties: Record<string, unknown> }[]; relationships: { id: string; type: string; source: string; target: string; properties: Record<string, unknown> }[] };
type QueryResult = { keys: string[]; records: Record<string, unknown>[]; graph: GraphData; summary: string };
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

export function FunctionalWorkbench() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState("");
  const [draft, setDraft] = useState<Version | null>(null);
  const [published, setPublished] = useState<Version | null>(null);
  const [view, setView] = useState<View>("overview");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedTarget = targets.find((target) => target.id === targetId) ?? null;
  const definition = draft?.definition ?? published?.definition ?? emptyDefinition;

  const notify = (text: string) => { setMessage(text); setError(null); };
  const fail = (reason: unknown) => { setError(reason instanceof Error ? reason.message : "操作失败。"); setMessage(null); };

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
    try { const current = await ensureDraft(); const result = await api<{ published: boolean; violations?: { message: string; count: number }[] }>(`/api/ontology/${current.id}/publish`, { method: "POST" }); if (result.published) { notify("本体已发布，实例管理现在可以使用该类型。 "); await loadVersions(targetId); } } catch (reason) { fail(reason); }
  };

  if (user === undefined) return <div className="loading-screen">正在加载 Atlas Ontology...</div>;
  if (!user) return <Login onSuccess={async (next) => { setUser(next); await loadTargets(); }} />;

  return <main className="functional-shell">
    <aside className="functional-sidebar"><div className="functional-brand"><GitBranch size={23} /><span><b>ATLAS</b><small>ONTOLOGY CONTROL</small></span></div><label className="target-picker"><span>当前 Neo4j 目标</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择目标</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></label><nav>{([
      ["overview", "总览", Activity], ["ontology", "本体草稿", BookOpen], ["entities", "实体", CircleDot], ["relations", "关系", Link2], ["properties", "属性", TableProperties], ["runtime", "运行时 Schema", Network], ["cypher", "Cypher 工作台", TerminalSquare], ["targets", "连接目标", Database],
    ] as const).map(([id, label, Icon]) => <button key={id} className={view === id ? "functional-nav selected" : "functional-nav"} onClick={() => setView(id)}><Icon size={17} />{label}</button>)}</nav><div className="functional-user"><UserRound size={17} /><span><b>{user.email}</b><small>{user.role === "ADMIN" ? "管理员" : "查看者"}</small></span><button title="退出登录" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setUser(null); }}><LogOut size={16} /></button></div></aside>
    <section className="functional-content"><header><div><p>图谱治理 / {view}</p><h1>{selectedTarget?.name ?? "连接 Neo4j 目标"}</h1></div><div className="header-state">{selectedTarget ? <><span className="state-dot" />已选择目标</> : "需要登记目标"}</div></header><Notice message={error ?? message} error={Boolean(error)} />
      {view === "overview" && <Overview target={selectedTarget} draft={draft} published={published} onNavigate={setView} />}
      {view === "targets" && <TargetManager targets={targets} refresh={loadTargets} onSelect={(id) => { setTargetId(id); setView("overview"); }} notify={notify} fail={fail} />}
      {view === "ontology" && <OntologyManager definition={definition} draft={draft} user={user} save={saveDefinition} validate={validate} publish={publish} notify={notify} fail={fail} />}
      {view === "properties" && <PropertyManager definition={definition} draft={draft} save={saveDefinition} fail={fail} />}
      {view === "entities" && <EntityManager target={selectedTarget} published={published} fail={fail} notify={notify} />}
      {view === "relations" && <RelationshipManager target={selectedTarget} published={published} fail={fail} notify={notify} />}
      {view === "runtime" && <RuntimeSchema target={selectedTarget} fail={fail} />}
      {view === "cypher" && <CypherManager target={selectedTarget} user={user} fail={fail} />}
    </section>
  </main>;
}

function Login({ onSuccess }: { onSuccess: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState("admin@example.com"); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  return <main className="login-screen"><form className="login-card" onSubmit={async (event) => { event.preventDefault(); try { setError(""); const user = await api<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); await onSuccess(user); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } }}><div className="login-mark"><GitBranch size={25} /></div><p>ATLAS ONTOLOGY CONTROL</p><h1>登录本体平台</h1><label>邮箱<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required autoFocus /></label><Notice message={error || null} error /><button className="action primary" type="submit">登录</button></form></main>;
}

function Overview({ target, draft, published, onNavigate }: { target: Target | null; draft: Version | null; published: Version | null; onNavigate: (view: View) => void }) { return <section className="panel functional-panel overview-panel"><span className="eyebrow">本体控制室</span><h2>{target ? "本体与运行时状态" : "开始登记第一个目标"}</h2>{target ? <div className="status-grid"><div><b>{draft ? `v${draft.version_number}` : "无"}</b><span>当前草稿</span></div><div><b>{published ? `v${published.version_number}` : "无"}</b><span>已发布版本</span></div><div><b>{published?.definition.entityTypes.length ?? 0}</b><span>已发布实体类型</span></div><div><b>{published?.definition.relationshipTypes.length ?? 0}</b><span>已发布关系类型</span></div></div> : <p>先在“连接目标”登记 Neo4j URI、数据库、用户名与密码。密码会加密保存。</p>}<div className="functional-actions">{target && <button className="action" onClick={() => onNavigate("ontology")}><BookOpen size={16} />配置本体草稿</button>}<button className="action primary" onClick={() => onNavigate(target ? "runtime" : "targets")}><ArrowIcon />{target ? "查看运行时 Schema" : "登记 Neo4j 目标"}</button></div></section>; }
function ArrowIcon() { return <span className="arrow">→</span>; }

function TargetManager({ targets, refresh, onSelect, notify, fail }: { targets: Target[]; refresh: () => Promise<void>; onSelect: (id: string) => void; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [form, setForm] = useState({ name: "", uri: "bolt://", databaseName: "neo4j", username: "neo4j", password: "" }); const [testing, setTesting] = useState("");
  const add = async (event: FormEvent) => { event.preventDefault(); try { const target = await api<Target>("/api/targets", { method: "POST", body: JSON.stringify(form) }); await refresh(); onSelect(target.id); notify("Neo4j 目标已登记，密码已加密保存。"); setForm({ name: "", uri: "bolt://", databaseName: "neo4j", username: "neo4j", password: "" }); } catch (reason) { fail(reason); } };
  return <section className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={add}><span className="eyebrow">登记目标</span><h2>新建 Neo4j 连接</h2><label>目标名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：生产知识图谱" required /></label><label>Neo4j URI<input value={form.uri} onChange={(event) => setForm({ ...form, uri: event.target.value })} placeholder="neo4j+s://host:7687" required /></label><label>数据库名称<input value={form.databaseName} onChange={(event) => setForm({ ...form, databaseName: event.target.value })} required /></label><label>用户名<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label><label>密码<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label><button className="action primary"><Plus size={16} />登记并选择</button></form><div className="panel functional-panel target-list"><span className="eyebrow">已登记目标</span><h2>{targets.length} 个目标</h2>{targets.length ? targets.map((target) => <div className="target-row" key={target.id}><Database size={18} /><span><b>{target.name}</b><small>{target.uri} / {target.databaseName}</small></span><button className="action compact" disabled={testing === target.id} onClick={async () => { try { setTesting(target.id); const info = await api<{ connected: boolean; agent: string }>(`/api/targets/${target.id}/test`, { method: "POST" }); notify(`连接成功：${info.agent}`); } catch (reason) { fail(reason); } finally { setTesting(""); } }}>{testing === target.id ? "测试中" : "测试连接"}</button></div>) : <p className="empty">尚未登记目标。</p>}</div></section>;
}

function OntologyManager({ definition, draft, user, save, validate, publish, notify, fail }: { definition: Definition; draft: Version | null; user: User; save: (definition: Definition) => Promise<void>; validate: () => Promise<void>; publish: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [rel, setRel] = useState({ name: "", source: "", target: "" });
  const addEntity = async (event: FormEvent) => { event.preventDefault(); try { if (!name.trim()) return; if (definition.entityTypes.some((item) => item.name === name.trim())) throw new Error("实体类型名称已存在。"); await save({ ...definition, entityTypes: [...definition.entityTypes, { id: crypto.randomUUID(), name: name.trim(), description: description.trim(), properties: [] }] }); setName(""); setDescription(""); } catch (reason) { fail(reason); } };
  const addRelation = async (event: FormEvent) => { event.preventDefault(); try { if (!rel.name || !rel.source || !rel.target) throw new Error("请填写关系类型和两个端点。"); await save({ ...definition, relationshipTypes: [...definition.relationshipTypes, { id: crypto.randomUUID(), name: rel.name, sourceEntityTypeId: rel.source, targetEntityTypeId: rel.target, properties: [] }] }); setRel({ name: "", source: "", target: "" }); } catch (reason) { fail(reason); } };
  return <section className="stack"><div className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">本体草稿</span><h2>{draft ? `v${draft.version_number} · 未发布` : "尚无草稿"}</h2></div><div className="functional-actions"><button className="action" disabled={user.role !== "ADMIN"} onClick={() => validate().catch(fail)}><FileCheck2 size={16} />校验</button><button className="action primary" disabled={user.role !== "ADMIN"} onClick={() => publish().catch(fail)}><ShieldCheck size={16} />发布</button></div></div><p className="subtle">类型修改会先保存为草稿；发布前将检查既有 Neo4j 数据、端点契约和必填属性。</p></div><div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addEntity}><span className="eyebrow">实体类型</span><h2>新增实体类型</h2><label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户" required /></label><label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label><button className="action primary"><Plus size={16} />加入草稿</button></form><form className="panel functional-panel form-panel" onSubmit={addRelation}><span className="eyebrow">关系契约</span><h2>新增关系类型</h2><label>关系名称<input value={rel.name} onChange={(event) => setRel({ ...rel, name: event.target.value })} placeholder="例如：负责" required /></label><label>起始实体类型<select value={rel.source} onChange={(event) => setRel({ ...rel, source: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>终止实体类型<select value={rel.target} onChange={(event) => setRel({ ...rel, target: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="action primary"><Plus size={16} />加入草稿</button></form></div><div className="panel functional-panel type-list"><span className="eyebrow">草稿内容</span><h2>{definition.entityTypes.length} 个实体类型 / {definition.relationshipTypes.length} 个关系类型</h2>{definition.entityTypes.map((item) => <div className="type-row" key={item.id}><CircleDot size={17} /><b>{item.name}</b><span>{item.description || "无说明"}</span><em>{item.properties.length} 项属性</em></div>)}{definition.relationshipTypes.map((item) => <div className="type-row" key={item.id}><Link2 size={17} /><b>{item.name}</b><span>{definition.entityTypes.find((x) => x.id === item.sourceEntityTypeId)?.name ?? "?"} <ArrowIcon /> {definition.entityTypes.find((x) => x.id === item.targetEntityTypeId)?.name ?? "?"}</span><em>{item.properties.length} 项属性</em></div>)}{!definition.entityTypes.length && <p className="empty">创建草稿后，从新增实体类型开始。</p>}</div></section>;
}

function PropertyManager({ definition, draft, save, fail }: { definition: Definition; draft: Version | null; save: (definition: Definition) => Promise<void>; fail: (reason: unknown) => void }) {
  const [owner, setOwner] = useState(""); const [name, setName] = useState(""); const [dataType, setDataType] = useState<Property["dataType"]>("TEXT"); const [required, setRequired] = useState(false);
  const choices = useMemo(() => [...definition.entityTypes.map((item) => ({ key: `entity:${item.id}`, label: `实体 · ${item.name}`, type: "entity" as const, item })), ...definition.relationshipTypes.map((item) => ({ key: `relation:${item.id}`, label: `关系 · ${item.name}`, type: "relation" as const, item }))], [definition]);
  return <section className="stack"><div className="panel functional-panel"><span className="eyebrow">属性规则</span><h2>在类型上定义属性，在实例上填写属性值</h2>{!draft && <p className="empty">请先在本体草稿中创建类型。</p>}<form className="inline-form" onSubmit={async (event) => { event.preventDefault(); try { const selected = choices.find((item) => item.key === owner); if (!selected || !name.trim()) throw new Error("请选择所属类型并填写属性名称。"); const prop: Property = { name: name.trim(), dataType, required, unique: false, indexed: false }; const next = structuredClone(definition); if (selected.type === "entity") next.entityTypes.find((item) => item.id === selected.item.id)!.properties.push(prop); else next.relationshipTypes.find((item) => item.id === selected.item.id)!.properties.push(prop); await save(next); setName(""); } catch (reason) { fail(reason); } }}><select value={owner} onChange={(event) => setOwner(event.target.value)}><option value="">所属类型</option>{choices.map((item) => <option value={item.key} key={item.key}>{item.label}</option>)}</select><input value={name} onChange={(event) => setName(event.target.value)} placeholder="属性名称" /><select value={dataType} onChange={(event) => setDataType(event.target.value as Property["dataType"])}>{typeOptions.map((item) => <option key={item}>{item}</option>)}</select><label className="check-label"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />必填</label><button className="action primary"><Plus size={16} />添加属性</button></form></div><div className="panel functional-panel property-list">{[...definition.entityTypes, ...definition.relationshipTypes].flatMap((item) => item.properties.map((property) => <div className="type-row" key={`${item.id}-${property.name}`}><TableProperties size={17} /><b>{item.name}.{property.name}</b><span>{property.dataType}</span><em>{property.required ? "必填" : "可选"}</em></div>))}{!choices.some((item) => item.item.properties.length) && <p className="empty">尚未定义属性。</p>}</div></section>;
}

function EntityManager({ target, published, fail, notify }: { target: Target | null; published: Version | null; fail: (reason: unknown) => void; notify: (text: string) => void }) {
  const [rows, setRows] = useState<{ id: string; labels: string[]; properties: Record<string, unknown> }[]>([]); const [entityType, setEntityType] = useState(""); const [properties, setProperties] = useState("{}");
  const load = async () => { try { if (!target) throw new Error("请先选择 Neo4j 目标。"); const data = await api<{ rows: typeof rows }>(`/api/instances/entities?targetId=${target.id}`); setRows(data.rows); } catch (reason) { fail(reason); } };
  useEffect(() => {
    if (!target?.id) return;
    void api<{ rows: typeof rows }>(`/api/instances/entities?targetId=${target.id}`).then((data) => setRows(data.rows)).catch(fail);
    // The request is intentionally refreshed only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);
  return <section className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={async (event) => { event.preventDefault(); try { if (!target) throw new Error("请先选择目标。"); const result = await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId: target.id, entityType, properties: JSON.parse(properties) }) }); notify("实体已写入 Neo4j。"); setProperties("{}"); await load(); return result; } catch (reason) { fail(reason); } }}><span className="eyebrow">实体管理</span><h2>创建实体实例</h2>{published ? <><label>已发布实体类型<select value={entityType} onChange={(event) => setEntityType(event.target.value)} required><option value="">选择类型</option>{published.definition.entityTypes.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><label>属性 JSON<textarea value={properties} onChange={(event) => setProperties(event.target.value)} /></label><button className="action primary"><Plus size={16} />创建实体</button></> : <p className="empty">该目标尚无已发布本体，不能创建实体。</p>}</form><div className="panel functional-panel result-list"><span className="eyebrow">目标图数据</span><h2>{rows.length} 个实体</h2><button className="action compact" onClick={load}>刷新</button>{rows.map((row) => <div className="result-row" key={row.id}><CircleDot size={16} /><span><b>{row.labels.join(", ") || "无标签"}</b><small>{JSON.stringify(row.properties)}</small></span></div>)}</div></section>;
}

function RelationshipManager({ target, published, fail, notify }: { target: Target | null; published: Version | null; fail: (reason: unknown) => void; notify: (text: string) => void }) {
  const [rows, setRows] = useState<{ id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown> }[]>([]); const [form, setForm] = useState({ relationshipType: "", sourceId: "", targetIdValue: "", properties: "{}" });
  const load = async () => { try { if (!target) throw new Error("请先选择 Neo4j 目标。"); const data = await api<{ rows: typeof rows }>(`/api/instances/relationships?targetId=${target.id}`); setRows(data.rows); } catch (reason) { fail(reason); } };
  useEffect(() => {
    if (!target?.id) return;
    void api<{ rows: typeof rows }>(`/api/instances/relationships?targetId=${target.id}`).then((data) => setRows(data.rows)).catch(fail);
    // The request is intentionally refreshed only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);
  return <section className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={async (event) => { event.preventDefault(); try { if (!target) throw new Error("请先选择目标。"); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId: target.id, relationshipType: form.relationshipType, sourceId: form.sourceId, targetIdValue: form.targetIdValue, properties: JSON.parse(form.properties) }) }); notify("关系已写入 Neo4j，并已校验端点契约。"); await load(); } catch (reason) { fail(reason); } }}><span className="eyebrow">关系管理</span><h2>创建关系实例</h2>{published ? <><label>已发布关系类型<select value={form.relationshipType} onChange={(event) => setForm({ ...form, relationshipType: event.target.value })} required><option value="">选择关系</option>{published.definition.relationshipTypes.map((item) => <option value={item.name} key={item.id}>{item.name}</option>)}</select></label><label>起始实体 elementId<input value={form.sourceId} onChange={(event) => setForm({ ...form, sourceId: event.target.value })} required /></label><label>终止实体 elementId<input value={form.targetIdValue} onChange={(event) => setForm({ ...form, targetIdValue: event.target.value })} required /></label><label>属性 JSON<textarea value={form.properties} onChange={(event) => setForm({ ...form, properties: event.target.value })} /></label><button className="action primary"><Plus size={16} />创建关系</button></> : <p className="empty">请先发布本体。</p>}</form><div className="panel functional-panel result-list"><span className="eyebrow">目标图数据</span><h2>{rows.length} 条关系</h2><button className="action compact" onClick={load}>刷新</button>{rows.map((row) => <div className="result-row" key={row.id}><Link2 size={16} /><span><b>{row.type}</b><small>{row.sourceId} <ArrowIcon /> {row.targetId}</small></span></div>)}</div></section>;
}

function LegacyRuntimeSchema({ target, fail }: { target: Target | null; fail: (reason: unknown) => void }) { const [result, setResult] = useState<unknown>(null); return <section className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">运行时事实</span><h2>CALL db.schema.visualization()</h2></div><button className="action primary" onClick={async () => { try { if (!target) throw new Error("请先选择目标。"); setResult(await api(`/api/targets/${target.id}/schema`)); } catch (reason) { fail(reason); } }}><Eye size={16} />获取 Schema</button></div><pre className="json-result">{result ? JSON.stringify(result, null, 2) : "点击“获取 Schema”读取目标 Neo4j 的运行时 Schema。"}</pre></section>; }
function LegacyCypherManager({ target, user, fail }: { target: Target | null; user: User; fail: (reason: unknown) => void }) { const [cypher, setCypher] = useState("MATCH (n) RETURN labels(n) AS labels, count(n) AS count LIMIT 20"); const [result, setResult] = useState<unknown>(null); const [running, setRunning] = useState(false); const isWrite = /\b(create|merge|delete|detach|set|remove|drop|alter)\b/i.test(cypher); return <section className="stack"><div className="panel functional-panel"><span className="eyebrow">Cypher 工作台</span><h2>{target?.name ?? "请先选择目标"}</h2><textarea className="cypher-input" value={cypher} onChange={(event) => setCypher(event.target.value)} spellCheck={false} /><div className="title-row"><span className={isWrite ? "write-warning" : "read-state"}>{isWrite ? "检测到写入语句" : "只读语句"}</span><button className="action primary" disabled={running} onClick={async () => { try { if (!target) throw new Error("请先选择目标。"); if (isWrite && user.role !== "ADMIN") throw new Error("查看者不能执行写入 Cypher。"); if (isWrite && !window.confirm("确认执行写入 Cypher？此操作会修改目标图谱。")) return; setRunning(true); setResult(await api("/api/cypher", { method: "POST", body: JSON.stringify({ targetId: target.id, cypher, confirmWrite: isWrite }) })); } catch (reason) { fail(reason); } finally { setRunning(false); } }}><Play size={16} />{running ? "执行中" : "运行"}</button></div></div><pre className="panel functional-panel json-result">{result ? JSON.stringify(result, null, 2) : "结果会显示在这里。"}</pre></section>; }

function graphLabel(node: GraphData["nodes"][number]) {
  const preferred = ["name", "名称", "title", "id"].map((key) => node.properties[key]).find((value) => typeof value === "string" || typeof value === "number");
  return String(preferred ?? node.labels[0] ?? "节点");
}

function GraphCanvas({ graph }: { graph: GraphData }) {
  const nodes = useMemo<Node[]>(() => graph.nodes.map((node, index) => {
    const radius = Math.max(150, Math.min(300, 78 * graph.nodes.length));
    const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2;
    return {
      id: node.id,
      position: { x: 390 + Math.cos(angle) * radius, y: 275 + Math.sin(angle) * radius },
      data: { label: <div className="graph-node-label"><b>{graphLabel(node)}</b><small>{node.labels.join(" · ") || "未标注"}</small></div> },
      style: { width: 112, minHeight: 72, borderRadius: "50%", border: "2px solid #caa64f", background: "#e7c66b", color: "#3e3517", display: "grid", placeItems: "center", textAlign: "center", padding: "8px", boxShadow: "0 4px 12px rgba(89,73,25,.16)" },
      draggable: true,
    };
  }), [graph.nodes]);
  const edges = useMemo<Edge[]>(() => graph.relationships.filter((relationship) => graph.nodes.some((node) => node.id === relationship.source) && graph.nodes.some((node) => node.id === relationship.target)).map((relationship) => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    label: relationship.type,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#809198" },
    style: { stroke: "#809198", strokeWidth: 1.3 },
    labelStyle: { fill: "#52666a", fontSize: 10 },
    labelBgStyle: { fill: "#f9fbf9", fillOpacity: 0.9 },
  })), [graph]);
  if (!graph.nodes.length) return <div className="graph-empty"><Network size={27} /><b>查询结果中没有可绘制的节点或关系</b><span>使用例如 <code>MATCH p=()-[]-&gt;() RETURN p LIMIT 25</code> 的路径查询，即可切换到图谱视图。</span></div>;
  return <div className="graph-canvas"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.24 }} minZoom={0.2} maxZoom={2} nodesConnectable={false}><Background color="#d8ddd6" gap={19} size={1} /><Controls showInteractive={false} /></ReactFlow></div>;
}

function ResultViewer({ result }: { result: QueryResult | null }) {
  const [mode, setMode] = useState<"graph" | "table" | "raw">("graph");
  if (!result) return <div className="graph-empty"><TerminalSquare size={27} /><b>尚未执行查询</b><span>运行返回节点、关系或路径的 Cypher 后将在此展示可交互图谱。</span></div>;
  return <section className="panel functional-panel result-viewer"><div className="result-tabs"><button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>Graph <b>{result.graph.nodes.length}</b></button><button className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>Table <b>{result.records.length}</b></button><button className={mode === "raw" ? "active" : ""} onClick={() => setMode("raw")}>RAW</button><span>{result.graph.relationships.length} 条关系</span></div>{mode === "graph" && <GraphCanvas graph={result.graph} />}{mode === "table" && <div className="result-table-view">{result.records.map((row, index) => <pre key={index}>{JSON.stringify(row, null, 2)}</pre>)}</div>}{mode === "raw" && <pre className="json-result">{JSON.stringify(result, null, 2)}</pre>}</section>;
}

function RuntimeSchema({ target, fail }: { target: Target | null; fail: (reason: unknown) => void }) {
  const [result, setResult] = useState<QueryResult | null>(null);
  return <section className="stack"><div className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">运行时事实</span><h2>运行时图谱可视化</h2><p className="subtle">由 <code>CALL db.schema.visualization()</code> 返回的节点标签与关系类型绘制。</p></div><button className="action primary" onClick={async () => { try { if (!target) throw new Error("请先选择目标。"); setResult(await api<QueryResult>(`/api/targets/${target.id}/schema`)); } catch (reason) { fail(reason); } }}><Eye size={16} />获取并绘制</button></div></div><ResultViewer result={result} /></section>;
}

function CypherManager({ target, user, fail }: { target: Target | null; user: User; fail: (reason: unknown) => void }) {
  const [cypher, setCypher] = useState("MATCH p=()-[]->() RETURN p LIMIT 25");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const isWrite = /\b(create|merge|delete|detach|set|remove|drop|alter)\b/i.test(cypher);
  return <section className="stack"><div className="panel functional-panel"><span className="eyebrow">Cypher 工作台</span><h2>{target?.name ?? "请先选择目标"}</h2><textarea className="cypher-input" value={cypher} onChange={(event) => setCypher(event.target.value)} spellCheck={false} /><div className="title-row"><span className={isWrite ? "write-warning" : "read-state"}>{isWrite ? "检测到写入语句，执行前需要确认" : "只读语句"}</span><button className="action primary" disabled={running} onClick={async () => { try { if (!target) throw new Error("请先选择目标。"); if (isWrite && user.role !== "ADMIN") throw new Error("查看者不能执行写入 Cypher。"); if (isWrite && !window.confirm("确认执行写入 Cypher？此操作会修改目标图谱。")) return; setRunning(true); setResult(await api<QueryResult>("/api/cypher", { method: "POST", body: JSON.stringify({ targetId: target.id, cypher, confirmWrite: isWrite }) })); } catch (reason) { fail(reason); } finally { setRunning(false); } }}><Play size={16} />{running ? "执行中" : "运行并可视化"}</button></div></div><ResultViewer result={result} /></section>;
}
