import { changedProperties } from "@/lib/ontology/object-edits";
import type { OntologyDefinition } from "@/lib/ontology";
import type {
  OdsPublishedObjectChange,
  OdsPublishedRelationshipChange,
  OdsVersionChanges,
} from "@/lib/infrastructure/ods/types";
import type { SnapshotNode, SnapshotRelationship, VersionSnapshot } from "@/lib/versioning/snapshot";
import { listVersionRecords, mutateDraftSnapshot } from "@/lib/versioning/snapshot";
import { getOdsStore } from "@/lib/infrastructure/ods";

function stringKey(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item ?? "").trim()]));
}

/**
 * 草稿快照 → 发布版本稀疏变更集。
 *
 * 新草稿已经继承上一发布版本的有效变更，因此这里生成的是相对 ODS 基础镜像的累计结果。
 */
export function versionChangesFromSnapshot(snapshot: VersionSnapshot, versionId: string): OdsVersionChanges {
  const entityTypes = new Map(snapshot.definition.entityTypes.map((type) => [type.id, type]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const objects: OdsPublishedObjectChange[] = [];

  for (const [objectId, edit] of Object.entries(snapshot.objectEdits ?? {})) {
    const entityType = entityTypes.get(edit.entityTypeId);
    if (!entityType) continue;
    const node = nodes.get(objectId);
    if (edit.deleted) {
      if (!edit.base) continue;
      objects.push({
        versionId,
        entityTypeId: edit.entityTypeId,
        entityType: entityType.name,
        objectId,
        primaryKey: stringKey(edit.primaryKey),
        operation: "DELETE",
        base: edit.base,
        properties: {},
        changedProperties: [],
      });
      continue;
    }
    if (!node) continue;
    if (edit.base === null) {
      objects.push({
        versionId,
        entityTypeId: edit.entityTypeId,
        entityType: entityType.name,
        objectId,
        primaryKey: stringKey(edit.primaryKey),
        operation: "CREATE",
        base: null,
        properties: node.properties,
        changedProperties: Object.keys(node.properties).filter((key) => key !== "fx" && key !== "fy"),
      });
      continue;
    }
    const changed = changedProperties(edit.base, node.properties);
    if (!Object.keys(changed).length) continue;
    objects.push({
      versionId,
      entityTypeId: edit.entityTypeId,
      entityType: entityType.name,
      objectId,
      primaryKey: stringKey(edit.primaryKey),
      operation: "UPDATE",
      base: edit.base,
      properties: node.properties,
      changedProperties: Object.keys(changed).filter((key) => key !== "fx" && key !== "fy"),
    });
  }

  const relationshipTypes = new Map(snapshot.definition.relationshipTypes.map((type) => [type.name, type]));
  const relationships: OdsPublishedRelationshipChange[] = snapshot.relationships.flatMap((relationship) => {
    const type = relationshipTypes.get(relationship.type);
    if (!type) return [];
    const source = nodes.get(relationship.sourceId);
    const target = nodes.get(relationship.targetId);
    if (!source || !target) return [];
    const sourceType = snapshot.definition.entityTypes.find((item) => source.labels.includes(item.name));
    const targetType = snapshot.definition.entityTypes.find((item) => target.labels.includes(item.name));
    if (!sourceType || !targetType) return [];
    return [{
      versionId,
      relationshipTypeId: type.id,
      relationshipType: type.name,
      relationshipId: relationship.id,
      sourceEntityTypeId: sourceType.id,
      targetEntityTypeId: targetType.id,
      sourceObjectId: source.id,
      targetObjectId: target.id,
      sourcePrimaryKey: stringKey(primaryKeyOf(sourceType, source)),
      targetPrimaryKey: stringKey(primaryKeyOf(targetType, target)),
      operation: "CREATE" as const,
      properties: relationship.properties,
    }];
  });

  return { objects, relationships };
}

function primaryKeyOf(
  type: OntologyDefinition["entityTypes"][number],
  node: SnapshotNode,
): Record<string, unknown> {
  const source = type.sources?.[0];
  if (!source) return {};
  return Object.fromEntries(source.primaryKey.map((column) => {
    const property = type.properties.find((item) =>
      (item.sourceField || item.name).toLowerCase() === column.toLowerCase()
      && ((item.sourceId ?? "").trim() || source.id) === source.id);
    return [column, property ? node.properties[property.name] ?? "" : ""];
  }).filter(([column, value]) => column && String(value ?? "").trim()));
}

/** 发布版本稀疏变更集 → 查询时可复用的内存快照形状。 */
export function snapshotFromVersionChanges(
  definition: OntologyDefinition,
  changes: OdsVersionChanges,
): VersionSnapshot {
  const nodes: SnapshotNode[] = [];
  const objectEdits: NonNullable<VersionSnapshot["objectEdits"]> = {};
  for (const change of changes.objects) {
    const type = definition.entityTypes.find((item) => item.id === change.entityTypeId || item.name === change.entityType);
    if (!type) continue;
    objectEdits[change.objectId] = {
      entityTypeId: type.id,
      primaryKey: change.primaryKey,
      base: change.base,
      ...(change.operation === "DELETE" ? { deleted: true } : {}),
    };
    if (change.operation !== "DELETE") {
      nodes.push({
        id: change.objectId,
        labels: [type.name],
        properties: change.properties,
      });
    }
  }
  const relationships: SnapshotRelationship[] = changes.relationships.map((change) => ({
    id: change.relationshipId,
    type: change.relationshipType,
    sourceId: change.sourceObjectId,
    targetId: change.targetObjectId,
    properties: change.properties,
  }));
  return { definition, nodes, relationships, objectEdits, publishedChanges: true };
}

/**
 * 新建草稿时，从上一发布版本继承累计有效变更集。
 * 返回是否找到了需要继承的变更；没有时保留 initializeVersionSnapshot 的既有结果。
 */
export async function hydrateDraftFromPublishedVersion(draftVersionId: string, publishedVersionId: string) {
  const changes = await getOdsStore().readVersionChanges(publishedVersionId);
  if (!changes.objects.length && !changes.relationships.length) return false;
  await mutateDraftSnapshot(draftVersionId, (snapshot) => {
    const inherited = snapshotFromVersionChanges(snapshot.definition, changes);
    snapshot.nodes = inherited.nodes;
    snapshot.relationships = inherited.relationships;
    snapshot.objectEdits = inherited.objectEdits ?? {};
  });
  return true;
}

export async function deleteTargetVersionChanges(targetId: string) {
  const versions = await listVersionRecords(targetId);
  const store = getOdsStore();
  for (const version of versions) await store.deleteVersionChanges(version.id);
  return versions.length;
}
