"use client";

import { EntityManager } from "@/components/workbench/entity-manager";
import { GraphManager } from "@/components/workbench/graph-manager";
import { Login } from "@/components/workbench/login-screen";
import { OntologyManager } from "@/components/workbench/ontology-manager";
import { Overview } from "@/components/workbench/overview";
import { RelationshipManager } from "@/components/workbench/relationship-manager";
import { SettingsManager } from "@/components/workbench/settings-manager";
import { type User, may, type Target, type Version, type View, targetFromStorage, graphNoun, Toast, useDisplaySettings } from "@/components/workbench/shared";
import { TargetManager, NewTargetDialog } from "@/components/workbench/target-manager";
import { VersionBar } from "@/components/workbench/version-bar";
import { useEffect, useRef, useState } from "react";
import { Activity, BookOpen, CircleDot, GitBranch, Link2, LogOut, Network, Settings2, ShieldAlert, ShieldCheck, MessagesSquare, Sparkles, Table2, Terminal, UserRound, type LucideIcon } from "lucide-react";
import { ActionStudio } from "@/components/action-studio";
import { AuditLog } from "@/components/audit-log";
import { type EntitySearchResult } from "@/components/entity-search-picker";
import { UserRoleManager } from "@/components/user-role-manager";
import { OntologyStudio, type OntologySummary } from "@/components/ontology-studio";
import { QaStudio } from "@/components/qa-studio";
import { SkillStudio } from "@/components/skill-studio";
import { McpStudio } from "@/components/mcp-studio";
import { DataResourceStudio } from "@/components/data-resource-studio";
import { api } from "@/lib/api-client";
import { type Permission } from "@/lib/permissions";
import { clearSessionToken } from "@/lib/session-token";
import { type RuntimeTypeSet } from "@/lib/graph/types";
import { propertyTypeOptions, type Definition } from "@/lib/ontology-draft";





export const emptyDefinition: Definition = { groups: [], interfaces: [], metrics: [], entityTypes: [], relationshipTypes: [], actionTypes: [], rules: [] };

export const typeOptions = propertyTypeOptions;

/** 对象类型清单上的来源角标：主来源的表名，挂了补充来源再报个数。 */

export type NavItem = readonly [View, string, LucideIcon, Permission | null];

/**
 * 左侧导航。第 4 项是**进入这个视图需要的权限点**，`null` = 所有登录用户都能进
 * （「设置」里各个标签再各自判）。渲染前按它过滤 —— 角色没有权限的功能不该出现在导航里。
 * 2026-10-10 用户口径：「角色缺少对前端界面某些功能可见性的控制」。
 *
 * 隐藏只是体验，真正的边界仍在服务端的 `requirePermission`。
 */

export const NAV_SECTIONS: { label: string; items: readonly NavItem[] }[] = [
  { label: "", items: [["overview", "总览", Activity, "ontology.read"]] },
  { label: "本体模型", items: [["ontology", "本体建模", BookOpen, "ontology.read"], ["skills", "本体技能", Sparkles, "ontology.read"]] },
  { label: "本体实例", items: [["graph", "实例图谱", Network, "instance.read"], ["entities", "对象", CircleDot, "instance.read"], ["relations", "关系", Link2, "instance.read"]] },
  { label: "动力模型", items: [["actions", "动作", ShieldAlert, "ontology.read"], ["rules", "规则", ShieldCheck, "ontology.read"]] },
  { label: "能力验证", items: [["qa", "智能问答", MessagesSquare, "reasoning.use"], ["mcp", "MCP 调试", Terminal, "reasoning.use"]] },
  { label: "平台", items: [["data", "数据资源", Table2, "datasource.read"], ["settings", "设置", Settings2, null]] },
];


export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** 这个人能不能进这个视图（导航里没列出、判不出来的按「能进」处理）。 */

export function mayEnterView(user: User, view: View): boolean {
  const item = NAV_ITEMS.find(([id]) => id === view);
  return !item || item[3] === null || may(user, item[3]);
}

/** 被权限挡住时的落脚点：这个人第一个能进的视图。 */

export function firstEnterableView(user: User): View {
  return NAV_ITEMS.find(([, , , code]) => code === null || may(user, code))?.[0] ?? "settings";
}


export function navLabel(view: View) {
  return NAV_ITEMS.find(([id]) => id === view)?.[1] ?? view;
}



export function FunctionalWorkbench() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [targets, setTargets] = useState<Target[]>([]);
  const [ontologies, setOntologies] = useState<OntologySummary[]>([]);
  const [targetId, setTargetId] = useState("");
  const [ontologyId, setOntologyId] = useState("");
  const [draft, setDraft] = useState<Version | null>(null);
  const [published, setPublished] = useState<Version | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [runtimeTypes, setRuntimeTypes] = useState<RuntimeTypeSet | null>(null);
  // draft / published 属于哪个本体存储：切换时旧版本在新目标上不成立，先别往下传。
  const [versionTargetId, setVersionTargetId] = useState("");
  const [view, setView] = useState<View>("overview");
  const [settingsTab, setSettingsTab] = useState<"general" | "storage" | "audit" | "users">("general");
  const [newTargetOpen, setNewTargetOpen] = useState(false);
  // 推理页点证据跳到对象页时带上的目标对象：到了就清空，避免下次进来又跳一次。
  const [focusEntityId, setFocusEntityId] = useState<string | null>(null);
  // 从对象详情跳到「动作」页时带上的预填：动作 + 主对象。
  const [pendingRun, setPendingRun] = useState<{ actionId: string; subject: EntitySearchResult } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings: displaySettings, update: updateDisplaySettings, reset: resetDisplaySettings } = useDisplaySettings();

  const selectedOntology = ontologies.find((item) => item.id === ontologyId) ?? null;
  /*
   * 图引擎连接清单要 `target.read`，没有这个权限的角色拿不到 `targets`；本体列表里的 `storage`
   * 是同一份落点信息里该给所有人看的那部分，用它兜底，别让「看得到本体却打不开本体建模」。
   */
  const selectedTarget = targets.find((target) => target.id === targetId) ?? targetFromStorage(selectedOntology?.storage ?? null);
  // 「图引擎配置」要 target.read：没这个权限就别把设置页切到那个标签（导航里那条也不显示）。
  const openStorageSettings = () => { setSettingsTab(user && may(user, "target.read") ? "storage" : "general"); setView("settings"); };
  /** 选一个本体：它的落点决定后面所有图操作打在哪个存储上。 */
  const openOntology = (ontology: OntologySummary) => {
    // 落点没变就不要清 versionTargetId：清了但 targetId 没变，加载效应不会再跑，
    // 界面会永远停在"没有版本"的状态（选同一个本体时最容易踩）。
    const nextTargetId = ontology.storage?.id ?? "";
    setOntologyId(ontology.id);
    if (nextTargetId !== targetId) { setTargetId(nextTargetId); setVersionTargetId(""); }
    setView("ontology");
  };
  const selectTarget = (id: string) => { setTargetId(id); setOntologyId(ontologies.find((item) => item.storage?.id === id || item.target_id === id)?.id ?? ""); };
  // 版本列表按本体存储逐个加载；还没加载完就不能拿上一个存储的版本去查它的对象。
  const versionsReady = versionTargetId === targetId;
  const workspaceVersion = versionsReady ? draft ?? published : null;
  const definition = versionsReady ? draft?.definition ?? published?.definition ?? emptyDefinition : emptyDefinition;

  const notify = (text: string) => { setMessage(text); setError(null); if (messageTimer.current) clearTimeout(messageTimer.current); messageTimer.current = setTimeout(() => setMessage(null), 5000); };
  const fail = (reason: unknown) => { setError(typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "操作失败。"); setMessage(null); if (messageTimer.current) clearTimeout(messageTimer.current); };
  const dismiss = () => { setMessage(null); setError(null); if (messageTimer.current) clearTimeout(messageTimer.current); };

  const loadOntologies = async () => {
    const data = await api<OntologySummary[]>("/api/ontologies");
    setOntologies(data);
    // 本体列表变了（新建 / 删除）时，「当前本体」与落点一起收敛，别停在已被删掉的存储上。
    const nextId = ontologyId && data.some((item) => item.id === ontologyId) ? ontologyId : (data[0]?.id ?? "");
    setOntologyId(nextId);
    const storageId = data.find((item) => item.id === nextId)?.storage?.id ?? "";
    if (storageId && storageId !== targetId) { setTargetId(storageId); setVersionTargetId(""); }
  };
  const loadTargets = async (actor: User | null = null) => {
    const viewer = actor ?? user ?? null;
    /*
     * 两个请求**分开判**：本体列表只需要 `ontology.read`，图引擎连接清单要 `target.read`。
     * 以前这里平铺成一个 Promise.all，角色没有 target.read 时 /api/targets 回 403，
     * 整个 Promise.all 直接 reject —— 本体列表跟着一起空掉，账号看着像「平台里没有本体」。
     * （2026-10-10 用户报的：新建账号看不到本体。）没这个权限就不发这个请求。
     */
    const canReadTargets = Boolean(viewer) && may(viewer as User, "target.read");
    const [ontologyList, data] = await Promise.all([
      api<OntologySummary[]>("/api/ontologies"),
      canReadTargets ? api<Target[]>("/api/targets") : Promise.resolve([] as Target[]),
    ]);
    setTargets(data);
    setOntologies(ontologyList);
    // 「当前本体」是主选择，落点跟着它走。两边各自取第一个是不行的：
    // 本体列表与存储列表的顺序无关，会让侧边栏显示 A、实际却在操作 B。
    setOntologyId((current) => (current && ontologyList.some((item) => item.id === current) ? current : (ontologyList[0]?.id ?? "")));
    setTargetId((current) => {
      if (current && data.some((item) => item.id === current)) return current;
      return ontologyList[0]?.storage?.id ?? data[0]?.id ?? "";
    });
  };

  const loadVersions = async (id: string) => {
    if (!id) return;
    if (id !== versionTargetId) {
      // 换本体：先清掉上一个本体的版本与统计。否则切换的一瞬间，页头与版本条
      // 显示的仍是别人的草稿（「当前本体」显示 A、草稿却是 B 的）。
      setVersions([]);
      setDraft(null);
      setPublished(null);
      setRuntimeTypes(null);
    }
    const versions = await api<Version[]>(`/api/ontology?targetId=${encodeURIComponent(id)}`);
    const nextDraft = versions.find((item) => item.status === "DRAFT") ?? null;
    const nextPublished = versions.find((item) => item.status === "PUBLISHED") ?? null;
    setVersions(versions);
    setDraft(nextDraft);
    setPublished(nextPublished);
    setVersionTargetId(id);
    const workspace = nextDraft ?? nextPublished;
    const versionParam = workspace ? `&versionId=${workspace.id}` : "";
    // 运行时类型要 `instance.read`：没有这个权限的角色别去问，否则顶栏会顶一条 403 提示。
    const types = user && may(user, "instance.read")
      ? await api<RuntimeTypeSet>(`/api/instances/types?targetId=${encodeURIComponent(id)}${versionParam}`)
      : null;
    setRuntimeTypes(types);
  };

  useEffect(() => {
    /*
     * 开机只问一次"我这个令牌还认不认"。`/api/auth/session` 认得就回 `user`，不认回 `user: null`
     * —— **这是"令牌作废"的唯一信号**：`api()` 里刻意不在 401 时清令牌（查看者碰管理员接口也是 401）。
     * 所以这里一旦拿到 null，就把本地那份清掉，免得它一直躺在 localStorage 里。
     */
    api<{ user: User | null }>("/api/auth/session").then(async (data) => {
      setUser(data.user);
      if (data.user) { await loadTargets(data.user); return; }
      clearSessionToken();
    }).catch(() => setUser(null));
  }, []);

  /*
   * 权限变了（改角色 / 换账号）或当前视图没权限：落到第一个能进的视图。
   * 不留「停在空白页」或「点了导航没反应」的状态。
   */
  useEffect(() => {
    if (user && !mayEnterView(user, view)) setView(firstEnterableView(user));
  }, [user, view]);

  useEffect(() => {
    if (!targetId) return;
    const handle = window.setTimeout(() => { void loadVersions(targetId).catch(fail); }, 0);
    return () => window.clearTimeout(handle);
  }, [targetId]);

  const refreshRuntimeTypes = () => { if (!targetId || !workspaceVersion) return; void api<RuntimeTypeSet>(`/api/instances/types?targetId=${encodeURIComponent(targetId)}&versionId=${workspaceVersion.id}`).then(setRuntimeTypes).catch(() => setRuntimeTypes(null)); };

  const ensureDraft = async () => {
    if (!targetId) throw new Error("请先登记并选择一个本体存储。");
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
    try { const current = await ensureDraft(); const result = await api<{ valid: boolean; violations: { message: string; count: number }[]; warnings?: { message: string }[] }>(`/api/ontology/${current.id}/validate`, { method: "POST" }); const nudges = result.warnings?.length ? `另有 ${result.warnings.length} 条提醒：${result.warnings.map((item) => item.message).join("；")}` : ""; result.valid ? notify(nudges ? `草稿校验通过，可以发布。${nudges}` : "草稿校验通过，可以发布。") : fail([...result.violations.map((item) => `${item.message} (${item.count})`), nudges].filter(Boolean).join("；")); } catch (reason) { fail(reason); }
  };

  const publish = async () => {
    try { const current = await ensureDraft(); const result = await api<{ published: boolean; strongRulesEnforced?: boolean; atomicReplace?: boolean; entityCount?: number; relationshipCount?: number; violations?: { message: string; count: number }[]; warnings?: { message: string }[] }>(`/api/ontology/${current.id}/publish`, { method: "POST" }); if (result.published) { const caveat = result.atomicReplace === false ? `（${graphNoun(selectedTarget)} 不支持事务替换，失败时可能留下半成品）` : ""; const nudges = result.warnings?.length ? ` ${result.warnings.length} 条提醒：${result.warnings.map((item) => item.message).join("；")}` : ""; notify(`版本 v${current.version_number} 已发布：${result.entityCount ?? 0} 个对象、${result.relationshipCount ?? 0} 条关系已在 ${graphNoun(selectedTarget)} 生效。${caveat}${nudges}`); await loadVersions(targetId); } else if (result.violations?.length) { fail(result.violations.map((item) => `${item.message} (${item.count})`).join("；")); } } catch (reason) { fail(reason); }
  };

  const activateVersion = async (version: Version) => {
    if (draft) throw new Error("当前存在草稿，请先发布草稿后再切换历史版本。");
    const result = await api<{ published: boolean; entityCount: number; relationshipCount: number }>(`/api/ontology/${version.id}/activate`, { method: "POST" });
    notify(`已切换到 v${version.version_number}：${result.entityCount} 个对象、${result.relationshipCount} 条关系已重新导入 ${graphNoun(selectedTarget)}。`);
    await loadVersions(targetId);
  };

  const resetVersions = async () => {
    await loadVersions(targetId);
  };

  if (user === undefined) return <div className="loading-screen">正在加载 Ontology...</div>;
  if (!user) return <Login onSuccess={async (next) => { setUser(next); await loadTargets(next); }} />;

  const userProp = user;

  return <main className="functional-shell">
    <aside className="functional-sidebar"><div className="functional-brand"><GitBranch size={23} /><span><b>ONTOLOGY</b><small>GRAPH GOVERNANCE</small></span></div><label className="target-picker"><span>当前本体</span><select value={ontologyId} title={selectedOntology?.name ?? "选择本体"} onChange={(event) => { const next = ontologies.find((item) => item.id === event.target.value); const nextTargetId = next?.storage?.id ?? ""; setOntologyId(event.target.value); if (nextTargetId !== targetId) { setTargetId(nextTargetId); setVersionTargetId(""); } }}><option value="">选择本体</option>{ontologies.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><nav>{NAV_SECTIONS.map((section, sectionIndex) => { const items = section.items.filter(([, , , code]) => code === null || may(user, code)); if (!items.length) return null; return <div className="nav-section" key={section.label || `root-${sectionIndex}`}>{section.label && <p className="nav-section-label">{section.label}</p>}{items.map(([id, label, Icon]) => <button key={id} className={view === id ? "functional-nav selected" : "functional-nav"} onClick={() => { setPendingRun(null); if (id === "settings") setSettingsTab("general"); setView(id); }}><Icon size={17} />{label}</button>)}</div>; })}</nav><div className="functional-user"><UserRound size={17} /><span><b>{user.email}</b><small>{user.roleName}</small></span><button title="退出登录" onClick={() => { clearSessionToken(); setUser(null); }}><LogOut size={16} /></button></div></aside>
    <section className="functional-content"><header><div><p>本体治理 / {navLabel(view)}</p><h1>{view === "data" ? "数据资源" : view === "settings" ? "设置" : view === "qa" ? "智能问答" : view === "mcp" ? "MCP 调试" : view === "skills" ? "本体技能" : selectedOntology?.name ?? "总览"}</h1></div>{selectedTarget ? <VersionBar versions={versions} draft={draft} published={published} user={userProp} onCreate={() => ensureDraft()} onActivate={activateVersion} fail={fail} /> : <div className="header-state">请选择或新建本体</div>}</header><Toast message={error ?? message} error={Boolean(error)} onDismiss={dismiss} />
      {view === "overview" && <section className="stack">{selectedTarget && <Overview target={selectedTarget} draft={draft} published={published} runtimeTypes={runtimeTypes} canViewGraph={may(userProp, "instance.read")} onNavigate={setView} onOpenStorage={openStorageSettings} />}<OntologyStudio ontologies={ontologies} targets={targets} selectedId={ontologyId} canEdit={may(userProp, "ontology.write")} refresh={loadOntologies} onOpen={openOntology} notify={notify} fail={fail} /></section>}
      {view === "data" && <DataResourceStudio canEdit={may(userProp, "datasource.write")} notify={notify} fail={fail} />}
      {newTargetOpen && <NewTargetDialog onClose={() => setNewTargetOpen(false)} onCreated={async (target) => { await loadTargets(user); selectTarget(target.id); openStorageSettings(); setNewTargetOpen(false); }} notify={notify} fail={fail} />}
      {view === "ontology" && <OntologyManager definition={definition} draft={draft} targetId={selectedTarget?.id} user={userProp} runtimeTypes={runtimeTypes} refreshRuntimeTypes={refreshRuntimeTypes} save={saveDefinition} validate={validate} publish={publish} notify={notify} onOpenActions={() => setView("actions")} fail={fail} />}
      {view === "actions" && <ActionStudio definition={definition} versionId={draft?.id} targetId={selectedTarget?.id} canEdit={may(userProp, "ontology.write")} canRun={may(userProp, "instance.write")} initialRun={pendingRun} onSave={saveDefinition} onRan={async () => { await loadVersions(targetId); }} notify={notify} fail={fail} />}
      {view === "rules" && <ActionStudio definition={definition} versionId={draft?.id} targetId={selectedTarget?.id} canEdit={may(userProp, "ontology.write")} canRun={may(userProp, "instance.write")} initialStage="rules" onSave={saveDefinition} onRan={async () => { await loadVersions(targetId); }} notify={notify} fail={fail} />}
      {view === "graph" && <GraphManager target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} onSnapshotChange={() => loadVersions(targetId)} notify={notify} fail={fail} />}
      {view === "relations" && <RelationshipManager target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} ensureDraft={ensureDraft} onSnapshotChange={() => loadVersions(targetId)} notify={notify} fail={fail} relationshipLimit={displaySettings.relationshipLimit} />}
      {view === "qa" && <QaStudio
        targetId={targetId}
        ontologyName={selectedOntology?.name ?? "未选择本体"}
        published={versionsReady && published !== null}
        onOpenObject={(objectId) => { if (!may(userProp, "instance.read")) { notify("当前角色没有「查看对象与关系」权限，打不开对象详情。"); return; } setFocusEntityId(objectId); setView("entities"); }}
        notify={notify}
        fail={fail}
      />}
      {view === "mcp" && <McpStudio ontologies={ontologies} ontologyId={selectedOntology?.id ?? ""} notify={notify} fail={fail} />}
      {view === "skills" && <SkillStudio notify={notify} fail={fail} />}
      {view === "entities" && <EntityManager ontologyId={ontologyId} target={selectedTarget} user={userProp} version={workspaceVersion} draft={draft} runtimeTypes={runtimeTypes} ensureDraft={ensureDraft} onSnapshotChange={() => loadVersions(targetId)} notify={notify} onRunAction={(actionId, subject) => { setPendingRun({ actionId, subject: { id: subject.id, labels: subject.labels, properties: subject.properties, matched: [], rank: 0, objectRef: subject.objectRef } }); setView("actions"); }} fail={fail} entityLimit={displaySettings.entityLimit} focusEntityId={focusEntityId} onFocusHandled={() => setFocusEntityId(null)} />}
      {view === "settings" && <section className="stack"><div className="view-switcher" aria-label="设置类别"><button type="button" className={settingsTab === "general" ? "active" : ""} aria-pressed={settingsTab === "general"} onClick={() => setSettingsTab("general")}>常规设置</button>{may(user, "target.read") && <button type="button" className={settingsTab === "storage" ? "active" : ""} aria-pressed={settingsTab === "storage"} onClick={() => setSettingsTab("storage")}>图引擎配置</button>}{may(user, "audit.read") && <button type="button" className={settingsTab === "audit" ? "active" : ""} aria-pressed={settingsTab === "audit"} onClick={() => setSettingsTab("audit")}>审计记录</button>}{may(user, "users.manage") && <button type="button" className={settingsTab === "users" ? "active" : ""} aria-pressed={settingsTab === "users"} onClick={() => setSettingsTab("users")}>用户与角色</button>}</div>{settingsTab === "general" ? <SettingsManager target={selectedTarget} user={userProp} versions={versions} displaySettings={displaySettings} onSaveDisplaySettings={updateDisplaySettings} onResetDisplaySettings={resetDisplaySettings} onReset={resetVersions} notify={notify} fail={fail} /> : settingsTab === "storage" ? <TargetManager targets={targets.filter((target) => !ontologies.some((item) => item.storage?.managed && item.storage.id === target.id))} refresh={loadTargets} selectedId={targetId} onSelect={(id) => { selectTarget(id); setView("overview"); }} onNew={() => setNewTargetOpen(true)} canWrite={may(user, "target.write")} notify={notify} fail={fail} /> : settingsTab === "audit" ? <AuditLog fail={fail} /> : <UserRoleManager me={{ id: user.id, email: user.email }} notify={notify} fail={fail} />}</section>}
    </section>
  </main>;
}
