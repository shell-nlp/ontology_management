import type { EntityRecord, GraphData, RelationshipRecord, RuntimeTypeSet } from "@/lib/infrastructure/graph/types";
import type { OntologyDefinition } from "@/lib/ontology";
import type { SnapshotNode, SnapshotRelationship, VersionSnapshot } from "@/lib/versioning/snapshot";

export function entityFromSnapshot(node: SnapshotNode): EntityRecord {
  return { id: node.id, labels: node.labels, properties: node.properties };
}

export function relationshipFromSnapshot(relationship: SnapshotRelationship, nodes: Map<string, SnapshotNode>): RelationshipRecord {
  const source = nodes.get(relationship.sourceId);
  const target = nodes.get(relationship.targetId);
  return {
    id: relationship.id,
    type: relationship.type,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    properties: relationship.properties,
    sourceLabels: source?.labels,
    sourceProperties: source?.properties,
    targetLabels: target?.labels,
    targetProperties: target?.properties,
  };
}

function searchable(values: unknown[]) {
  return values.map((value) => typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).join(" ").toLocaleLowerCase();
}

export function listSnapshotEntities(snapshot: VersionSnapshot, options: { label?: string | null; search?: string | null; limit?: number } = {}) {
  const search = options.search?.trim().toLocaleLowerCase();
  // 按对象类型筛就是字面匹配（类之间不再有父子关系；接口那层传播在图库侧读路径上做）。
  const labels = options.label ? new Set([options.label]) : null;
  return snapshot.nodes
    .filter((node) => !labels || node.labels.some((label) => labels.has(label)))
    .filter((node) => !search || searchable(Object.values(node.properties)).includes(search))
    .slice(0, options.limit ?? 200)
    .map(entityFromSnapshot);
}

export function listSnapshotRelationships(snapshot: VersionSnapshot, options: { type?: string | null; search?: string | null; limit?: number } = {}) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const search = options.search?.trim().toLocaleLowerCase();
  return snapshot.relationships
    .filter((relationship) => !options.type || relationship.type === options.type)
    .filter((relationship) => {
      if (!search) return true;
      const source = nodes.get(relationship.sourceId);
      const target = nodes.get(relationship.targetId);
      return searchable([relationship.type, ...Object.values(relationship.properties), ...Object.values(source?.properties ?? {}), ...Object.values(target?.properties ?? {})]).includes(search);
    })
    .slice(0, options.limit ?? 200)
    .map((relationship) => relationshipFromSnapshot(relationship, nodes));
}

export function graphFromSnapshot(snapshot: VersionSnapshot, options: { labels?: string[]; relationshipTypes?: string[]; search?: string | null; nodeLimit?: number } = {}): GraphData {
  const labels = new Set(options.labels ?? []);
  const relationshipTypes = new Set(options.relationshipTypes ?? []);
  const search = options.search?.trim().toLocaleLowerCase();
  let nodes = snapshot.nodes.filter((node) => (!labels.size || node.labels.some((label) => labels.has(label))) && (!search || searchable([...node.labels, ...Object.values(node.properties)]).includes(search)));
  if (relationshipTypes.size) {
    const endpointIds = new Set(snapshot.relationships.filter((relationship) => relationshipTypes.has(relationship.type)).flatMap((relationship) => [relationship.sourceId, relationship.targetId]));
    nodes = nodes.filter((node) => endpointIds.has(node.id));
  }
  nodes = nodes.slice(0, options.nodeLimit ?? 300);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map(entityFromSnapshot),
    relationships: snapshot.relationships
      .filter((relationship) => nodeIds.has(relationship.sourceId) && nodeIds.has(relationship.targetId) && (!relationshipTypes.size || relationshipTypes.has(relationship.type)))
      .map((relationship) => ({ id: relationship.id, type: relationship.type, source: relationship.sourceId, target: relationship.targetId, properties: relationship.properties })),
  };
}

/** 一个类的属性。**不再有继承**：这一份就是类自己定义的属性（写实例 / 表单 / 唯一值校验共用）。 */
export function classProperties(definition: OntologyDefinition, typeName: string) {
  const type = definition.entityTypes.find((item) => item.name === typeName);
  return type ? type.properties : undefined;
}

export function runtimeTypesFromSnapshot(snapshot: VersionSnapshot): RuntimeTypeSet {
  const labelCounts = new Map(snapshot.definition.entityTypes.map((type) => [type.name, 0]));
  const relationshipCounts = new Map(snapshot.definition.relationshipTypes.map((type) => [type.name, 0]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const relationshipEndpoints: Record<string, { source: string; target: string }> = {};
  const entityTypesById = new Map(snapshot.definition.entityTypes.map((type) => [type.id, type]));
  for (const relationship of snapshot.definition.relationshipTypes) {
    const source = entityTypesById.get(relationship.sourceEntityTypeId)?.name;
    const target = entityTypesById.get(relationship.targetEntityTypeId)?.name;
    if (source && target) relationshipEndpoints[relationship.name] = { source, target };
  }
  for (const node of snapshot.nodes) for (const label of node.labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  for (const relationship of snapshot.relationships) {
    relationshipCounts.set(relationship.type, (relationshipCounts.get(relationship.type) ?? 0) + 1);
    const source = nodes.get(relationship.sourceId)?.labels[0];
    const target = nodes.get(relationship.targetId)?.labels[0];
    if (source && target && !relationshipEndpoints[relationship.type]) relationshipEndpoints[relationship.type] = { source, target };
  }
  return {
    labels: [...labelCounts].map(([name, count]) => ({ name, count, properties: classProperties(snapshot.definition, name) })),
    relationshipTypes: [...relationshipCounts].map(([name, count]) => ({ name, count, properties: snapshot.definition.relationshipTypes.find((type) => type.name === name)?.properties })),
    entityCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
    relationshipEndpoints,
  };
}
