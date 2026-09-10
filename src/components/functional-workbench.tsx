"use client";

import { Children, type CSSProperties, FormEvent, KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, BookOpen, Check, CheckCircle2, ChevronDown, CircleDot, Database, FileCheck2, GitBranch, History, Link2, Loader2, LogOut, Merge, Network, Pencil, Plus, RefreshCcw, RotateCcw, Search, Settings2, ShieldCheck, TableProperties, Trash2, UserRound, X } from "lucide-react";
import { GraphCanvas } from "@/components/graph-canvas";
import { GraphKindBadge, GraphKindChoice, GraphKindMark, GraphKindPicker, capabilityLine } from "@/components/graph-kind-picker";
import { PropertyEditor } from "@/components/property-editor";
import { GRAPH_TARGET_KINDS, graphTargetKindInfo, type GraphData, type GraphTargetKind, type RuntimeTypeInfo, type RuntimeTypeSet } from "@/lib/graph/types";

type User = { id: string; email: string; role: "ADMIN" | "VIEWER" };
type Target = { id: string; name: string; kind: GraphTargetKind; kindLabel: string; queryLanguage: "cypher" | "sparql"; uri: string; databaseName: string; username: string; options: Record<string, unknown> };
type Property = { name: string; dataType: "TEXT" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "DATETIME" | "TEXT_ARRAY" | "JSON"; required: boolean; unique: boolean; indexed: boolean };
type EntityType = { id: string; name: string; description: string; displayProperty?: string; properties: Property[] };
type RelationType = { id: string; name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
type Definition = { entityTypes: EntityType[]; relationshipTypes: RelationType[] };
type Version = { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: Definition; artifact_path?: string | null; entity_count?: number; relationship_count?: number; content_hash?: string | null };
type View = "overview" | "ontology" | "graph" | "entities" | "relations" | "targets" | "settings";
type QueryResult = { keys: string[]; records: Record<string, unknown>[]; graph: GraphData; summary: string };
type EntityRow = { id: string; labels: string[]; properties: Record<string, unknown> };
type RelationshipRow = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; sourceLabels?: string[]; sourceProperties?: Record<string, unknown>; targetLabels?: string[]; targetProperties?: Record<string, unknown> };

type QueryTemplate = { defaultQuery: string; placeholder: string; visualizationHint: string };
const NEO4J_QUERY_TEMPLATE: QueryTemplate = { defaultQuery: "MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100", placeholder: "MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100", visualizationHint: "返回节点、关系或路径即可在画布上可视化。" };
const JENA_QUERY_TEMPLATE: QueryTemplate = { defaultQuery: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", placeholder: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", visualizationHint: "以 ?s / ?p / ?o 为变量名返回三元组即可可视化；也可以用 CONSTRUCT 构造子图。" };

function queryTemplateFor(kind: GraphTargetKind | undefined): QueryTemplate {
  return kind === "JENA" ? JENA_QUERY_TEMPLATE : NEO4J_QUERY_TEMPLATE;
}

/** 只用于前端即时提示；真正的写保护在服务端按后端能力判断。 */
function isWriteStatement(kind: GraphTargetKind | undefined, statement: string) {
  return kind === "JENA"
    ? /\b(insert|delete|load|clear|create|drop|add|move|copy)\b/i.test(statement)
    : /\b(create|merge|delete|detach|set|remove|drop|alter)\b/i.test(statement);
}

function graphNoun(target: Target | null | undefined) {
  return target ? graphTargetKindInfo(target.kind).label : "图数据库";
}

const emptyDefinition: Definition = { entityTypes: [], relationshipTypes: [] };
const typeOptions: Property["dataType"][] = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function Notice({ message, error, onDismiss }: { message: string | null; error?: boolean; onDismiss?: () => void }) {
  if (!message) return null;
  return <div className={error ? "notice error" : "notice"}>{error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{message}{onDismiss && <button className="notice-close" onClick={onDismiss}><X size={14} /></button>}</div>;
}

function entityTitle(node: Pick<EntityRow, "labels" | "properties">, definition: Definition | null = null) {
  const entityType = definition?.entityTypes.find((item) => node.labels.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && node.properties[primary] != null) return String(node.properties[primary]);
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

type DisplaySettings = { entityLimit: number; relationshipLimit: number };
const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { entityLimit: 200, relationshipLimit: 200 };
const DISPLAY_SETTINGS_KEY = "atlas.display-settings";

function loadDisplaySettings(): DisplaySettings {
  if (typeof window === "undefined") return DEFAULT_DISPLAY_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISPLAY_SETTINGS_KEY) ?? "{}") as Partial<DisplaySettings>;
    return {
      entityLimit: clampLimit(parsed.entityLimit, DEFAULT_DISPLAY_SETTINGS.entityLimit, 1, 10000),
      relationshipLimit: clampLimit(parsed.relationshipLimit, DEFAULT_DISPLAY_SETTINGS.relationshipLimit, 1, 10000),
    };
  } catch { return DEFAULT_DISPLAY_SETTINGS; }
}

function useDisplaySettings() {
  const [settings, setSettings] = useState<DisplaySettings>(loadDisplaySettings);
  const update = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((current) => {
      const next: DisplaySettings = {
        entityLimit: clampLimit(patch.entityLimit, current.entityLimit, 1, 10000),
        relationshipLimit: clampLimit(patch.relationshipLimit, current.relationshipLimit, 1, 10000),
      };
      try { window.localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(DISPLAY_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_DISPLAY_SETTINGS); }, []);
  return { settings, update, reset };
}

const MANAGER_SPLIT_MIN_LEFT = 380;
const MANAGER_SPLIT_MIN_DETAIL = 380;
const MANAGER_SPLIT_HANDLE_WIDTH = 12;
const MANAGER_SPLIT_MAX_LEFT = 900;
const MANAGER_SPLIT_DEFAULT_LEFT = 520;

function readManagerSplitWidth(storageKey: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

function ResizableManagerGrid({ children, defaultWidth = MANAGER_SPLIT_DEFAULT_LEFT, storageKey }: { children: ReactNode; defaultWidth?: number; storageKey: string }) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => readManagerSplitWidth(storageKey, defaultWidth));
  const widthRef = useRef(width);

  const clampWidth = useCallback((value: number) => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const maxByContainer = containerWidth > 0
      ? containerWidth - MANAGER_SPLIT_MIN_DETAIL - MANAGER_SPLIT_HANDLE_WIDTH
      : MANAGER_SPLIT_MAX_LEFT;
    const max = Math.max(MANAGER_SPLIT_MIN_LEFT, Math.min(MANAGER_SPLIT_MAX_LEFT, maxByContainer));
    return Math.round(Math.min(Math.max(value, MANAGER_SPLIT_MIN_LEFT), max));
  }, []);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
  }, [clampWidth]);

  const persistWidth = useCallback(() => {
    try { window.localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* ignore unavailable storage */ }
  }, [storageKey]);

  useEffect(() => {
    applyWidth(widthRef.current);
    const onWindowResize = () => applyWidth(widthRef.current);
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [applyWidth]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const onMove = (moveEvent: PointerEvent) => {
      applyWidth(startWidth + moveEvent.clientX - startX);
    };
    const onEnd = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.body.classList.remove("resizing-manager-split");
      persistWidth();
    };
    document.body.classList.add("resizing-manager-split");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
  }, [applyWidth, persistWidth]);

  const resetWidth = useCallback(() => {
    applyWidth(defaultWidth);
    persistWidth();
  }, [applyWidth, defaultWidth, persistWidth]);

  const nudgeWidth = useCallback((delta: number) => {
    applyWidth(widthRef.current + delta);
    persistWidth();
  }, [applyWidth, persistWidth]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      nudgeWidth(event.key === "ArrowLeft" ? -24 : 24);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      resetWidth();
    }
  }, [nudgeWidth, resetWidth]);

  const items = Children.toArray(children);
  return <section className="manager-grid instance-manager-grid" ref={containerRef} style={{ "--manager-split-left": `${width}px` } as CSSProperties}>
    {items[0]}
    <div
      aria-label="拖动调整列表宽度"
      aria-orientation="vertical"
      aria-valuemax={MANAGER_SPLIT_MAX_LEFT}
      aria-valuemin={MANAGER_SPLIT_MIN_LEFT}
      aria-valuenow={Math.round(width)}
      className="manager-split-handle"
      onDoubleClick={resetWidth}
      onKeyDown={handleKeyDown}
      onPointerDown={beginResize}
      role="separator"
      tabIndex={0}
      title="拖动调整列表宽度，双击恢复默认"
    >
      <span aria-hidden="true" />
    </div>
    {items.slice(1)}
  </section>;
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
          {field("recordLimit", "单次记录上限", "单条只读查询最多获取并展示的记录条数（Cypher / SPARQL）。", 100000)}
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
  const [versions, setVersions] = useState<Version[]>([]);
  const [runtimeTypes, setRuntimeTypes] = useState<RuntimeTypeSet | null>(null);
  const [view, setView] = useState<View>("overview");
  const [newTargetOpen, setNewTargetOpen] = useState(false);
  const [graphMode, setGraphMode] = useState<"instances" | "ontology">("instances");
  const [graphModeTargetId, setGraphModeTargetId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings: displaySettings, update: updateDisplaySettings, reset: resetDisplaySettings } = useDisplaySettings();

  const selectedTarget = targets.find((target) => target.id === targetId) ?? null;
  const instanceGraphIsLarge = runtimeTypes !== null && (runtimeTypes.entityCount > 120 || runtimeTypes.relationshipCount > 300);
  const typeOverviewAffordable = runtimeTypes !== null && runtimeTypes.labels.length <= 80 && runtimeTypes.relationshipTypes.length <= 120;
  const preferredGraphMode: "instances" | "ontology" = instanceGraphIsLarge && typeOverviewAffordable ? "ontology" : "instances";
  const activeGraphMode = graphModeTargetId === targetId ? graphMode : preferredGraphMode;
  const workspaceVersion = draft ?? published;
  const definition = draft?.definition ?? published?.definition ?? emptyDefinition;

  const notify = (text: string) => { setMessage(text); setError(null); if (messageTimer.current) clearTimeout(messageTimer.current); messageTimer.current = setTimeout(() => setMessage(null), 5000); };
  const fail = (reason: unknown) => { setError(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "操作失败。"); setMessage(null); if (messageTimer.current) clearTimeout(messageTimer.current); };
  const dismiss = () => { setMessage(null); setError(null); if (messageTimer.current) clearTimeout(messageTimer.current); };

  const loadTargets = async () => {
    const data = await api<Target[]>("/api/targets");
    setTargets(data);
    setTargetId((current) => current || data[0]?.id || "");
  };

  const loadVersions = async (id: string) => {
    if (!id) return;
    const versions = await api<Version[]>(`/api/ontology?targetId=${encodeURIComponent(id)}`);
    const nextDraft = versions.find((item) => item.status === "DRAFT") ?? null;
    const nextPublished = versions.find((item) => item.status === "PUBLISHED") ?? null;
    setVersions(versions);
    setDraft(nextDraft);
    setPublished(nextPublished);
    const workspace = nextDraft ?? nextPublished;
    const versionParam = workspace ? `&versionId=${workspace.id}` : "";
    const types = await api<RuntimeTypeSet>(`/api/instances/types?targetId=${encodeURIComponent(id)}${versionParam}`);
    setRuntimeTypes(types);
  };

  useEffect(() => {
    api<{ user: User | null }>("/api/auth/session").then(async (data) => {
      setUser(data.user);
      if (data.user) await loadTargets();
    }).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!targetId) return;
    const handle = window.setTimeout(() => { void loadVersions(targetId).catch(fail); }, 0);
    return () => window.clearTimeout(handle);
  }, [targetId]);

  const refreshRuntimeTypes = () => { if (!targetId || !workspaceVersion) return; void api<RuntimeTypeSet>(`/api/instances/types?targetId=${encodeURIComponent(targetId)}&versionId=${workspaceVersion.id}`).then(setRuntimeTypes).catch(() => setRuntimeTypes(null)); };

  const ensureDraft = async () => {
    if (!targetId) throw new Error("请先登记并选择一个连接目标。");
    if (draft) return draft;
    const result = await api<{ id: string; versionNumber: number; entity_count?: number; relationship_count?: number }>("/api/ontology", { method: "POST", body: JSON.stringify({ targetId, definition: published?.definition ?? emptyDefinition }) });
    const next: Version = { id: result.id, target_id: targetId, version_number: result.versionNumber, status: "DRAFT", definition: published?.definition ?? emptyDefinition, entity_count: result.entity_count, relationship_count: result.relationship_count, artifact_path: "created" };
    setDraft(next);
    setVersions((current) => [next, ...current]);
    notify(`已创建草稿 v${result.versionNumber}。`);
    return next;
  };

  const saveDefinition = async (next: Definition) => {
    const current = await ensureDraft();
    const saved = await api<{ definition: Definition }>(`/api/ontology/${current.id}`, { method: "PATCH", body: JSON.stringify({ definition: next }) });
    setDraft({ ...current, definition: saved.definition });
    await loadVersions(targetId);
    notify("草稿已保存到 PostgreSQL。");
  };

  const validate = async () => {
    try { const current = await ensureDraft(); const result = await api<{ valid: boolean; violations: { message: string; count: number }[] }>(`/api/ontology/${current.id}/validate`, { method: "POST" }); result.valid ? notify("草稿校验通过，可以发布。") : fail(result.violations.map((item) => `${item.message} (${item.count})`).join("；")); } catch (reason) { fail(reason); }
  };

  const publish = async () => {
    try { const current = await ensureDraft(); const result = await api<{ published: boolean; strongRulesEnforced?: boolean; entityCount?: number; relationshipCount?: number; violations?: { message: string; count: number }[] }>(`/api/ontology/${current.id}/publish`, { method: "POST" }); if (result.published) { notify(`版本 v${current.version_number} 已发布：${result.entityCount ?? 0} 个实体、${result.relationshipCount ?? 0} 条关系已在 ${graphNoun(selectedTarget)} 生效。`); await loadVersions(targetId); } else if (result.violations?.length) { fail(result.violations.map((item) => `${item.message} (${item.count})`).join("；")); } } catch (reason) { fail(reason); }
  };

  const activateVersion = async (version: Version) => {
    if (draft) throw new Error("当前存在草稿，请先发布草稿后再切换历史版本。");
    const result = await api<{ published: boolean; entityCount: number; relationshipCount: number }>(`/api/ontology/${version.id}/activate`, { method: "POST" });
    notify(`已切换到 v${version.version_number}：${result.entityCount} 个实体、${result.relationshipCount} 条关系已重新导入 ${graphNoun(selectedTarget)}。`);
    await loadVersions(targetId);
  };

  const resetVersions = async () => {
    await loadVersions(targetId);
  };

  if (user === undefined) return <div className="loading-screen">正在加载 Ontology...</div>;
  if (!user) return <Login onSuccess={async (next) => { setUser(next); await loadTargets(); }} />;

  const userProp = user;

  return <main className="functional-shell">
    <aside className="functional-sidebar"><div className="functional-brand"><GitBranch size={23} /><span><b>ONTOLOGY</b><small>GRAPH GOVERNANCE</small></span></div><label className="target-picker"><span>当前连接目标</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">选择目标</option>{GRAPH_TARGET_KINDS.map((kindInfo) => { const group = targets.filter((item) => item.kind === kindInfo.kind); return group.length ? <optgroup key={kindInfo.kind} label={kindInfo.label}>{group.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup> : null; })}</select></label><nav>{([
      ["overview", "总览", Activity], ["ontology", "本体草稿", BookOpen], ["graph", "图谱", Network], ["entities", "实体", CircleDot], ["relations", "关系", Link2], ["targets", "连接目标", Database], ["settings", "设置", Settings2],
    ] as const).map(([id, label, Icon]) => <button key={id} className={view === id ? "functional-nav selected" : "functional-nav"} onClick={() => setView(id)}><Icon size={17} />{label}</button>)}</nav><div className="functional-user"><UserRound size={17} /><span><b>{user.email}</b><small>{user.role === "ADMIN" ? "管理员" : "查看者"}</small></span><button title="退出登录" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setUser(null); }}><LogOut size={16} /></button></div></aside>
    <section className="functional-content"><header><div><p>图谱治理 / {view}</p><h1>{selectedTarget?.name ?? "连接图数据库"}</h1></div><div className="header-state">{selectedTarget ? <><span className="state-dot" />{draft ? `编辑草稿 v${draft.version_number}` : published ? `运行版本 v${published.version_number}` : "尚未发布"}</> : "需要登记目标"}</div></header><Notice message={error ?? message} error={Boolean(error)} onDismiss={dismiss} />
      {selectedTarget && view !== "targets" && <VersionBar versions={versions} draft={draft} published={published} user={userProp} onCreate={() => ensureDraft()} onActivate={activateVersion} fail={fail} />}
      {view === "overview" && <Overview target={selectedTarget} draft={draft} published={published} runtimeTypes={runtimeTypes} onNavigate={setView} onOpenOntology={() => { setGraphMode("ontology"); setGraphModeTargetId(targetId); setView("graph"); }} />}
      {view === "targets" && <TargetManager targets={targets} refresh={loadTargets} selectedId={targetId} onSelect={(id) => { setTargetId(id); setView("overview"); }} onNew={() => setNewTargetOpen(true)} notify={notify} fail={fail} />}
      {newTargetOpen && <NewTargetDialog onClose={() => setNewTargetOpen(false)} onCreated={async (target) => { await loadTargets(); setTargetId(target.id); setView("overview"); setNewTargetOpen(false); }} notify={notify} fail={fail} />}
      {view === "ontology" && <OntologyManager definition={definition} draft={draft} user={userProp} runtimeTypes={runtimeTypes} refreshRuntimeTypes={refreshRuntimeTypes} save={saveDefinition} validate={validate} publish={publish} notify={notify} fail={fail} />}
      {view === "graph" && <GraphManager target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} mode={activeGraphMode} onModeChange={(mode) => { setGraphMode(mode); setGraphModeTargetId(targetId); }} onSnapshotChange={() => loadVersions(targetId)} notify={notify} fail={fail} />}
      {view === "relations" && <RelationshipManager target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} ensureDraft={ensureDraft} onSnapshotChange={() => loadVersions(targetId)} notify={notify} fail={fail} relationshipLimit={displaySettings.relationshipLimit} />}
      {view === "entities" && <EntityManager target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} ensureDraft={ensureDraft} onSnapshotChange={() => loadVersions(targetId)} notify={notify} fail={fail} entityLimit={displaySettings.entityLimit} />}
      {view === "settings" && <SettingsManager target={selectedTarget} user={userProp} versions={versions} displaySettings={displaySettings} onSaveDisplaySettings={updateDisplaySettings} onResetDisplaySettings={resetDisplaySettings} onReset={resetVersions} notify={notify} fail={fail} />}
    </section>
  </main>;
}

function VersionBar({ versions, draft, published, user, onCreate, onActivate, fail }: { versions: Version[]; draft: Version | null; published: Version | null; user: User; onCreate: () => Promise<Version>; onActivate: (version: Version) => Promise<void>; fail: (reason: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const activate = async (version: Version) => {
    if (!window.confirm(`确认将图数据切换到历史版本 v${version.version_number}？当前图数据会由该版本快照完整替换。`)) return;
    try { setBusyId(version.id); await onActivate(version); setOpen(false); } catch (reason) { fail(reason); } finally { setBusyId(null); }
  };
  return <div className="version-bar"><div><GitBranch size={16} /><span><b>{draft ? `草稿 v${draft.version_number}` : published ? `已发布 v${published.version_number}` : "尚无版本"}</b><small>{draft ? `${draft.entity_count ?? 0} 个实体 · ${draft.relationship_count ?? 0} 条关系，修改仅保存到快照文件` : published ? `${published.entity_count ?? 0} 个实体 · ${published.relationship_count ?? 0} 条关系正在图数据库中生效` : "创建首个草稿以导入当前图数据"}</small></span></div><div className="functional-actions">{user.role === "ADMIN" && !draft && <button className="action primary" onClick={() => void onCreate().catch(fail)}><Plus size={14} />创建草稿</button>}<button className="action" onClick={() => setOpen((value) => !value)}><History size={14} />版本记录</button></div>{open && <div className="version-menu">{versions.map((version) => <div className="version-menu-row" key={version.id}><span><b>v{version.version_number}</b><small>{version.status === "DRAFT" ? "草稿" : version.status === "PUBLISHED" ? "当前生效" : "历史归档"}</small></span><span>{version.entity_count ?? 0} 实体 · {version.relationship_count ?? 0} 关系</span>{version.artifact_path ? <code>{version.content_hash?.slice(0, 10) ?? "snapshot"}</code> : <em>无实例快照</em>}{user.role === "ADMIN" && version.status === "ARCHIVED" && <button className="action compact" disabled={Boolean(draft) || !version.artifact_path || busyId === version.id} onClick={() => void activate(version)} title={!version.artifact_path ? "旧版本未保存实例快照，不能激活" : draft ? "请先发布当前草稿" : "重新导入该版本快照"}><RotateCcw size={13} />{busyId === version.id ? "切换中" : "激活"}</button>}</div>)}{!versions.length && <p className="empty">尚无版本记录。</p>}</div>}</div>;
}

function SettingsManager({ target, user, versions, displaySettings, onSaveDisplaySettings, onResetDisplaySettings, onReset, notify, fail }: { target: Target | null; user: User; versions: Version[]; displaySettings: DisplaySettings; onSaveDisplaySettings: (next: DisplaySettings) => void; onResetDisplaySettings: () => void; onReset: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [draft, setDraft] = useState<DisplaySettings>(displaySettings);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

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
      <p className="subtle">「实体」与「关系」列表页每次加载时默认展示的记录数量，保存后即时生效。</p>
      <div className="settings-grid">
        <label className="settings-field"><span>实体展示条数</span><input type="number" min={1} max={10000} value={draft.entityLimit} onChange={(event) => setDraft({ ...draft, entityLimit: Number(event.target.value) })} /><small>实体列表单次加载最多返回的节点数量。</small></label>
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
        <p className="subtle">将当前目标「{target.name}」的全部版本记录（共 {versions.length} 个）与对应快照文件删除，回到「尚无版本」状态。图数据不受影响，下次创建草稿时从当前图数据重新导出。</p>
        <div className="functional-actions">
          <button className="action danger" disabled={user.role !== "ADMIN" || resetting} onClick={() => setConfirmOpen(true)}><RotateCcw size={15} />{resetting ? "初始化中…" : "初始化版本数据"}</button>
        </div>
      </> : <p className="empty">请先选择一个连接目标。</p>}
    </div>
    {confirmOpen && target && <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); void initialize(); }}><button type="button" className="close-button" onClick={() => setConfirmOpen(false)} title="关闭"><X size={18} /></button><div className="dialog-icon"><RotateCcw size={22} /></div><span className="eyebrow">危险操作</span><h2>初始化「{target.name}」？</h2><p>将删除该目标的 {versions.length} 个版本记录及全部快照文件，此操作无法撤销。图数据不会被修改。</p><div className="dialog-actions"><button type="button" className="quiet-button" onClick={() => setConfirmOpen(false)}>取消</button><button className="primary-button" disabled={resetting}>{resetting ? "初始化中…" : "确认初始化"}</button></div></form></div>}
  </section>;
}

function Login({ onSuccess }: { onSuccess: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState("admin@example.com"); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  return <main className="login-screen"><form className="login-card" onSubmit={async (event) => { event.preventDefault(); try { setError(""); const user = await api<User>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); await onSuccess(user); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } }}><div className="login-mark"><GitBranch size={25} /></div><p>ONTOLOGY CONTROL</p><h1>登录本体平台</h1><label>邮箱<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required autoFocus /></label><Notice message={error || null} error /><button className="action primary" type="submit">登录</button></form></main>;
}

function censusRows(rows: RuntimeTypeInfo[], total: number, family: "entity" | "relation") {
  return rows.map((item) => (
    <div className="census-row" key={item.name}>
      <span className="census-name" title={item.name}>{item.name}</span>
      <span className={family === "entity" ? "census-track entity" : "census-track relation"}><i style={{ width: total ? `${Math.round((item.count / total) * 100)}%` : "0%" }} /></span>
      <span className="census-count">{item.count.toLocaleString()}</span>
    </div>
  ));
}

function Overview({ target, draft, published, runtimeTypes, onNavigate, onOpenOntology }: { target: Target | null; draft: Version | null; published: Version | null; runtimeTypes: RuntimeTypeSet | null; onNavigate: (view: View) => void; onOpenOntology: () => void }) {
  const entityTypes = runtimeTypes?.labels.length ?? published?.definition.entityTypes.length ?? 0;
  const relationshipTypes = runtimeTypes?.relationshipTypes.length ?? published?.definition.relationshipTypes.length ?? 0;
  const entities = runtimeTypes?.entityCount ?? runtimeTypes?.labels.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const relationships = runtimeTypes?.relationshipCount ?? runtimeTypes?.relationshipTypes.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const entityRows = [...(runtimeTypes?.labels ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  const relationRows = [...(runtimeTypes?.relationshipTypes ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  const entityTotal = entityRows.reduce((sum, item) => sum + item.count, 0);
  const relationTotal = relationRows.reduce((sum, item) => sum + item.count, 0);
  const hasCensus = runtimeTypes !== null;
  return <section className="panel functional-panel overview-panel"><span className="eyebrow">本体控制室</span><h2>{target ? "本体与运行时状态" : "开始登记第一个目标"}</h2>{target ? <><div className="overview-stats"><div className="overview-stat"><b>{entityTypes}</b><span>实体类型</span><small>数据库中的标签</small></div><div className="overview-stat"><b>{entities}</b><span>实体</span><small>数据库中的节点</small></div><div className="overview-stat"><b>{relationshipTypes}</b><span>关系类型</span><small>数据库中的关系类型</small></div><div className="overview-stat"><b>{relationships}</b><span>关系</span><small>数据库中的关系</small></div></div><div className="overview-status"><span>草稿：<b>{draft ? `v${draft.version_number}` : "无"}</b></span><span>已发布：<b>{published ? `v${published.version_number}` : "无"}</b></span></div>{hasCensus && (entityTotal + relationTotal > 0 ? <div className="overview-census"><section className="census-panel entity"><div className="census-head"><CircleDot size={15} /><span>实体类型分布</span><b>{entityRows.length}</b></div>{censusRows(entityRows, entityTotal, "entity")}</section><section className="census-panel relation"><div className="census-head"><Link2 size={15} /><span>关系类型分布</span><b>{relationRows.length}</b></div>{censusRows(relationRows, relationTotal, "relation")}</section></div> : <div className="overview-census-empty">图数据库中还没有数据。在「图谱」页创建节点与关系后，这里会展示每种实体类型与关系类型的数量分布。</div>)}</> : <p>先在“连接目标”登记目标图数据库的连接信息，凭据会加密保存。</p>}<div className="functional-actions">{target && <button className="action" onClick={() => onNavigate("graph")}><Network size={16} />打开图谱管理</button>}{target && <button className="action" onClick={() => onNavigate("ontology")}><BookOpen size={16} />配置本体草稿</button>}<button className="action primary" onClick={() => target ? onOpenOntology() : onNavigate("targets")}><span className="arrow">→</span>{target ? "查看本体" : "登记连接目标"}</button></div></section>;
}

type TargetFormState = { name: string; kind: GraphTargetKind; uri: string; databaseName: string; username: string; password: string; namedGraph: string };

function defaultTargetForm(kind: GraphTargetKind): TargetFormState {
  const info = graphTargetKindInfo(kind);
  return { name: "", kind, uri: info.endpoint.example, databaseName: info.dataset?.example ?? "", username: info.credentials.usernameExample, password: "", namedGraph: "" };
}

function formFromTarget(target: Target): TargetFormState {
  const namedGraph = target.options?.namedGraph;
  return { name: target.name, kind: target.kind, uri: target.uri, databaseName: target.databaseName, username: target.username, password: "", namedGraph: typeof namedGraph === "string" ? namedGraph : "" };
}

function targetOptions(form: TargetFormState) {
  return form.namedGraph.trim() ? { namedGraph: form.namedGraph.trim() } : {};
}

/** 连接字段由后端类型元数据驱动，接入新的图数据库时这里不需要改动。 */
function TargetFields({ form, setForm, editing = false, showKind = true }: { form: TargetFormState; setForm: (next: TargetFormState) => void; editing?: boolean; showKind?: boolean }) {
  const info = graphTargetKindInfo(form.kind);
  const credentialRequired = info.credentials.required;
  return <>
    <label>目标名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：生产知识图谱" required /></label>
    {showKind && <div className="field-block"><span>数据库类型</span><GraphKindPicker value={form.kind} onChange={(kind) => setForm({ ...defaultTargetForm(kind), name: form.name })} /></div>}
    <label>{info.endpoint.label}<input value={form.uri} onChange={(event) => setForm({ ...form, uri: event.target.value })} placeholder={info.endpoint.placeholder} required /></label>
    {info.dataset && <label>{info.dataset.label}<input value={form.databaseName} onChange={(event) => setForm({ ...form, databaseName: event.target.value })} placeholder={info.dataset.placeholder} required /></label>}
    {form.kind === "JENA" && <label>命名图（可选）<input value={form.namedGraph} onChange={(event) => setForm({ ...form, namedGraph: event.target.value })} placeholder="留空写入默认图，例如 urn:ontology" /></label>}
    <label>{info.credentials.usernameLabel}<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder={info.credentials.usernameExample} required={credentialRequired} /></label>
    <label>{info.credentials.passwordLabel}<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={editing ? "留空保持不变" : ""} required={credentialRequired && !editing} /></label>
  </>;
}

function TargetManager({ targets, refresh, selectedId, onSelect, onNew, notify, fail }: { targets: Target[]; refresh: () => Promise<void>; selectedId: string; onSelect: (id: string) => void; onNew: () => void; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [testing, setTesting] = useState(""); const [editing, setEditing] = useState<Target | null>(null); const [deleting, setDeleting] = useState("");
  const remove = async (target: Target) => { if (!window.confirm(`确定删除目标“${target.name}”及其全部本体版本？`)) return; try { setDeleting(target.id); await api(`/api/targets/${target.id}`, { method: "DELETE" }); notify("目标已删除。"); await refresh(); } catch (reason) { fail(reason); } finally { setDeleting(""); } };
  const groups = GRAPH_TARGET_KINDS.map((info) => ({ info, items: targets.filter((item) => item.kind === info.kind) }));
  const census = groups.filter((group) => group.items.length).map((group) => `${graphTargetKindInfo(group.info.kind).label} ${group.items.length}`).join(" · ");
  return <section className="stack">
    <div className="panel functional-panel target-action-bar"><div><span className="eyebrow">连接目标</span><b>{targets.length} 个已登记目标</b><p className="subtle">{census ? `按图数据库类型分组：${census}。` : "还没有登记任何图数据库连接。"}凭据以 AES-256-GCM 加密保存在平台库，只有服务端能解密。</p></div><button className="action primary" onClick={onNew}><Plus size={15} />新建连接</button></div>
    <div className="panel functional-panel target-list">{targets.length ? groups.map(({ info, items }) => items.length ? <div className="target-group" key={info.kind}><div className="target-group-head"><GraphKindBadge kind={info.kind} /><small>{info.description}</small></div>{items.map((target) => <div className={target.id === selectedId ? "target-row current" : "target-row"} key={target.id}><Database size={18} /><span><b>{target.name}</b><small>{target.uri} / {target.databaseName}</small></span>{target.id === selectedId ? <span className="target-current"><Check size={12} />当前目标</span> : <button className="action compact" onClick={() => onSelect(target.id)}>打开</button>}<button className="action compact" disabled={testing === target.id} onClick={async () => { try { setTesting(target.id); const health = await api<{ connected: boolean; agent: string }>(`/api/targets/${target.id}/test`, { method: "POST" }); notify(`连接成功：${health.agent}`); } catch (reason) { fail(reason); } finally { setTesting(""); } }}>{testing === target.id ? "测试中" : "测试连接"}</button><button className="action compact" onClick={() => setEditing(target)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={deleting === target.id} onClick={() => void remove(target)}><Trash2 size={13} />{deleting === target.id ? "删除中" : "删除"}</button></div>)}</div> : null) : <div className="target-empty"><Database size={22} /><b>还没有连接目标</b><span>点右上角「新建连接」，先选图数据库类型，再填连接信息。</span></div>}</div>
    {editing && <TargetEditDialog target={editing} onClose={() => setEditing(null)} onSaved={async () => { await refresh(); notify("目标已更新。"); }} fail={fail} />}
  </section>;
}

/** 新建连接：先选类型，再填连接信息。两步都收在同一个弹窗里，页面不再常驻一张空表单。 */
function NewTargetDialog({ onClose, onCreated, notify, fail }: { onClose: () => void; onCreated: (target: Target) => void | Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [kind, setKind] = useState<GraphTargetKind>("NEO4J");
  const [form, setForm] = useState<TargetFormState>(() => defaultTargetForm("NEO4J"));
  const [busy, setBusy] = useState(false);
  const info = graphTargetKindInfo(kind);

  useEffect(() => {
    // 这里要的是浏览器原生事件；本文件里的 KeyboardEvent 是 React 的那个同名类型。
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pickKind = (next: GraphTargetKind) => { setKind(next); setForm((current) => ({ ...defaultTargetForm(next), name: current.name })); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      const target = await api<Target>("/api/targets", { method: "POST", body: JSON.stringify({ ...form, options: targetOptions(form) }) });
      notify(`${graphTargetKindInfo(target.kind).label} 目标已登记，凭据已加密保存。`);
      await onCreated(target);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog graph-dialog new-target-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
      <span className="eyebrow">新建连接 · 步骤 {step} / 2</span>
      <h2>{step === 1 ? "选择图数据库类型" : `连接 ${info.label}`}</h2>
      <p>{step === 1 ? "类型决定这个目标用什么查询语言、按什么模型存图。" : info.description}</p>
      <ol className="wizard-steps">
        <li className={step === 1 ? "active" : "done"}><span>{step === 1 ? "1" : <Check size={12} />}</span>选择类型<em>{info.label}</em></li>
        <li className={step === 2 ? "active" : ""}><span>2</span>填写连接信息</li>
      </ol>
      {step === 1
        ? <GraphKindChoice value={kind} onChange={pickKind} />
        : <div className="dialog-form"><TargetFields form={form} setForm={setForm} showKind={false} /></div>}
      <div className="kind-picker-foot">
        <span className="kind-picker-summary"><GraphKindMark mark={info.mark} accent={info.accent} size={16} />{info.label}<code>{capabilityLine(info)}</code></span>
        <div className="functional-actions">
          {step === 2 && <button type="button" className="quiet-button" onClick={() => setStep(1)}>上一步</button>}
          {step === 1
            ? <><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={() => setStep(2)}>下一步</button></>
            : <button className="primary-button" disabled={busy}>{busy ? "登记中…" : "登记并选择"}</button>}
        </div>
      </div>
    </form>
  </div>;
}

function TargetEditDialog({ target, onClose, onSaved, fail }: { target: Target; onClose: () => void; onSaved: () => Promise<void>; fail: (reason: unknown) => void }) {
  const [form, setForm] = useState<TargetFormState>(() => formFromTarget(target));
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => { event.preventDefault(); try { setBusy(true); const payload: Record<string, unknown> = { name: form.name, kind: form.kind, uri: form.uri, databaseName: form.databaseName, username: form.username, options: targetOptions(form) }; if (form.password) payload.password = form.password; await api<Target>(`/api/targets/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) }); await onSaved(); onClose(); } catch (reason) { fail(reason); } finally { setBusy(false); } };
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={save}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Database size={22} /></div><span className="eyebrow">编辑目标</span><h2>{target.name}</h2><p>修改连接信息；密码留空表示保持原密码不变。</p><TargetFields form={form} setForm={setForm} editing /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存修改"}</button></div></form></div>;
}

function OntologyManager({ definition, draft, user, runtimeTypes, refreshRuntimeTypes, save, validate, publish, notify, fail }: { definition: Definition; draft: Version | null; user: User; runtimeTypes: RuntimeTypeSet | null; refreshRuntimeTypes: () => void; save: (definition: Definition) => Promise<void>; validate: () => Promise<void>; publish: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [rel, setRel] = useState({ name: "", source: "", target: "" });
  const [editingEntity, setEditingEntity] = useState<EntityType | null>(null);
  const [editingRelation, setEditingRelation] = useState<RelationType | null>(null);
  const [tab, setTab] = useState<"entity" | "relation">("entity");
  const [importPlan, setImportPlan] = useState<{ newEntities: EntityType[]; newRelations: RelationType[]; mergedEntities: EntityType[]; mergedRelations: RelationType[]; changedEntities: number; changedRelations: number; unresolved: number; inferredProperties: number } | null>(null);
  const switchTab = (next: "entity" | "relation") => { setTab(next); };
  const addEntity = async (event: FormEvent) => { event.preventDefault(); try { if (!name.trim()) return; if (definition.entityTypes.some((item) => item.name === name.trim())) throw new Error("实体类型名称已存在。"); await save({ ...definition, entityTypes: [...definition.entityTypes, { id: crypto.randomUUID(), name: name.trim(), description: description.trim(), properties: [] }] }); setName(""); setDescription(""); } catch (reason) { fail(reason); } };
  const addRelation = async (event: FormEvent) => { event.preventDefault(); try { if (!rel.name || !rel.source || !rel.target) throw new Error("请填写关系类型和两个端点。"); await save({ ...definition, relationshipTypes: [...definition.relationshipTypes, { id: crypto.randomUUID(), name: rel.name, sourceEntityTypeId: rel.source, targetEntityTypeId: rel.target, properties: [] }] }); setRel({ name: "", source: "", target: "" }); } catch (reason) { fail(reason); } };
  const updateEntity = async (id: string, patch: { name: string; description: string; displayProperty?: string; properties: Property[] }) => { try { const next = structuredClone(definition); const idx = next.entityTypes.findIndex((item) => item.id === id); if (idx < 0) return; if (next.entityTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("实体类型名称已存在。"); next.entityTypes[idx] = { ...next.entityTypes[idx], name: patch.name.trim(), description: patch.description.trim(), displayProperty: (patch.displayProperty ?? "").trim(), properties: patch.properties }; await save(next); notify("实体类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const updateRelation = async (id: string, patch: { name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] }) => { try { const next = structuredClone(definition); const idx = next.relationshipTypes.findIndex((item) => item.id === id); if (idx < 0) return; if (next.relationshipTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("关系类型名称已存在。"); next.relationshipTypes[idx] = { ...next.relationshipTypes[idx], name: patch.name.trim(), sourceEntityTypeId: patch.sourceEntityTypeId, targetEntityTypeId: patch.targetEntityTypeId, properties: patch.properties }; await save(next); notify("关系类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const deleteEntity = async (id: string) => { const item = definition.entityTypes.find((entry) => entry.id === id); if (!item) return; const affectedRelations = definition.relationshipTypes.filter((entry) => entry.sourceEntityTypeId === id || entry.targetEntityTypeId === id); if (!window.confirm(`删除实体类型「${item.name}」？${affectedRelations.length ? `引用该类型的 ${affectedRelations.length} 个关系类型（${affectedRelations.map((entry) => entry.name).join("、")}）将一并删除。` : "该类型的属性定义将一并删除。"}`)) return; try { const next = structuredClone(definition); next.entityTypes = next.entityTypes.filter((entry) => entry.id !== id); next.relationshipTypes = next.relationshipTypes.filter((entry) => entry.sourceEntityTypeId !== id && entry.targetEntityTypeId !== id); await save(next); notify("实体类型已从草稿中移除。"); } catch (reason) { fail(reason); } };
  const deleteRelation = async (id: string) => { const item = definition.relationshipTypes.find((entry) => entry.id === id); if (!item) return; if (!window.confirm(`删除关系类型「${item.name}」？该类型的属性定义将一并删除。`)) return; try { const next = structuredClone(definition); next.relationshipTypes = next.relationshipTypes.filter((entry) => entry.id !== id); await save(next); notify("关系类型已从草稿中移除。"); } catch (reason) { fail(reason); } };
  const extractTypesFromSnapshot = () => {
    if (!runtimeTypes) return;
    const entityNames = new Set(definition.entityTypes.map((item) => item.name));
    const newEntities: EntityType[] = runtimeTypes.labels.filter((item) => !entityNames.has(item.name)).map((item) => ({ id: crypto.randomUUID(), name: item.name, description: "", displayProperty: "", properties: item.properties ?? [] }));
    const entityIdByName = new Map<string, string>([...definition.entityTypes, ...newEntities].map((item) => [item.name, item.id]));
    const endpoints = runtimeTypes.relationshipEndpoints ?? {};
    const resolve = (label: string | undefined) => (label ? entityIdByName.get(label) ?? "" : "");
    const newRelations: RelationType[] = runtimeTypes.relationshipTypes.filter((item) => !definition.relationshipTypes.some((existing) => existing.name === item.name)).map((item) => {
      const endpoint = endpoints[item.name];
      return { id: crypto.randomUUID(), name: item.name, sourceEntityTypeId: resolve(endpoint?.source), targetEntityTypeId: resolve(endpoint?.target), properties: item.properties ?? [] };
    });
    const mergedEntities = definition.entityTypes.map((item) => {
      if (item.properties.length) return item;
      const inferred = runtimeTypes.labels.find((label) => label.name === item.name)?.properties ?? [];
      return inferred.length ? { ...item, properties: inferred } : item;
    });
    const mergedRelations = definition.relationshipTypes.map((item) => {
      const endpoint = endpoints[item.name];
      const validEntityIds = new Set([...definition.entityTypes, ...newEntities].map((entity) => entity.id));
      const keepOrResolve = (id: string | undefined, label: string | undefined) => (id && validEntityIds.has(id) ? id : resolve(label));
      const sourceEntityTypeId = keepOrResolve(item.sourceEntityTypeId, endpoint?.source);
      const targetEntityTypeId = keepOrResolve(item.targetEntityTypeId, endpoint?.target);
      let properties = item.properties;
      if (!properties.length) {
        const inferred = runtimeTypes.relationshipTypes.find((rel) => rel.name === item.name)?.properties ?? [];
        if (inferred.length) properties = inferred;
      }
      if (sourceEntityTypeId === item.sourceEntityTypeId && targetEntityTypeId === item.targetEntityTypeId && properties === item.properties) return item;
      return { ...item, sourceEntityTypeId, targetEntityTypeId, properties };
    });
    const changedRelations = mergedRelations.filter((item, index) => item.sourceEntityTypeId !== definition.relationshipTypes[index].sourceEntityTypeId || item.targetEntityTypeId !== definition.relationshipTypes[index].targetEntityTypeId || item.properties !== definition.relationshipTypes[index].properties).length;
    const changedEntities = mergedEntities.filter((item, index) => item.properties !== definition.entityTypes[index].properties).length;
    const unresolved = [...mergedRelations, ...newRelations].filter((item) => !item.sourceEntityTypeId || !item.targetEntityTypeId).length;
    const inferredProperties = newEntities.reduce((sum, item) => sum + item.properties.length, 0) + newRelations.reduce((sum, item) => sum + item.properties.length, 0);
    setImportPlan({ newEntities, newRelations, mergedEntities, mergedRelations, changedEntities, changedRelations, unresolved, inferredProperties });
  };
  const mergeImport = async () => {
    const plan = importPlan;
    if (!plan) return;
    setImportPlan(null);
    if (!plan.newEntities.length && !plan.newRelations.length && !plan.changedEntities && !plan.changedRelations) { notify("快照中的类型已全部在草稿中，草稿未变化。"); return; }
    try { await save({ ...definition, entityTypes: [...plan.mergedEntities, ...plan.newEntities], relationshipTypes: [...plan.mergedRelations, ...plan.newRelations] }); notify("已从快照提取类型并合并到草稿。"); } catch (reason) { fail(reason); }
  };
  const overwriteImport = async () => {
    if (!runtimeTypes) return;
    setImportPlan(null);
    const entityIdByName = new Map<string, string>(runtimeTypes.labels.map((item) => [item.name, crypto.randomUUID()]));
    const endpoints = runtimeTypes.relationshipEndpoints ?? {};
    const resolve = (label: string | undefined) => (label ? entityIdByName.get(label) ?? "" : "");
    const entityTypes: EntityType[] = runtimeTypes.labels.map((item) => ({ id: entityIdByName.get(item.name) ?? "", name: item.name, description: "", displayProperty: "", properties: item.properties ?? [] }));
    const relationshipTypes: RelationType[] = runtimeTypes.relationshipTypes.map((item) => {
      const endpoint = endpoints[item.name];
      return { id: crypto.randomUUID(), name: item.name, sourceEntityTypeId: resolve(endpoint?.source), targetEntityTypeId: resolve(endpoint?.target), properties: item.properties ?? [] };
    });
    try { await save({ ...definition, entityTypes, relationshipTypes }); notify("已用快照中的类型覆盖草稿。"); } catch (reason) { fail(reason); }
  };
  const copyGrass = async () => {
    const rules = definition.entityTypes.filter((item) => item.displayProperty).map((item) => `node.${item.name} {\n  caption: "{${item.displayProperty}}";\n}`);
    const content = ["/* Ontology 导出：Neo4j Browser 样式（GraSS）。运行 :style 打开样式查看器，粘贴以下规则或另存为 .grass 后拖入即可。 */", ...rules].join("\n");
    try { await navigator.clipboard.writeText(content); notify("已复制 Neo4j Browser 显示样式规则。"); } catch (reason) { fail(reason); }
  };
  return <section className="stack"><div className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">本体草稿</span><h2>{draft ? `v${draft.version_number} · 未发布` : "尚无草稿"}</h2></div><div className="functional-actions"><button className="action" disabled={user.role !== "ADMIN" || !runtimeTypes} onClick={() => void extractTypesFromSnapshot()} title="从当前版本快照提取实体和关系类型并合并到草稿"><Database size={16} />从快照提取类型</button><button className="action" onClick={refreshRuntimeTypes} title="重新读取当前版本快照中的实体、关系、端点和属性推断"><RefreshCcw size={16} />刷新快照数据</button><button className="action" onClick={() => void copyGrass()} title="生成可在 Neo4j Browser 样式查看器（:style）使用的节点 caption 规则"><TableProperties size={16} />复制显示样式</button><button className="action" disabled={user.role !== "ADMIN"} onClick={() => validate().catch(fail)}><FileCheck2 size={16} />校验</button><button className="action primary" disabled={user.role !== "ADMIN"} onClick={() => publish().catch(fail)}><ShieldCheck size={16} />发布</button></div></div><p className="subtle">类型修改会先保存为草稿；发布前将检查快照中的实体和关系、端点契约及必填属性。请先在下方切换到「实体类型」或「关系类型」标签，再对单个类型点击「编辑」一并配置其属性。</p></div><div className="graph-view-switcher" aria-label="本体编辑视图"><button className={tab === "entity" ? "active" : ""} aria-pressed={tab === "entity"} onClick={() => switchTab("entity")}>实体类型</button><button className={tab === "relation" ? "active" : ""} aria-pressed={tab === "relation"} onClick={() => switchTab("relation")}>关系类型</button></div>{tab === "entity" ? <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addEntity}><span className="eyebrow">实体类型</span><h2>新增实体类型</h2><label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户" required /></label><label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label><button className="action primary"><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">实体类型清单</span><h2>{definition.entityTypes.length} 个实体类型</h2>{definition.entityTypes.map((item) => <div className="type-row" key={item.id}><CircleDot size={17} /><b>{item.name}</b><span>{item.description || "未填写说明"}</span><em>{item.properties.length} 属性</em><button className="action compact" disabled={user.role !== "ADMIN"} onClick={() => setEditingEntity(item)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={user.role !== "ADMIN"} onClick={() => void deleteEntity(item.id)}><Trash2 size={13} />删除</button></div>)}{!definition.entityTypes.length && <p className="empty">尚未创建实体类型。</p>}</div></div> : <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addRelation}><span className="eyebrow">关系契约</span><h2>新增关系类型</h2><label>关系名称<input value={rel.name} onChange={(event) => setRel({ ...rel, name: event.target.value })} placeholder="例如：负责" required /></label><label>起始实体类型<select value={rel.source} onChange={(event) => setRel({ ...rel, source: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>终止实体类型<select value={rel.target} onChange={(event) => setRel({ ...rel, target: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="action primary"><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">关系契约清单</span><h2>{definition.relationshipTypes.length} 个关系类型</h2>{definition.relationshipTypes.map((item) => <div className="type-row" key={item.id}><Link2 size={17} /><b>{item.name}</b><span>{item.sourceEntityTypeId ? definition.entityTypes.find((e) => e.id === item.sourceEntityTypeId)?.name ?? "?" : "未指定"} → {item.targetEntityTypeId ? definition.entityTypes.find((e) => e.id === item.targetEntityTypeId)?.name ?? "?" : "未指定"}</span><em>{item.properties.length} 属性</em><button className="action compact" disabled={user.role !== "ADMIN"} onClick={() => setEditingRelation(item)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={user.role !== "ADMIN"} onClick={() => void deleteRelation(item.id)}><Trash2 size={13} />删除</button></div>)}{!definition.relationshipTypes.length && <p className="empty">尚未创建关系类型。</p>}</div></div>}{editingEntity && <TypeEditDialog kind="entity" entity={editingEntity} entityTypes={definition.entityTypes} onClose={() => setEditingEntity(null)} onSave={async (payload) => { await updateEntity(editingEntity.id, { name: payload.name, description: payload.description ?? "", displayProperty: payload.displayProperty ?? "", properties: payload.properties }); setEditingEntity(null); }} />}{editingRelation && <TypeEditDialog kind="relation" relation={editingRelation} entityTypes={definition.entityTypes} onClose={() => setEditingRelation(null)} onSave={async (payload) => { await updateRelation(editingRelation.id, { name: payload.name, sourceEntityTypeId: payload.sourceEntityTypeId ?? "", targetEntityTypeId: payload.targetEntityTypeId ?? "", properties: payload.properties }); setEditingRelation(null); }} />}{importPlan && <div className="dialog-backdrop" role="presentation"><div className="dialog graph-dialog"><button type="button" className="close-button" onClick={() => setImportPlan(null)} title="关闭"><X size={18} /></button><div className="dialog-icon"><Database size={22} /></div><span className="eyebrow">从快照提取类型</span><h2>选择提取方式</h2><p>当前快照中共有 {runtimeTypes?.labels.length ?? 0} 个标签、{runtimeTypes?.relationshipTypes.length ?? 0} 个关系类型。{importPlan.newEntities.length || importPlan.newRelations.length ? <>草稿缺少 {importPlan.newEntities.length} 个实体类型、{importPlan.newRelations.length} 个关系类型；</> : <>草稿已包含快照中的全部类型；</>}{importPlan.changedRelations || importPlan.changedEntities ? <>可为 {importPlan.changedEntities} 个已有实体类型、{importPlan.changedRelations} 个已有关系类型补齐属性或端点。</> : ""}</p><p>属性将按现有数据推断：名称、取值类型，以及是否必填（该类型全部实例均含此键）与是否唯一（取值互不相同），共约 {importPlan.inferredProperties} 个属性。<br /><b>合并</b>：保留草稿中的现有配置，仅补充缺失类型并为空属性、空端点补齐。<br /><b>覆盖</b>：用快照类型整体替换草稿的类型清单，草稿中已配置的说明、显示属性与属性定义会被清空。</p>{importPlan.unresolved > 0 && <p>{importPlan.unresolved} 个关系类型仍无法确定起始/终止实体类型，导入后需手动补选。</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={() => setImportPlan(null)}>取消</button><button type="button" className="action" onClick={() => void mergeImport()}><Merge size={16} />合并</button><button type="button" className="action primary" onClick={() => void overwriteImport()}><RefreshCcw size={16} />覆盖</button></div></div></div>}</section>;
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
const SPARQL_KEYWORDS = ["SELECT", "DISTINCT", "WHERE", "PREFIX", "BASE", "CONSTRUCT", "DESCRIBE", "ASK", "FROM", "NAMED", "OPTIONAL", "UNION", "MINUS", "FILTER", "BIND", "VALUES", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "ASC", "DESC", "AS", "GRAPH", "SERVICE", "EXISTS", "NOT EXISTS", "STR", "LANG", "DATATYPE", "BOUND", "IRI", "STRUUID", "REGEX", "REPLACE", "CONCAT", "SUBSTR", "STRLEN", "UCASE", "LCASE", "CONTAINS", "STRSTARTS", "STRENDS", "COUNT", "SUM", "AVG", "MIN", "MAX", "SAMPLE", "GROUP_CONCAT"];
const DEFAULT_SPARQL_SUGGESTIONS: CypherSuggestion[] = ["SELECT", "WHERE", "PREFIX", "CONSTRUCT", "ASK", "OPTIONAL", "FILTER", "UNION", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "VALUES", "BIND", "GRAPH", "DISTINCT"].map((text) => ({ text, kind: "关键字" }));

function cypherFilter(items: string[], partial: string, kind: string): CypherSuggestion[] {
  const p = partial.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(p)).map((item) => {
    const lower = item.toLowerCase();
    return { text: item, kind, score: (lower.startsWith(p) ? 0 : 1) + lower.indexOf(p) / 1000 };
  }).sort((a, b) => a.score - b.score).map(({ text, kind: k }) => ({ text, kind: k }));
}

function CypherEditor({ value, onChange, language = "cypher", labels, relationshipTypes, propertyKeys, placeholder }: { value: string; onChange: (next: string) => void; language?: "cypher" | "sparql"; labels: string[]; relationshipTypes: string[]; propertyKeys: string[]; placeholder?: string }) {
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
      list = language === "sparql" ? DEFAULT_SPARQL_SUGGESTIONS : DEFAULT_CYPHER_SUGGESTIONS;
    } else if (language === "sparql") {
      list = cypherFilter(SPARQL_KEYWORDS, word, "关键字").slice(0, 12);
    } else {
      list = [...cypherFilter(CYPHER_KEYWORDS, word, "关键字"), ...cypherFilter(CYPHER_FUNCTIONS, word, "函数")].slice(0, 12);
    }
    setWordStart(start);
    setSuggestions(list);
    setHighlight(0);
  }, [labels, relationshipTypes, propertyKeys, language]);

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

function GraphManager({ target, user, version, draft, runtimeTypes, mode, onModeChange, onSnapshotChange, notify, fail }: { target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; mode: "instances" | "ontology"; onModeChange: (mode: "instances" | "ontology") => void; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [graph, setGraph] = useState<GraphData>({ nodes: [], relationships: [] });
  const [ontologyGraph, setOntologyGraph] = useState<GraphData | null>(null);
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilters, setTypeFilters] = useState({ labels: [] as string[], relationshipTypes: [] as string[] });
  const [loading, setLoading] = useState(false);
  const { settings, update, reset } = useGraphSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ontologyTargetId = target?.id;
  const [queryDraft, setQueryDraft] = useState<{ kind: GraphTargetKind | undefined; text: string } | null>(null);
  const [cypherOpen, setCypherOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const queryTemplate = queryTemplateFor(target?.kind);
  // 用户改过的语句保留；切换图数据库后端时自动回落到该后端的默认语句。
  const cypher = queryDraft && queryDraft.kind === target?.kind ? queryDraft.text : queryTemplate.defaultQuery;
  const setCypher = (next: string) => setQueryDraft({ kind: target?.kind, text: next });
  const cypherIsWrite = isWriteStatement(target?.kind, cypher);
  const [cypherMeta, setCypherMeta] = useState<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>({ labels: [], relationshipTypes: [], propertyKeys: [] });

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>(`/api/instances/meta?targetId=${encodeURIComponent(target.id)}${versionParam}`).then(setCypherMeta).catch(() => {});
    // Schema metadata is re-fetched only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id]);

  const cypherLabels = useMemo(() => [...new Set([...cypherMeta.labels, ...(version?.definition.entityTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.labels, version]);
  const cypherRelationshipTypes = useMemo(() => [...new Set([...cypherMeta.relationshipTypes, ...(version?.definition.relationshipTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.relationshipTypes, version]);
  const cypherPropertyKeys = useMemo(() => [...new Set([...cypherMeta.propertyKeys, ...(version?.definition.entityTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? []), ...(version?.definition.relationshipTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.propertyKeys, version]);

  const load = useCallback(async (nextLabel: string, nextSearch: string, nodeLimit: number, filters = typeFilters) => {
    if (!target) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (version) params.set("versionId", version.id);
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      for (const type of filters.labels) params.append("graphLabel", type);
      for (const type of filters.relationshipTypes) params.append("relationshipType", type);
      params.set("nodeLimit", String(nodeLimit));
      setGraph(await api<GraphData>(`/api/instances/graph?${params.toString()}`));
    } catch (reason) { fail(reason); } finally { setLoading(false); }
  }, [target, version, fail, typeFilters]);

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
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<GraphData>(`/api/instances/graph?targetId=${encodeURIComponent(target.id)}${versionParam}&nodeLimit=${settings.nodeLimit}`).then(setGraph).catch(fail);
    // Graph is re-fetched when the selected target or the node limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, settings.nodeLimit]);

  useEffect(() => {
    if (mode !== "ontology" || !ontologyTargetId) return;
    void api<QueryResult>(`/api/targets/${ontologyTargetId}/schema`).then((result) => setOntologyGraph(result.graph)).catch(fail);
  }, [fail, mode, ontologyTargetId]);

  const expand = useCallback(async (nodeId: string) => {
    if (!target) return;
    const expanded = await api<GraphData>(`/api/instances/neighbors?targetId=${encodeURIComponent(target.id)}&nodeId=${encodeURIComponent(nodeId)}&limit=${Math.max(1, settings.maxNeighbors)}`);
    setGraph((current) => ({ nodes: [...new Map([...current.nodes, ...expanded.nodes].map((node) => [node.id, node])).values()], relationships: [...new Map([...current.relationships, ...expanded.relationships].map((relationship) => [relationship.id, relationship])).values()] }));
  }, [target, settings.maxNeighbors]);

  const runCypher = useCallback(async () => {
    if (!target) return;
    try {
      if (cypherIsWrite) throw new Error(`版本管理启用后禁止通过 ${graphTargetKindInfo(target.kind).queryLanguageLabel} 工作台直接写入 ${graphTargetKindInfo(target.kind).label}；请在草稿的实体、关系或图谱页面修改数据后发布。`);
      setRunning(true);
      const result = await api<QueryResult>("/api/query", { method: "POST", body: JSON.stringify({ targetId: target.id, query: cypher, confirmWrite: cypherIsWrite }) });
      setGraph(capResult(result, settings.recordLimit).graph);
    } catch (reason) { fail(reason); } finally { setRunning(false); }
  }, [target, cypher, cypherIsWrite, settings.recordLimit, fail]);

  return <section className="stack">
    <div className="graph-view-switcher" aria-label="图谱视图">
      <button className={mode === "instances" ? "active" : ""} aria-pressed={mode === "instances"} onClick={() => onModeChange("instances")}>实例图谱</button>
      <button className={mode === "ontology" ? "active" : ""} aria-pressed={mode === "ontology"} onClick={() => onModeChange("ontology")}>查看本体</button>
    </div>
    {mode === "instances" ? <>
      <div className="panel functional-panel graph-head-panel"><div className="title-row"><div><span className="eyebrow">{draft ? `草稿 v${draft.version_number}` : "已发布图谱"}</span><h2>{draft ? "编辑版本快照" : "浏览当前发布数据"}</h2></div><div className="functional-actions"><label className="graph-head-filter">标签筛选<select value={label} onChange={(event) => { const filters = { labels: [], relationshipTypes: [] }; setLabel(event.target.value); setTypeFilters(filters); void load(event.target.value, search, settings.nodeLimit, filters); }}><option value="">全部</option>{(runtimeTypes?.labels ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}（{item.count}）</option>)}</select></label><button className="action" disabled={loading} onClick={() => void load(label, search, settings.nodeLimit)}><Search size={15} />{loading ? "加载中…" : "刷新"}</button><button className="action" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />可视化配置</button></div></div><p className="subtle">{draft ? `节点、关系、属性与位置修改只保存到草稿快照文件，发布前不会影响 ${graphNoun(target)}。` : "当前为只读发布版本；创建草稿后才可编辑图数据。"}</p></div>
      {!draft && <section className="panel cypher-bar"><button type="button" className="cypher-bar-trigger" aria-expanded={cypherOpen} onClick={() => setCypherOpen((current) => !current)}><span><span className="eyebrow">{graphTargetKindInfo(target?.kind ?? "NEO4J").queryLanguageLabel} 只读查询</span><b>查询当前 {graphNoun(target)} 并可视化</b></span><span className="cypher-bar-toggle">{cypherOpen ? "收起查询" : "展开查询"}<ChevronDown size={15} className={cypherOpen ? "is-open" : ""} /></span></button>{cypherOpen && <div className="cypher-bar-content"><CypherEditor value={cypher} onChange={setCypher} language={target?.kind === "JENA" ? "sparql" : "cypher"} labels={cypherLabels} relationshipTypes={cypherRelationshipTypes} propertyKeys={cypherPropertyKeys} placeholder={queryTemplate.placeholder} /><p className="cypher-hint">{queryTemplate.visualizationHint}</p><div className="cypher-controls"><span className={cypherIsWrite ? "write-warning" : "read-state"}>{cypherIsWrite ? "版本模式禁止直接写入" : "只读语句"}</span><button className="action primary" disabled={running || !target || cypherIsWrite} onClick={() => void runCypher()}><PlayIcon />{running ? "执行中" : "运行并可视化"}</button></div></div>}</section>}
      <GraphCanvas graph={graph} targetId={target?.id} versionId={draft?.id} user={user} editable={Boolean(draft)} definition={version?.definition ?? null} runtimeTypes={runtimeTypes ?? undefined} onExpand={draft ? undefined : expand} onRefresh={async () => { await load(label, search, settings.nodeLimit); await onSnapshotChange(); }} onTypeFilterChange={(filters) => { setTypeFilters(filters); void load(label, search, settings.nodeLimit, filters); }} notify={notify} fail={fail} />
      {settingsOpen && <GraphSettingsDialog settings={settings} onSave={update} onReset={reset} onClose={() => setSettingsOpen(false)} />}
    </> : <>
      <div className="panel functional-panel graph-head-panel"><div className="title-row"><div><span className="eyebrow">本体骨架</span><h2>查看当前 {graphNoun(target)} 运行结构</h2><p className="subtle">骨架从已发布生效的数据推导：Neo4j 读取 <code>db.schema.visualization()</code>，Apache Jena 读取实例的 <code>rdf:type</code> 与对象属性。草稿类型和实例要到发布后才会出现在这里。</p></div><button className="action" disabled={loading} onClick={() => void loadOntology()}><Network size={15} />{loading ? "加载中…" : "刷新本体骨架"}</button></div></div>
      {ontologyGraph ? <GraphCanvas graph={ontologyGraph} targetId={target?.id} user={user} editable={false} definition={version?.definition ?? null} viewMode="ontology" notify={notify} fail={fail} /> : <div className="graph-empty"><Network size={27} /><b>正在读取本体骨架</b><span>将从目标图数据库加载实际存在的实体类型和关系类型。</span></div>}
    </>}
  </section>;
}

function EntityManager({ target, user, version, draft, runtimeTypes, ensureDraft, onSnapshotChange, notify, fail, entityLimit }: { target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; ensureDraft: () => Promise<Version>; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void; entityLimit: number }) {
  const [rows, setRows] = useState<EntityRow[]>([]);
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (nextLabel: string, nextSearch: string, versionId = version?.id) => {
    if (!target) return;
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (versionId) params.set("versionId", versionId);
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      params.set("limit", String(entityLimit));
      setRows(await api<{ rows: EntityRow[] }>(`/api/instances/entities?${params.toString()}`).then((data) => data.rows));
    } catch (reason) { fail(reason); }
  }, [target, version?.id, fail, entityLimit]);

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<{ rows: EntityRow[] }>(`/api/instances/entities?targetId=${encodeURIComponent(target.id)}${versionParam}&limit=${entityLimit}`).then((data) => setRows(data.rows)).catch(fail);
    // Entity list is re-fetched when the selected target, version or display limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, entityLimit]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const definitions = selected ? (version?.definition.entityTypes.find((item) => selected.labels.includes(item.name))?.properties ?? null) : null;
  const managed = Boolean(definitions);

  const save = async () => {
    if (!target || !selected) return;
    try { setBusy(true); const current = await ensureDraft(); const updated = await api<EntityRow>(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) }); setRows((rows) => rows.map((row) => row.id === updated.id ? updated : row)); await onSnapshotChange(); notify(`实体属性已保存到草稿快照，发布前不会影响 ${graphNoun(target)}。`); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || !selected) return;
    if (!window.confirm("删除该节点及其所有关系？")) return;
    try { setBusy(true); const current = await ensureDraft(); await api(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "DELETE" }); setSelectedId(null); setRows((rows) => rows.filter((row) => row.id !== selected.id)); await onSnapshotChange(); notify("实体及其关联关系已从草稿快照删除。"); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <ResizableManagerGrid storageKey="ontology.manager-split.entities">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">实体</span>
      <h2>{rows.length} 条</h2>
      <p className="subtle">默认按实体类型设置的显示名称搜索；未配置显示属性时按其他属性匹配。</p>
      <div className="manager-toolbar">
        <select value={label} onChange={(event) => { setLabel(event.target.value); void load(event.target.value, search); }}><option value="">全部标签</option>{[...new Set([...(version?.definition.entityTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.labels.map((item) => item.name) ?? [])])].map((name) => <option key={name} value={name}>{name}</option>)}</select>
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(label, search); }} placeholder="按显示名称搜索…" />
        <button className="action compact" onClick={() => void load(label, search)}><Search size={14} /></button>
        <button className="action compact" onClick={() => setCreateOpen(true)}><Plus size={14} />新建</button>
      </div>
      <div className="manager-rows">{rows.map((row) => <button key={row.id} className={selectedId === row.id ? "manager-row selected" : "manager-row"} onClick={() => { setSelectedId(row.id); setDraftProps(Object.fromEntries(Object.entries(row.properties).filter(([key]) => key !== "fx" && key !== "fy"))); }}><CircleDot size={15} /><span><b>{entityTitle(row, version?.definition ?? null)}</b><small>{row.labels.join(", ")} · {propertySummary(row.properties)}</small></span></button>)}{!rows.length && <p className="empty">没有匹配的实体。</p>}</div>
    </div>
    <div className="panel functional-panel detail-panel">
      {selected ? <><span className="eyebrow">选中实体</span><h2>{entityTitle(selected, version?.definition ?? null)}</h2><div className="detail-meta"><span>{selected.labels.join(", ") || "无标签"}</span><code>{selected.id}</code></div>{user.role === "ADMIN" ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存到草稿</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />从草稿删除</button></div><p className="subtle">{draft ? "修改当前草稿快照。" : "首次修改会基于当前发布版本自动创建草稿。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}</> : <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一条实体</b><span>点击左侧列表中的实体查看与编辑属性。</span></div>}
    </div>
    {user.role === "ADMIN" && createOpen && <EntityCreateDialog published={version} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (label, properties) => { try { if (!target) throw new Error("请先选择目标。"); const current = await ensureDraft(); await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId: target.id, versionId: current.id, entityType: label, properties }) }); notify("实体已加入草稿快照。"); setCreateOpen(false); await load(label, search, current.id); await onSnapshotChange(); } catch (reason) { fail(reason); } }} />}
  </ResizableManagerGrid>;
}

function RelationshipManager({ target, user, version, draft, runtimeTypes, ensureDraft, onSnapshotChange, notify, fail, relationshipLimit }: { target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; ensureDraft: () => Promise<Version>; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void; relationshipLimit: number }) {
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
      {selected ? <><span className="eyebrow">选中关系</span><h2>{selected.type}</h2><div className="detail-meta"><span>{selectedEnds?.source || selected.sourceId} <span className="arrow">→</span> {selectedEnds?.target || selected.targetId}</span><code>{selected.id}</code></div><div className="endpoint-cards"><EndpointCard side="头实体" elementId={selected.sourceId} displayName={selectedEnds?.source || selected.sourceId} labels={selected.sourceLabels} detail={endpointDetails[selected.sourceId]} loading={Boolean(endpointLoading[selected.sourceId])} open={openEnd === "source"} onToggle={() => toggleEnd("source", selected.sourceId)} /><EndpointCard side="尾实体" elementId={selected.targetId} displayName={selectedEnds?.target || selected.targetId} labels={selected.targetLabels} detail={endpointDetails[selected.targetId]} loading={Boolean(endpointLoading[selected.targetId])} open={openEnd === "target"} onToggle={() => toggleEnd("target", selected.targetId)} /></div>{user.role === "ADMIN" ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存到草稿</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />从草稿删除</button></div><p className="subtle">{draft ? "修改当前草稿快照。" : "首次修改会基于当前发布版本自动创建草稿。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}</> : <div className="graph-inspector-empty"><Link2 size={20} /><b>选择一条关系</b><span>点击左侧列表中的关系查看与编辑属性。</span></div>}
    </div>
    {user.role === "ADMIN" && createOpen && <RelationshipCreateDialog targetId={target?.id ?? ""} versionId={version?.id ?? ""} published={version} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (type, sourceId, targetId, properties) => { try { if (!target) throw new Error("请先选择目标。"); const current = await ensureDraft(); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId: target.id, versionId: current.id, relationshipType: type, sourceId, targetIdValue: targetId, properties }) }); notify("关系已加入草稿快照。"); setCreateOpen(false); await load(type, search, current.id); await onSnapshotChange(); } catch (reason) { fail(reason); } }} />}
  </ResizableManagerGrid>;
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

function EndpointCard({ side, elementId, displayName, labels, detail, loading, open, onToggle }: { side: string; elementId: string; displayName: string; labels: string[] | undefined; detail: { labels: string[]; properties: Record<string, unknown> } | undefined; loading: boolean; open: boolean; onToggle: () => void }) {
  return <div className="endpoint-card">
    <div className="endpoint-card-head">
      <div className="endpoint-card-title"><span className="endpoint-side">{side}</span><div><b>{displayName}</b><small>{labels?.join(", ") || "无标签"} · <code>{elementId}</code></small></div></div>
      <button className="action compact" onClick={onToggle} disabled={loading}>{loading ? <Loader2 size={13} className="endpoint-spinner" /> : open ? "收起" : "查看属性"}</button>
    </div>
    {open && detail && <div className="endpoint-props">{Object.entries(detail.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div>}
    {open && !detail && !loading && <p className="empty">暂无数据。</p>}
  </div>;
}

function EntitySearchPicker({ targetId, versionId, labels, definition, placeholder, value, onChange }: { targetId: string; versionId: string; labels: string[]; definition: Definition | null; placeholder: string; value: EntitySearchResult | null; onChange: (node: EntitySearchResult | null) => void }) {
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
      const params = new URLSearchParams({ targetId, versionId, q: trimmed, limit: "12" });
      if (labelKey) params.set("labels", JSON.stringify(labelKey.split("|")));
      const data = await api<{ results: EntitySearchResult[] }>(`/api/instances/search?${params.toString()}`);
      setResults(data.results); setSearched(true); setHighlight(0);
    } catch (reason) {
      setResults([]); setSearched(true); setError(reason instanceof Error ? reason.message : "搜索失败。");
    } finally { setLoading(false); }
  }, [targetId, versionId, labelKey]);
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

function RelationshipCreateDialog({ targetId, versionId, published, runtimeTypes, onClose, onCreate }: { targetId: string; versionId: string; published: Version | null; runtimeTypes: RuntimeTypeSet | null; onClose: () => void; onCreate: (type: string, sourceId: string, targetId: string, properties: Record<string, unknown>) => Promise<void> }) {
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
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog dialog-wide" onSubmit={(event) => { event.preventDefault(); if (!type.trim() || !source || !target) return; setBusy(true); void onCreate(type.trim(), source.id, target.id, properties).finally(() => setBusy(false)); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Link2 size={22} /></div><span className="eyebrow">新建关系</span><h2>选择关系类型</h2><label>关系类型<select value={type} onChange={(event) => { setType(event.target.value); setSource(null); setTarget(null); }} required><option value="">选择类型</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><div className="dialog-field"><span>起始实体</span><EntitySearchPicker targetId={targetId} versionId={versionId} labels={sourceLabels} definition={published?.definition ?? null} placeholder="按名称搜索起始实体…" value={source} onChange={setSource} /></div><div className="dialog-field"><span>终止实体</span><EntitySearchPicker targetId={targetId} versionId={versionId} labels={targetLabels} definition={published?.definition ?? null} placeholder="按名称搜索终止实体…" value={target} onChange={setTarget} /></div>{selfLoop && <p className="dialog-hint">起始与终止为同一实体（自环关系）。</p>}<PropertyEditor definitions={definitions ?? []} values={properties} mode="managed" onChange={setProperties} /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!type.trim() || !source || !target || busy}>{busy ? "创建中…" : "创建关系"}</button></div></form></div>;
}

function PlayIcon() { return <span className="arrow">▶</span>; }
