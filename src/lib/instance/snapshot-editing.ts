import { randomUUID } from "node:crypto";
import { ActionBlockedError, runAction, visibleActions, type ActionOutcome, type ActionRunInput, type ActionVisibility } from "@/lib/instance/action-engine";
import { parsePropertyValues } from "@/lib/instance/instance-property-editor";
import { changedProperties } from "@/lib/ontology/object-edits";
import { resolveObjectIdentity } from "@/lib/ontology/object-identity";
import { entityFromSnapshot, getVersionRecord, mutateDraftSnapshot, nodeSchema, readVersionSnapshot, relationshipFromSnapshot, relationshipSchema } from "@/lib/versioning/snapshot";

/**
 * 草稿实例的编辑与动作执行。
 *
 * 版本模块只负责快照存取；对象增删改、关系增删改和动作执行属于实例域，放在这里，
 * 避免 `versioning` 反向依赖 `instance`。
 */
export async function visibleSnapshotActions(versionId: string, subjectEntityId: string): Promise<ActionVisibility[]> {
  const snapshot = await readVersionSnapshot(versionId);
  return visibleActions(snapshot.definition, snapshot, subjectEntityId);
}

/**
 * 运行动作。
 *
 * 干跑只读快照、返回"会发生什么"；执行则在草稿锁内按最新快照重算一次再落盘，
 * 命中闸门规则时抛出 `ActionBlockedError`，快照文件保持原样。
 */
export async function runSnapshotAction(versionId: string, actionId: string, inputs: ActionRunInput[], options: { dryRun: boolean; subjectEntityId?: string }): Promise<{ outcome: ActionOutcome; applied: boolean }> {
  const row = await getVersionRecord(versionId);
  if (!row) throw new Error("本体版本不存在。");
  if (row.status !== "DRAFT") throw new Error("只有草稿版本可以运行动作，请先创建草稿。");
  const snapshot = await readVersionSnapshot(versionId);
  const preview = runAction(snapshot.definition, snapshot, actionId, inputs, { subjectEntityId: options.subjectEntityId });
  if (options.dryRun || preview.verdict === "BLOCKED") return { outcome: preview, applied: false };
  const outcome = await mutateDraftSnapshot<ActionOutcome>(versionId, (current) => {
    const fresh = runAction(current.definition, current, actionId, inputs, { subjectEntityId: options.subjectEntityId });
    if (fresh.verdict === "BLOCKED") throw new ActionBlockedError(fresh);
    const previousIds = new Set(current.nodes.map((node) => node.id));
    current.objectEdits ??= {};
    for (const node of fresh.graph.nodes) {
      if (previousIds.has(node.id)) continue;
      const type = current.definition.entityTypes.find((entity) => node.labels.includes(entity.name));
      if (type) current.objectEdits[node.id] = { entityTypeId: type.id, primaryKey: resolveObjectIdentity(type, node.properties)?.primaryKey ?? {}, base: null };
    }
    current.nodes = fresh.graph.nodes;
    current.relationships = fresh.graph.relationships;
    return fresh;
  }).catch((reason: unknown) => {
    if (reason instanceof ActionBlockedError) return reason.outcome;
    throw reason;
  });
  return { outcome, applied: outcome.verdict === "PASSED" };
}

export async function createSnapshotEntity(versionId: string, entityType: string, rawProperties: Record<string, unknown>, options: { sourceBase?: Record<string, unknown> } = {}) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const type = snapshot.definition.entityTypes.find((item) => item.name === entityType);
    if (!type) throw new Error("对象类型未在当前草稿中定义。");
    const properties = parsePropertyValues(type.properties, rawProperties);
    /*
     * 对象身份 = (对象类型, 主键)：主键齐全时 id 由主键推出来（确定性），
     * 于是同一个业务记录在本体里只有一份，换快照 / 重复导入都落到同一个对象上（S1）。
     */
    const identity = resolveObjectIdentity(type, properties);
    if (identity && snapshot.nodes.some((node) => node.id === identity.id)) {
      throw new Error(`已经存在主键相同的「${type.name}」对象，不能在同一个本体里重复新建。`);
    }
    const node = nodeSchema.parse({ id: identity?.id ?? randomUUID(), labels: [type.name], properties });
    snapshot.nodes.push(node);
    snapshot.objectEdits ??= {};
    snapshot.objectEdits[node.id] = { entityTypeId: type.id, primaryKey: identity?.primaryKey ?? {}, base: options.sourceBase ?? null };
    return entityFromSnapshot(node);
  });
}

export async function updateSnapshotEntity(versionId: string, entityId: string, rawProperties: Record<string, unknown>, displayedBase?: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const node = snapshot.nodes.find((item) => item.id === entityId);
    if (!node) return null;
    const type = snapshot.definition.entityTypes.find((item) => node.labels.includes(item.name));
    if (!type) throw new Error("对象类型未在当前草稿中定义。");
    const layout = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key === "fx" || key === "fy"));
    const submitted = displayedBase && snapshot.objectEdits?.[entityId]?.base
      ? { ...node.properties, ...changedProperties(displayedBase, rawProperties) }
      : rawProperties;
    const parsed = parsePropertyValues(type.properties, submitted);
    const beforeKey = resolveObjectIdentity(type, node.properties);
    const nextKey = resolveObjectIdentity(type, parsed);
    if (beforeKey && beforeKey.id !== nextKey?.id) throw new Error("不能修改对象主键；主键决定对象身份。请新建对象。");
    node.properties = { ...parsed, ...layout };
    return entityFromSnapshot(node);
  });
}

export async function deleteSnapshotEntity(versionId: string, entityId: string) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const edit = snapshot.objectEdits?.[entityId];
    if (edit) {
      if (edit.base) edit.deleted = true;
      else delete snapshot.objectEdits![entityId];
    }
    const before = snapshot.nodes.length;
    snapshot.nodes = snapshot.nodes.filter((node) => node.id !== entityId);
    snapshot.relationships = snapshot.relationships.filter((relationship) => relationship.sourceId !== entityId && relationship.targetId !== entityId);
    return before !== snapshot.nodes.length;
  });
}

export async function resetSnapshotObjectEdit(versionId: string, entityId: string) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const edit = snapshot.objectEdits?.[entityId];
    if (!edit?.base) throw new Error("这不是源对象的覆盖修改，本地新建对象请使用删除。");
    delete snapshot.objectEdits![entityId];
    snapshot.nodes = snapshot.nodes.filter((node) => node.id !== entityId);
    snapshot.relationships = snapshot.relationships.filter((edge) => edge.sourceId !== entityId && edge.targetId !== entityId);
    return true;
  });
}

export async function createSnapshotRelationship(versionId: string, typeName: string, sourceId: string, targetId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const type = snapshot.definition.relationshipTypes.find((item) => item.name === typeName);
    if (!type) throw new Error("关系类型未在当前草稿中定义。");
    const source = snapshot.nodes.find((node) => node.id === sourceId);
    const target = snapshot.nodes.find((node) => node.id === targetId);
    const sourceType = snapshot.definition.entityTypes.find((item) => item.id === type.sourceEntityTypeId);
    const targetType = snapshot.definition.entityTypes.find((item) => item.id === type.targetEntityTypeId);
    if (!source || !target) throw new Error("关系端点不存在。");
    if (!sourceType || !targetType || !source.labels.includes(sourceType.name) || !target.labels.includes(targetType.name)) throw new Error("关系端点不符合草稿类型契约。");
    const relationship = relationshipSchema.parse({ id: randomUUID(), sourceId, targetId, type: type.name, properties: parsePropertyValues(type.properties, rawProperties) });
    snapshot.relationships.push(relationship);
    return relationshipFromSnapshot(relationship, new Map(snapshot.nodes.map((node) => [node.id, node])));
  });
}

export async function updateSnapshotRelationship(versionId: string, relationshipId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const relationship = snapshot.relationships.find((item) => item.id === relationshipId);
    if (!relationship) return null;
    const type = snapshot.definition.relationshipTypes.find((item) => item.name === relationship.type);
    if (!type) throw new Error("关系类型未在当前草稿中定义。");
    relationship.properties = parsePropertyValues(type.properties, rawProperties);
    return relationshipFromSnapshot(relationship, new Map(snapshot.nodes.map((node) => [node.id, node])));
  });
}

export async function deleteSnapshotRelationship(versionId: string, relationshipId: string) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const before = snapshot.relationships.length;
    snapshot.relationships = snapshot.relationships.filter((relationship) => relationship.id !== relationshipId);
    return before !== snapshot.relationships.length;
  });
}

export async function updateSnapshotPositions(versionId: string, items: { elementId: string; x: number; y: number }[]) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const positions = new Map(items.map((item) => [item.elementId, item]));
    let updated = 0;
    for (const node of snapshot.nodes) {
      const position = positions.get(node.id);
      if (!position) continue;
      node.properties = { ...node.properties, fx: position.x, fy: position.y };
      updated += 1;
    }
    return updated;
  });
}
