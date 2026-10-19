"use client";

import { type User, may, type Version, sourceSummary, relationshipEndpoints } from "@/components/workbench/shared";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CircleDot, Database, FileCheck2, KeyRound, Link2, Merge, Pencil, Plus, RefreshCcw, Search, ShieldCheck, Stethoscope, Table2, Trash2, X } from "lucide-react";
import { ConceptGroupManager } from "@/components/concept-group-manager";
import { InterfaceManager } from "@/components/interface-manager";
import { MetricManager } from "@/components/metric-manager";
import { keyMappingLabel, keyMappingRows, type KeyMapping } from "@/lib/ontology/relationship-keys";
import { planLinkSource } from "@/lib/ontology/link-source";
import { newId } from "@/lib/shared/common/ids";
import { OntologyBuilder, type EntityPayload, type RelationPayload } from "@/components/ontology-builder";
import { ModelingReviewPanel } from "@/components/modeling-review-panel";
import { reviewOntologyModel, summarizeModelingReview } from "@/lib/ontology/modeling-review";
import { resolveGroup } from "@/lib/ontology/concept-groups";
import { TypeEditDialog } from "@/components/type-edit-dialog";
import { type RuntimeTypeSet } from "@/lib/infrastructure/graph/types";
import { type Definition, type EntityType, type Property, type RelationType } from "@/lib/ontology/draft";
import { EMPTY_LINK_SOURCE } from "@/lib/ontology";
import { ActionStudio } from "@/components/action-studio";
import type { EntitySearchResult } from "@/components/entity-search-picker";

type ModelingMode = "visual" | "groups" | "entities" | "relations" | "interfaces" | "metrics" | "actions" | "rules";

type ModelingSearchHit = {
  id: string;
  mode: Exclude<ModelingMode, "visual">;
  kind: string;
  name: string;
  description: string;
  meta: string;
};

function modelingSearchHits(definition: Definition, raw: string): ModelingSearchHit[] {
  const keyword = raw.trim().toLowerCase();
  if (!keyword) return [];
  const contains = (...values: unknown[]) => values.some((value) => String(value ?? "").toLowerCase().includes(keyword));
  const entityName = (id: string) => definition.entityTypes.find((item) => item.id === id)?.name ?? "";
  const hits: ModelingSearchHit[] = [];

  for (const group of definition.groups) {
    const members = definition.entityTypes.filter((item) => item.groupId === group.id).map((item) => item.name);
    if (contains(group.name, members.join(" "))) hits.push({ id: group.id, mode: "groups", kind: "概念分组", name: group.name, description: members.join("、"), meta: `${members.length} 个对象类型` });
  }
  for (const entity of definition.entityTypes) {
    const properties = entity.properties.map((item) => `${item.name} ${item.displayName ?? ""} ${item.sourceField ?? ""}`).join(" ");
    const sources = (entity.sources ?? []).map((item) => [item.schema, item.view, item.sql].filter(Boolean).join(".")).join(" ");
    if (contains(entity.name, entity.description, properties, sources)) hits.push({ id: entity.id, mode: "entities", kind: "对象类型", name: entity.name, description: entity.description ?? "", meta: `${entity.properties.length} 属性` });
  }
  for (const relation of definition.relationshipTypes) {
    const endpoints = `${entityName(relation.sourceEntityTypeId)} ${entityName(relation.targetEntityTypeId)}`;
    if (contains(relation.name, relation.description, endpoints, relation.properties.map((item) => item.name).join(" "))) hits.push({ id: relation.id, mode: "relations", kind: "关系类型", name: relation.name, description: relation.description ?? "", meta: endpoints.trim() });
  }
  for (const item of definition.interfaces) {
    if (contains(item.name, item.description, item.properties.map((property) => property.name).join(" "))) hits.push({ id: item.id, mode: "interfaces", kind: "接口", name: item.name, description: item.description ?? "", meta: `${item.properties.length} 属性` });
  }
  for (const metric of definition.metrics) {
        const calculation = metric.calculation ?? null;
        if (contains(metric.name, metric.description, calculation?.property ?? "", metric.tags.join(" "))) hits.push({ id: metric.id, mode: "metrics", kind: "指标", name: metric.name, description: metric.description ?? "", meta: calculation ? `${calculation.aggregation}${calculation.property ? `(${calculation.property})` : ""}` : "只描述、不算数" });
  }
  for (const action of definition.actionTypes) {
    if (contains(action.name, action.code, action.description)) hits.push({ id: action.id, mode: "actions", kind: "动作", name: action.name || action.code || "（未命名动作）", description: action.description ?? "", meta: action.code || "no-code" });
  }
  for (const rule of definition.rules) {
    if (contains(rule.name, rule.message, rule.effect)) hits.push({ id: rule.id, mode: "rules", kind: "规则", name: rule.name || "（未命名规则）", description: rule.message ?? "", meta: rule.effect });
  }

  const order = ["对象类型", "关系类型", "接口", "指标", "动作", "规则", "概念分组"];
  return hits.sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind) || left.name.localeCompare(right.name, "zh-CN"));
}





export function OntologyManager({ definition, draft, targetId, user, runtimeTypes, refreshRuntimeTypes, save, validate, publish, notify, initialRun, openDynamics, onDynamicsOpened, onRan, fail }: { definition: Definition; draft: Version | null; targetId?: string; user: User; runtimeTypes: RuntimeTypeSet | null; refreshRuntimeTypes: () => void; save: (definition: Definition) => Promise<void>; validate: () => Promise<void>; publish: () => Promise<void>; notify: (text: string) => void; initialRun?: { actionId: string; subject: EntitySearchResult } | null; openDynamics?: "actions" | "rules" | null; onDynamicsOpened?: () => void; onRan: () => Promise<void>; fail: (reason: unknown) => void }) {
  const [name, setName] = useState(""); const [description, setDescription] = useState(""); const [rel, setRel] = useState({ name: "", source: "", target: "" });
  const [editingEntity, setEditingEntity] = useState<EntityType | null>(null);
  const [editingRelation, setEditingRelation] = useState<RelationType | null>(null);
  // 一级标签：可视化建模 → 概念分组 → 对象类型 → 关系类型 → 接口。
  // 「对象类型 / 关系类型」原先藏在「表单」标签里当二级标签，2026-09-16 提到一级，表单标签删除。
  const [mode, setMode] = useState<ModelingMode>("visual");
  const [filter, setFilter] = useState("");
  /** 画布上点接口节点后要「编辑接口」：切到「接口」标签并选中它。 */
  const [interfaceFocusId, setInterfaceFocusId] = useState("");
  /** 建模体检面板开没开。默认收起：它是"回头看一眼"的工具，不该一进来就占掉半屏。 */
  const [reviewOpen, setReviewOpen] = useState(false);
  // 页头按钮上挂一个角标，说清"有几项该改" —— 不点开也知道要不要点开。
  const reviewSummary = useMemo(() => summarizeModelingReview(reviewOntologyModel(definition)), [definition]);
  const searchHits = useMemo(() => modelingSearchHits(definition, filter), [definition, filter]);
  useEffect(() => {
    if (!openDynamics) return;
    setMode(openDynamics);
    onDynamicsOpened?.();
  }, [openDynamics, onDynamicsOpened]);
  const openSearchHit = (hit: ModelingSearchHit) => {
    setFilter("");
    setMode(hit.mode);
    if (hit.mode === "entities") {
      const entity = definition.entityTypes.find((item) => item.id === hit.id);
      if (entity) setEditingEntity(entity);
    } else if (hit.mode === "relations") {
      const relation = definition.relationshipTypes.find((item) => item.id === hit.id);
      if (relation) setEditingRelation(relation);
    }
  };
  // 画布上新建时 id 由调用方生成，便于创建后立刻选中刚出现的节点或连线。
  // 概念分组在保存这一刻才定 id：界面上填的是分组名，重名就复用已有的那一条（resolveGroup）。
  const createEntity = async (id: string, payload: EntityPayload) => { try { const trimmed = payload.name.trim(); if (!trimmed) throw new Error("请填写对象类型的名称。"); if (definition.entityTypes.some((item) => item.name === trimmed)) throw new Error("对象类型的名称已存在。"); const named = resolveGroup(definition.groups ?? [], payload.groupName ?? ""); await save({ ...definition, groups: named.groups, entityTypes: [...definition.entityTypes, { id, name: trimmed, description: payload.description.trim(), displayProperty: payload.displayProperty.trim(), groupId: named.groupId, implements: payload.implements ?? [], indexPolicy: payload.indexPolicy, properties: payload.properties, sources: payload.sources, dictionaries: payload.dictionaries }] }); notify("对象类型已加入草稿。"); } catch (reason) { fail(reason); } };
  const createRelation = async (id: string, payload: RelationPayload) => { try { const trimmed = payload.name.trim(); if (!trimmed) throw new Error("请填写关系类型名称。"); if (!payload.sourceEntityTypeId || !payload.targetEntityTypeId) throw new Error("请选择关系的起始对象类型与终止对象类型。"); if (definition.relationshipTypes.some((item) => item.name === trimmed)) throw new Error("关系类型名称已存在。"); await save({ ...definition, relationshipTypes: [...definition.relationshipTypes, { id, name: trimmed, description: (payload.description ?? "").trim(), sourceEntityTypeId: payload.sourceEntityTypeId, targetEntityTypeId: payload.targetEntityTypeId, sourceKeyMappings: payload.sourceKeyMappings ?? [], targetKeyMappings: payload.targetKeyMappings ?? [], linkSource: payload.linkSource ?? EMPTY_LINK_SOURCE, cardinality: payload.cardinality ?? "", properties: payload.properties }] }); notify("关系类型已加入草稿。"); } catch (reason) { fail(reason); } };
  const [importPlan, setImportPlan] = useState<{ newEntities: EntityType[]; newRelations: RelationType[]; mergedEntities: EntityType[]; mergedRelations: RelationType[]; changedEntities: number; changedRelations: number; unresolved: number; inferredProperties: number } | null>(null);
  const addEntity = async (event: FormEvent) => { event.preventDefault(); try { if (!name.trim()) return; if (definition.entityTypes.some((item) => item.name === name.trim())) throw new Error("对象类型的名称已存在。"); await save({ ...definition, entityTypes: [...definition.entityTypes, { id: newId(), name: name.trim(), description: description.trim(), properties: [] }] }); setName(""); setDescription(""); } catch (reason) { fail(reason); } };
  const addRelation = async (event: FormEvent) => { event.preventDefault(); try { if (!rel.name || !rel.source || !rel.target) throw new Error("请填写关系类型和两个端点。"); await save({ ...definition, relationshipTypes: [...definition.relationshipTypes, { id: newId(), name: rel.name, sourceEntityTypeId: rel.source, targetEntityTypeId: rel.target, sourceKeyMappings: [], targetKeyMappings: [], properties: [] }] }); setRel({ name: "", source: "", target: "" }); } catch (reason) { fail(reason); } };
  const updateEntity = async (id: string, patch: EntityPayload) => { try { const next = structuredClone(definition); const idx = next.entityTypes.findIndex((item) => item.id === id); if (idx < 0) throw new Error("这个对象类型已经不在当前草稿里了（草稿可能被替换过）——关掉这个窗口，重新打开再改。"); if (next.entityTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("对象类型的名称已存在。"); // groupName 没传就是"这次不改分组"；传了空串才是"移出分组"。
    const named = patch.groupName === undefined ? null : resolveGroup(next.groups ?? [], patch.groupName); if (named) next.groups = named.groups; next.entityTypes[idx] = { ...next.entityTypes[idx], name: patch.name.trim(), description: patch.description.trim(), displayProperty: (patch.displayProperty ?? "").trim(), groupId: named ? named.groupId : next.entityTypes[idx].groupId, implements: patch.implements ?? next.entityTypes[idx].implements ?? [], indexPolicy: patch.indexPolicy ?? next.entityTypes[idx].indexPolicy, properties: patch.properties, sources: patch.sources, dictionaries: patch.dictionaries ?? next.entityTypes[idx].dictionaries }; await save(next); notify("对象类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const updateRelation = async (id: string, patch: { name: string; description?: string; sourceEntityTypeId: string; targetEntityTypeId: string; sourceKeyMappings?: KeyMapping[]; targetKeyMappings?: KeyMapping[]; linkSource?: RelationType["linkSource"]; cardinality?: RelationType["cardinality"]; properties: Property[] }) => { try { const next = structuredClone(definition); const idx = next.relationshipTypes.findIndex((item) => item.id === id); if (idx < 0) throw new Error("这条关系类型已经不在当前草稿里了（草稿可能被替换过）——关掉这个窗口，重新打开再改。"); if (next.relationshipTypes.some((item, i) => i !== idx && item.name === patch.name.trim())) throw new Error("关系类型名称已存在。"); next.relationshipTypes[idx] = { ...next.relationshipTypes[idx], name: patch.name.trim(), description: (patch.description ?? "").trim(), sourceEntityTypeId: patch.sourceEntityTypeId, targetEntityTypeId: patch.targetEntityTypeId, sourceKeyMappings: patch.sourceKeyMappings ?? [], targetKeyMappings: patch.targetKeyMappings ?? [], linkSource: patch.linkSource ?? EMPTY_LINK_SOURCE, cardinality: patch.cardinality ?? "", properties: patch.properties }; await save(next); notify("关系类型及其属性已更新。"); } catch (reason) { fail(reason); } };
  const deleteEntity = async (id: string) => { const item = definition.entityTypes.find((entry) => entry.id === id); if (!item) return; const affectedRelations = definition.relationshipTypes.filter((entry) => entry.sourceEntityTypeId === id || entry.targetEntityTypeId === id); if (!window.confirm(`删除对象类型「${item.name}」？${affectedRelations.length ? `引用该类型的 ${affectedRelations.length} 个关系类型（${affectedRelations.map((entry) => entry.name).join("、")}）将一并删除。` : "该类型的属性定义将一并删除。"}`)) return; try { const next = structuredClone(definition); next.entityTypes = next.entityTypes.filter((entry) => entry.id !== id); next.relationshipTypes = next.relationshipTypes.filter((entry) => entry.sourceEntityTypeId !== id && entry.targetEntityTypeId !== id); await save(next); notify("对象类型已从草稿中移除。"); } catch (reason) { fail(reason); } };
  const deleteRelation = async (id: string) => { const item = definition.relationshipTypes.find((entry) => entry.id === id); if (!item) return; if (!window.confirm(`删除关系类型「${item.name}」？该类型的属性定义将一并删除。`)) return; try { const next = structuredClone(definition); next.relationshipTypes = next.relationshipTypes.filter((entry) => entry.id !== id); await save(next); notify("关系类型已从草稿中移除。"); } catch (reason) { fail(reason); } };
  const extractTypesFromSnapshot = () => {
    if (!runtimeTypes) return;
    const entityNames = new Set(definition.entityTypes.map((item) => item.name));
    const newEntities: EntityType[] = runtimeTypes.labels.filter((item) => !entityNames.has(item.name)).map((item) => ({ id: newId(), name: item.name, description: "", displayProperty: "", properties: item.properties ?? [] }));
    const entityIdByName = new Map<string, string>([...definition.entityTypes, ...newEntities].map((item) => [item.name, item.id]));
    const endpoints = runtimeTypes.relationshipEndpoints ?? {};
    const resolve = (label: string | undefined) => (label ? entityIdByName.get(label) ?? "" : "");
    const newRelations: RelationType[] = runtimeTypes.relationshipTypes.filter((item) => !definition.relationshipTypes.some((existing) => existing.name === item.name)).map((item) => {
      const endpoint = endpoints[item.name];
      return { id: newId(), name: item.name, sourceEntityTypeId: resolve(endpoint?.source), targetEntityTypeId: resolve(endpoint?.target), properties: item.properties ?? [] };
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
    const entityIdByName = new Map<string, string>(runtimeTypes.labels.map((item) => [item.name, newId()]));
    const endpoints = runtimeTypes.relationshipEndpoints ?? {};
    const resolve = (label: string | undefined) => (label ? entityIdByName.get(label) ?? "" : "");
    const entityTypes: EntityType[] = runtimeTypes.labels.map((item) => ({ id: entityIdByName.get(item.name) ?? "", name: item.name, description: "", displayProperty: "", properties: item.properties ?? [] }));
    const relationshipTypes: RelationType[] = runtimeTypes.relationshipTypes.map((item) => {
      const endpoint = endpoints[item.name];
      return { id: newId(), name: item.name, sourceEntityTypeId: resolve(endpoint?.source), targetEntityTypeId: resolve(endpoint?.target), properties: item.properties ?? [] };
    });
    try { await save({ ...definition, entityTypes, relationshipTypes }); notify("已用快照中的类型覆盖草稿。"); } catch (reason) { fail(reason); }
  };
  /**
   * 关系类型里有多少条读不出实例（两端键映射空 / 连接表式没选连接表）。清单抬头直接标出来，
   * 48 条一条条点开才知道有没有配太费事。判据与后端同源：`planLinkSource`
   * （`link-source.ts` 不引 `node:crypto`，所以浏览器里能直接调它）。
   */
  const relationsWithoutSource = definition.relationshipTypes.filter((item) => !planLinkSource(definition, item).ok).length;
  return <section className="stack"><div className="panel functional-panel"><div className="title-row"><div><span className="eyebrow">本体建模</span><h2>{draft ? `v${draft.version_number} · 未发布` : "尚无草稿"}</h2></div><div className="functional-actions"><button className="action" disabled={!may(user, "ontology.write") || !runtimeTypes} onClick={() => void extractTypesFromSnapshot()} title="从当前版本快照提取对象和关系类型并合并到草稿"><Database size={16} />从快照提取类型</button><button className="action" onClick={refreshRuntimeTypes} title="重新读取当前版本快照中的对象、关系、端点和属性推断"><RefreshCcw size={16} />刷新快照数据</button><button className="action" disabled={!may(user, "ontology.publish")} onClick={() => validate().catch(fail)}><FileCheck2 size={16} />校验</button><button className="action" onClick={() => setReviewOpen((current) => !current)} title="给草稿做一次建模体检：空壳 / 孤悬 / 主键列接不上 / 命名打架 …… 只给建议，不挡发布"><Stethoscope size={16} />建模体检{reviewSummary.warn ? <em className="review-badge">{reviewSummary.warn}</em> : null}</button><button className="action primary" disabled={!may(user, "ontology.publish")} onClick={() => publish().catch(fail)}><ShieldCheck size={16} />发布</button></div></div>{mode === "visual" ? <p className="subtle">在画布上直接搭模型：加对象类型、从节点拉出关系类型、点开补属性与端点，每次改动都会立刻存进草稿。</p> : mode === "groups" ? <p className="subtle">按业务域把对象类型归堆：分组的颜色就是画布「按逻辑分组」时画的那个框。分组只影响怎么摆、怎么画，不进图库、也不改对象类型的定义。</p> : mode === "entities" ? <p className="subtle">对象类型的清单与新增入口：改动会先保存为草稿，发布前会检查端点契约与必填属性；点单个类型的「编辑」一并配置属性、数据来源与实现的接口。</p> : mode === "relations" ? <p className="subtle">关系类型的清单与新增入口：每条关系类型都连两个对象类型，可以带自己的属性。关系类型是<b>双向</b>的：两个方向都能走，不用再建反向的那一条。</p> : mode === "interfaces" ? <p className="subtle">接口是抽象契约：只描述实现它的对象类型必须有哪些属性、哪些关系，不绑数据、也不能被实例化。应用按接口统一消费，新加一个实现了它的对象类型不用改应用。</p> : mode === "metrics" ? <p className="subtle">指标是业务口径：一条指标说清「这个数怎么算」——作用在哪个对象类型、按哪个属性怎么聚合、口径过滤是什么、能按哪些维度分组、单位是什么。它只描述口径，出数仍由模型落成只读 SQL。</p> : mode === "actions" ? <p className="subtle">动作是平台里唯一的业务写入口：把「一次业务动作的正确做法」固定成模板，后续编辑步骤、运行参数与写回计划都在这里定义；改动会保存进当前草稿。</p> : <p className="subtle">规则挂在动作上，决定它什么时候出现、什么时候拦截、什么时候只提醒；规则和动作共用同一份草稿。</p>}</div><div className="modeling-toolbar"><div className="view-switcher" aria-label="本体编辑方式"><button className={mode === "visual" ? "active" : ""} aria-pressed={mode === "visual"} onClick={() => setMode("visual")}>可视化建模</button><button className={mode === "groups" ? "active" : ""} aria-pressed={mode === "groups"} onClick={() => setMode("groups")}>概念分组 <b>{definition.groups.length}</b></button><button className={mode === "entities" ? "active" : ""} aria-pressed={mode === "entities"} onClick={() => setMode("entities")}>对象类型 <b>{definition.entityTypes.length}</b></button><button className={mode === "relations" ? "active" : ""} aria-pressed={mode === "relations"} onClick={() => setMode("relations")}>关系类型 <b>{definition.relationshipTypes.length}</b></button><button className={mode === "interfaces" ? "active" : ""} aria-pressed={mode === "interfaces"} onClick={() => setMode("interfaces")}>接口 <b>{definition.interfaces.length}</b></button><button className={mode === "metrics" ? "active" : ""} aria-pressed={mode === "metrics"} onClick={() => setMode("metrics")}>指标 <b>{definition.metrics.length}</b></button><button className={mode === "actions" ? "active" : ""} aria-pressed={mode === "actions"} onClick={() => setMode("actions")}>动作 <b>{definition.actionTypes.length}</b></button><button className={mode === "rules" ? "active" : ""} aria-pressed={mode === "rules"} onClick={() => setMode("rules")}>规则 <b>{definition.rules.length}</b></button></div><label className="modeling-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索本体模型" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索对象类型、关系类型、接口、指标、动作、规则…" />{filter && <button type="button" title="清除搜索" onClick={() => setFilter("")}><X size={13} /></button>}</label></div>{reviewOpen ? <ModelingReviewPanel definition={definition} onLocate={(scope) => { if (scope === "OBJECT_TYPE") setMode("entities"); else if (scope === "RELATION_TYPE") setMode("relations"); else if (scope === "INTERFACE") setMode("interfaces"); else if (scope === "GROUP") setMode("groups"); else if (scope === "ACTION") setMode("actions"); else if (scope === "RULE") setMode("rules"); }} /> : null}{filter.trim() ? <div className="panel functional-panel modeling-search-results"><div className="title-row"><div><span className="eyebrow">搜索本体模型</span><h2>「{filter.trim()}」找到 {searchHits.length} 项</h2></div><button className="action compact" onClick={() => setFilter("")}>清空搜索</button></div>{searchHits.length ? <div className="modeling-search-list">{searchHits.map((hit) => <button type="button" key={`${hit.kind}-${hit.id}`} className="modeling-search-row" onClick={() => openSearchHit(hit)}><span className="modeling-search-kind">{hit.kind}</span><span><b>{hit.name}</b><small>{hit.description || "未填写说明"}</small></span><em>{hit.meta}</em></button>)}</div> : <p className="empty">没有匹配的建模内容。换个名称、说明或字段名试试。</p>}</div> : mode === "actions" ? <ActionStudio key={`actions-${draft?.id ?? "none"}-${initialRun?.actionId ?? ""}`} definition={definition} versionId={draft?.id} targetId={targetId} canEdit={may(user, "ontology.write")} canRun={may(user, "instance.write")} initialRun={initialRun} onSave={save} onRan={onRan} notify={notify} fail={fail} /> : mode === "rules" ? <ActionStudio key={`rules-${draft?.id ?? "none"}`} definition={definition} versionId={draft?.id} targetId={targetId} canEdit={may(user, "ontology.write")} canRun={may(user, "instance.write")} initialStage="rules" onSave={save} onRan={onRan} notify={notify} fail={fail} /> : mode === "metrics" ? <MetricManager definition={definition} canEdit={may(user, "ontology.write")} save={save} notify={notify} fail={fail} /> : mode === "interfaces" ? <InterfaceManager definition={definition} canEdit={may(user, "ontology.write")} save={save} notify={notify} fail={fail} focusId={interfaceFocusId} /> : mode === "groups" ? <ConceptGroupManager definition={definition} canEdit={may(user, "ontology.write")} save={save} notify={notify} fail={fail} /> : mode === "visual" ? <OntologyBuilder definition={definition} targetId={targetId} canEdit={may(user, "ontology.write")} hasSnapshot={Boolean(runtimeTypes)} onCreateEntity={createEntity} onUpdateEntity={async (id, payload) => updateEntity(id, { name: payload.name, description: payload.description, displayProperty: payload.displayProperty, groupName: payload.groupName, implements: payload.implements, properties: payload.properties, sources: payload.sources })} onDeleteEntity={deleteEntity} onCreateRelation={createRelation} onUpdateRelation={async (id, payload) => updateRelation(id, { name: payload.name, description: payload.description, sourceEntityTypeId: payload.sourceEntityTypeId, targetEntityTypeId: payload.targetEntityTypeId, sourceKeyMappings: payload.sourceKeyMappings ?? [], targetKeyMappings: payload.targetKeyMappings ?? [], linkSource: payload.linkSource, properties: payload.properties })} onDeleteRelation={deleteRelation} onSaveDefinition={save} onExtract={extractTypesFromSnapshot} onOpenActions={() => setMode("actions")} onOpenGroups={() => setMode("groups")} onOpenInterface={(id) => { setInterfaceFocusId(id); setMode("interfaces"); }} onNotify={notify} onFail={fail} /> : mode === "entities" ? <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addEntity}><span className="eyebrow">对象类型</span><h2>新增对象类型</h2><label>名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客户" required /></label><label>说明<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="业务含义" /></label><button className="action primary" disabled={!may(user, "ontology.write")} title={may(user, "ontology.write") ? undefined : "当前角色没有「编辑草稿」权限"}><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">对象类型清单</span><h2>{definition.entityTypes.length} 个对象类型</h2>{definition.entityTypes.map((item) => <div className="type-row" key={item.id}><CircleDot size={17} /><b>{item.name}</b><span>{item.description || "未填写说明"}</span><em>{item.properties.length} 属性</em>{item.sources?.length ? <i className="type-source"><Table2 size={11} />{sourceSummary(item)}</i> : null}<button className="action compact" disabled={!may(user, "ontology.write")} onClick={() => setEditingEntity(item)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={!may(user, "ontology.write")} onClick={() => void deleteEntity(item.id)}><Trash2 size={13} />删除</button></div>)}{!definition.entityTypes.length && <p className="empty">尚未创建对象类型。</p>}</div></div> : <div className="manager-grid"><form className="panel functional-panel form-panel" onSubmit={addRelation}><span className="eyebrow">关系类型</span><h2>新增关系类型</h2><label>关系名称<input value={rel.name} onChange={(event) => setRel({ ...rel, name: event.target.value })} placeholder="例如：负责" required /></label><label>起始对象类型<select value={rel.source} onChange={(event) => setRel({ ...rel, source: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>终止对象类型<select value={rel.target} onChange={(event) => setRel({ ...rel, target: event.target.value })} required><option value="">选择类型</option>{definition.entityTypes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><button className="action primary" disabled={!may(user, "ontology.write")} title={may(user, "ontology.write") ? undefined : "当前角色没有「编辑草稿」权限"}><Plus size={16} />加入草稿</button></form><div className="panel functional-panel type-list"><span className="eyebrow">关系契约清单</span><h2>{definition.relationshipTypes.length} 个关系类型{relationsWithoutSource ? ` · ${relationsWithoutSource} 条读不出实例（缺键映射 / 连接表）` : ""}</h2>{definition.relationshipTypes.map((item) => {
  /* 键映射状态直接摆在清单里（用户口径 2026-10-12：「可以直接在这里也显示，方便用户查看」）。 */
  const mapped = [...keyMappingRows(item.sourceKeyMappings), ...keyMappingRows(item.targetKeyMappings)].map(keyMappingLabel);
  const plan = planLinkSource(definition, item);
  const keyTable = plan.ok ? [plan.table.schema, plan.table.name].filter(Boolean).join(".") : "";
  return <div className="type-row" key={item.id}><Link2 size={17} /><b>{item.name}</b><span>{item.sourceEntityTypeId ? definition.entityTypes.find((e) => e.id === item.sourceEntityTypeId)?.name ?? "?" : "未指定"} ↔ {item.targetEntityTypeId ? definition.entityTypes.find((e) => e.id === item.targetEntityTypeId)?.name ?? "?" : "未指定"}</span>
    {plan.ok
      ? <i className="type-key" title={`键映射：${mapped.join(" · ")}；读得出实例 —— 取数走 ${keyTable}（${plan.mode === "JOIN_TABLE" ? "连接表式" : "外键式"}）。`}><KeyRound size={11} />键映射 {mapped.join(" · ")}</i>
      : <i className="type-key warn" title={`${plan.reason}补上之前，这条关系类型读不出实例：图上看不到它的边，也不能整份物化。点「编辑」在「两端的键映射」里补。`}><AlertTriangle size={11} />键映射 {mapped.length ? `${mapped.length} 条 · 读不出边` : "未填 · 读不出边"}</i>}
    <em>{item.properties.length} 属性</em><button className="action compact" disabled={!may(user, "ontology.write")} onClick={() => setEditingRelation(item)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={!may(user, "ontology.write")} onClick={() => void deleteRelation(item.id)}><Trash2 size={13} />删除</button></div>;
})}{!definition.relationshipTypes.length && <p className="empty">尚未创建关系类型。</p>}</div></div>}
      {editingEntity && <TypeEditDialog kind="entity" entity={editingEntity} entityTypes={definition.entityTypes} groups={definition.groups} interfaces={definition.interfaces} onClose={() => setEditingEntity(null)} onSave={async (payload) => { await updateEntity(editingEntity.id, { name: payload.name, description: payload.description ?? "", displayProperty: payload.displayProperty ?? "", groupName: payload.groupName, implements: payload.implements, indexPolicy: payload.indexPolicy, properties: payload.properties, sources: payload.sources, dictionaries: payload.dictionaries }); setEditingEntity(null); }} />}{editingRelation && <TypeEditDialog kind="relation" relation={editingRelation} entityTypes={definition.entityTypes} interfaces={definition.interfaces} onClose={() => setEditingRelation(null)} onSave={async (payload) => { await updateRelation(editingRelation.id, { name: payload.name, sourceEntityTypeId: payload.sourceEntityTypeId ?? "", targetEntityTypeId: payload.targetEntityTypeId ?? "", sourceKeyMappings: payload.sourceKeyMappings ?? [], targetKeyMappings: payload.targetKeyMappings ?? [], linkSource: payload.linkSource, properties: payload.properties }); setEditingRelation(null); }} />}
      {importPlan && <div className="dialog-backdrop" role="presentation"><div className="dialog graph-dialog"><button type="button" className="close-button" onClick={() => setImportPlan(null)} title="关闭"><X size={18} /></button><div className="dialog-icon"><Database size={22} /></div><span className="eyebrow">从快照提取类型</span><h2>选择提取方式</h2><p>当前快照中共有 {runtimeTypes?.labels.length ?? 0} 个标签、{runtimeTypes?.relationshipTypes.length ?? 0} 个关系类型。{importPlan.newEntities.length || importPlan.newRelations.length ? <>草稿缺少 {importPlan.newEntities.length} 个对象类型、{importPlan.newRelations.length} 个关系类型；</> : <>草稿已包含快照中的全部类型；</>}{importPlan.changedRelations || importPlan.changedEntities ? <>可为 {importPlan.changedEntities} 个已有的对象类型、{importPlan.changedRelations} 个已有关系类型补齐属性或端点。</> : ""}</p><p>属性将按现有数据推断：名称、取值类型，以及是否必填（该类型全部实例均含此键）与是否唯一（取值互不相同），共约 {importPlan.inferredProperties} 个属性。<br /><b>合并</b>：保留草稿中的现有配置，仅补充缺失类型并为空属性、空端点补齐。<br /><b>覆盖</b>：用快照类型整体替换草稿的类型清单，草稿中已配置的说明、显示属性与属性定义会被清空。</p>{importPlan.unresolved > 0 && <p>{importPlan.unresolved} 个关系类型仍无法确定起始/终止对象类型，导入后需手动补选。</p>}<div className="dialog-actions"><button type="button" className="quiet-button" onClick={() => setImportPlan(null)}>取消</button><button type="button" className="action" onClick={() => void mergeImport()}><Merge size={16} />合并</button><button type="button" className="action primary" onClick={() => void overwriteImport()}><RefreshCcw size={16} />覆盖</button></div></div></div>}</section>;
}
