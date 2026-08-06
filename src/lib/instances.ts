import neo4j from "neo4j-driver";
import { executeCypher, type GraphData } from "@/lib/neo4j";
import { getPublishedOntology, quoteCypherIdentifier } from "@/lib/published-ontology";
import { parsePropertyValues, type DataType, type PropertyDefinition } from "@/lib/instance-property-editor";
import type { Neo4jTarget } from "@/lib/platform-db";

export type RuntimeProperty = { name: string; dataType: DataType; required: boolean; unique: boolean; indexed: boolean };
export type RuntimeTypeInfo = { name: string; count: number; properties?: RuntimeProperty[] };
export type RuntimeTypeSet = { labels: RuntimeTypeInfo[]; relationshipTypes: RuntimeTypeInfo[]; entityCount: number; relationshipCount: number; relationshipEndpoints?: Record<string, { source: string; target: string }> };

function inferDataType(sample: unknown): DataType {
  if (typeof sample === "boolean") return "BOOLEAN";
  if (typeof sample === "number") return Number.isInteger(sample) ? "INTEGER" : "DECIMAL";
  if (Array.isArray(sample)) return "TEXT_ARRAY";
  if (sample && typeof sample === "object") {
    const record = sample as Record<string, unknown>;
    if (typeof record.year === "number" && typeof record.month === "number" && typeof record.day === "number") return "hour" in record ? "DATETIME" : "DATE";
    return "JSON";
  }
  return "TEXT";
}

function buildProperties(rows: { name: string; key: string; cnt: number; distinctCount: number; sample: unknown }[]): Map<string, RuntimeProperty[]> {
  const result = new Map<string, RuntimeProperty[]>();
  for (const row of rows) {
    if (!result.has(row.name)) result.set(row.name, []);
    result.get(row.name)!.push({ name: row.key, dataType: inferDataType(row.sample), required: false, unique: row.cnt > 1 && row.distinctCount === row.cnt, indexed: false });
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return result;
}

export type EntityRecord = { id: string; labels: string[]; properties: Record<string, unknown> };
export type RelationshipRecord = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; sourceLabels?: string[]; sourceProperties?: Record<string, unknown>; targetLabels?: string[]; targetProperties?: Record<string, unknown> };

export async function readRuntimeTypes(target: Neo4jTarget): Promise<RuntimeTypeSet> {
  const [labelsResult, relationshipsResult, countsResult, endpointsResult, labelPropsResult, relationshipPropsResult] = await Promise.all([
    executeCypher(target, "MATCH (n) UNWIND labels(n) AS label RETURN label AS name, count(*) AS count ORDER BY count DESC"),
    executeCypher(target, "MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS count ORDER BY count DESC"),
    executeCypher(target, "MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes AS nodeCount, count(r) AS relationshipCount"),
    executeCypher(target, "MATCH (source)-[r]->(target) WHERE labels(source)[0] IS NOT NULL AND labels(target)[0] IS NOT NULL WITH type(r) AS relType, labels(source)[0] AS sourceLabel, labels(target)[0] AS targetLabel, count(*) AS count RETURN relType, sourceLabel, targetLabel, count ORDER BY relType, count DESC"),
    executeCypher(target, "MATCH (n) UNWIND labels(n) AS label WITH label, n UNWIND keys(n) AS key WITH label, key, n[key] AS value WITH label, key, count(*) AS cnt, count(DISTINCT value) AS distinctCount, collect(value)[0] AS sample RETURN label AS name, key, cnt, distinctCount, sample"),
    executeCypher(target, "MATCH ()-[r]->() WITH type(r) AS relType, r UNWIND keys(r) AS key WITH relType, key, r[key] AS value WITH relType, key, count(*) AS cnt, count(DISTINCT value) AS distinctCount, collect(value)[0] AS sample RETURN relType AS name, key, cnt, distinctCount, sample"),
  ]);
  const relationshipEndpoints: Record<string, { source: string; target: string }> = {};
  for (const row of endpointsResult.records) {
    const name = String(row.relType);
    if (name && !relationshipEndpoints[name]) relationshipEndpoints[name] = { source: String(row.sourceLabel), target: String(row.targetLabel) };
  }
  const labelProps = buildProperties(labelPropsResult.records.map((row) => ({ name: String(row.name), key: String(row.key), cnt: Number(row.cnt), distinctCount: Number(row.distinctCount), sample: row.sample })));
  const relationshipProps = buildProperties(relationshipPropsResult.records.map((row) => ({ name: String(row.name), key: String(row.key), cnt: Number(row.cnt), distinctCount: Number(row.distinctCount), sample: row.sample })));
  return {
    labels: labelsResult.records.map((row) => { const name = String(row.name); return { name, count: Number(row.count), properties: labelProps.get(name) }; }),
    relationshipTypes: relationshipsResult.records.map((row) => { const name = String(row.name); return { name, count: Number(row.count), properties: relationshipProps.get(name) }; }),
    entityCount: Number(countsResult.records[0]?.nodeCount ?? 0),
    relationshipCount: Number(countsResult.records[0]?.relationshipCount ?? 0),
    relationshipEndpoints,
  };
}

export async function getEntityDefinitions(target: Neo4jTarget, labels: string[]): Promise<PropertyDefinition[] | null> {
  try {
    const ontology = await getPublishedOntology(target.id);
    const type = ontology.entityTypes.find((item) => labels.includes(item.name));
    return type ? type.properties : null;
  } catch {
    return null;
  }
}

export async function getRelationshipDefinitions(target: Neo4jTarget, typeName: string): Promise<PropertyDefinition[] | null> {
  try {
    const ontology = await getPublishedOntology(target.id);
    const type = ontology.relationshipTypes.find((item) => item.name === typeName);
    return type ? type.properties : null;
  } catch {
    return null;
  }
}

function entityReturn() {
  return "RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties";
}

function relationshipReturn() {
  return "RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, labels(source) AS sourceLabels, properties(source) AS sourceProperties, labels(target) AS targetLabels, properties(target) AS targetProperties, properties(r) AS properties";
}

export async function readEntity(target: Neo4jTarget, elementId: string): Promise<EntityRecord | null> {
  const result = await executeCypher(target, `MATCH (n) WHERE elementId(n) = $elementId ${entityReturn()}`, { elementId });
  return (result.records[0] as EntityRecord | undefined) ?? null;
}

export async function readRelationship(target: Neo4jTarget, elementId: string): Promise<RelationshipRecord | null> {
  const result = await executeCypher(target, `MATCH (source)-[r]->(target) WHERE elementId(r) = $elementId ${relationshipReturn()}`, { elementId });
  return (result.records[0] as RelationshipRecord | undefined) ?? null;
}

export async function createEntity(target: Neo4jTarget, labels: string[], rawProperties: Record<string, unknown>) {
  const definitions = await getEntityDefinitions(target, labels);
  const properties = definitions
    ? parsePropertyValues(definitions, rawProperties)
    : parsePropertyValues([], rawProperties, { allowArbitrary: true });
  const labelPart = labels.map((label) => `:${quoteCypherIdentifier(label)}`).join("");
  const result = await executeCypher(target, `CREATE (n${labelPart}) SET n += $properties ${entityReturn()}`, { properties });
  return result.records[0] ?? null;
}

export async function createRelationship(
  target: Neo4jTarget,
  type: string,
  sourceId: string,
  targetId: string,
  rawProperties: Record<string, unknown>,
) {
  const definitions = await getRelationshipDefinitions(target, type);
  const properties = definitions
    ? parsePropertyValues(definitions, rawProperties)
    : parsePropertyValues([], rawProperties, { allowArbitrary: true });
  const result = await executeCypher(
    target,
    `MATCH (source), (target) WHERE elementId(source) = $sourceId AND elementId(target) = $targetId
     CREATE (source)-[r:${quoteCypherIdentifier(type)}]->(target) SET r += $properties ${relationshipReturn()}`,
    { sourceId, targetId, properties },
  );
  return result.records[0] ?? null;
}

export async function updateEntityProperties(target: Neo4jTarget, elementId: string, rawProperties: Record<string, unknown>) {
  const current = await readEntity(target, elementId);
  if (!current) return null;
  const definitions = await getEntityDefinitions(target, current.labels);
  const properties = definitions
    ? parsePropertyValues(definitions, rawProperties)
    : parsePropertyValues([], rawProperties, { allowArbitrary: true });
  const result = await executeCypher(target, `MATCH (n) WHERE elementId(n) = $elementId SET n += $properties ${entityReturn()}`, { elementId, properties });
  return result.records[0] ?? null;
}

export async function updateRelationshipProperties(target: Neo4jTarget, elementId: string, rawProperties: Record<string, unknown>) {
  const current = await readRelationship(target, elementId);
  if (!current) return null;
  const definitions = await getRelationshipDefinitions(target, current.type);
  const properties = definitions
    ? parsePropertyValues(definitions, rawProperties)
    : parsePropertyValues([], rawProperties, { allowArbitrary: true });
  const result = await executeCypher(target, `MATCH (source)-[r]->(target) WHERE elementId(r) = $elementId SET r += $properties ${relationshipReturn()}`, { elementId, properties });
  return result.records[0] ?? null;
}

export async function deleteEntity(target: Neo4jTarget, elementId: string) {
  await executeCypher(target, "MATCH (n) WHERE elementId(n) = $elementId DETACH DELETE n", { elementId });
}

export async function deleteRelationship(target: Neo4jTarget, elementId: string) {
  await executeCypher(target, "MATCH ()-[r]->() WHERE elementId(r) = $elementId DELETE r", { elementId });
}

export async function updateNodePositions(target: Neo4jTarget, items: { elementId: string; x: number; y: number }[]) {
  if (!items.length) return 0;
  const result = await executeCypher(
    target,
    "UNWIND $items AS item MATCH (n) WHERE elementId(n) = item.elementId SET n.fx = item.x, n.fy = item.y",
    { items },
  );
  return result.records.length;
}

export async function readGraph(
  target: Neo4jTarget,
  options: { label?: string | null; labels?: string[]; relationshipTypes?: string[]; search?: string | null; nodeLimit?: number } = {},
): Promise<GraphData> {
  const { label = null, labels = [], relationshipTypes = [], search = null, nodeLimit = 300 } = options;
  const limit = neo4j.int(Number.isFinite(nodeLimit) ? Math.max(0, Math.floor(nodeLimit)) : 300);
  const selectedLabels = [...new Set([...(label ? [label] : []), ...labels])];
  const selectedRelationshipTypes = [...new Set(relationshipTypes)];
  if (selectedRelationshipTypes.length) {
    const result = await executeCypher(
      target,
      `MATCH (source)-[r]->(target)
       WHERE type(r) IN $relationshipTypes
         AND ($labels = [] OR any(label IN labels(source) WHERE label IN $labels) OR any(label IN labels(target) WHERE label IN $labels))
         AND ($search IS NULL OR any(k IN keys(source) WHERE toLower(CASE WHEN source[k] IS LIST THEN reduce(s = '', item IN source[k] | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') WHEN source[k] IS NULL THEN '' ELSE toString(source[k]) END) CONTAINS toLower($search)) OR any(k IN keys(target) WHERE toLower(CASE WHEN target[k] IS LIST THEN reduce(s = '', item IN target[k] | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') WHEN target[k] IS NULL THEN '' ELSE toString(target[k]) END) CONTAINS toLower($search)))
       RETURN source, r, target
       LIMIT $limit`,
      { relationshipTypes: selectedRelationshipTypes, labels: selectedLabels, search, limit },
    );
    return result.graph;
  }
  const nodesResult = await executeCypher(
    target,
    `MATCH (n)
     WHERE ($labels = [] OR any(label IN labels(n) WHERE label IN $labels))
       AND ($search IS NULL OR any(k IN keys(n) WHERE toLower(CASE WHEN n[k] IS LIST THEN reduce(s = '', item IN n[k] | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') WHEN n[k] IS NULL THEN '' ELSE toString(n[k]) END) CONTAINS toLower($search)))
     RETURN n
     LIMIT $limit`,
    { labels: selectedLabels, search, limit },
  );
  const nodes = nodesResult.graph.nodes;
  const ids = nodes.map((node) => node.id);
  if (!ids.length) return { nodes: [], relationships: [] };
  const relationshipsResult = await executeCypher(
    target,
    `MATCH (n)-[r]->(m) WHERE elementId(n) IN $ids AND elementId(m) IN $ids RETURN r`,
    { ids },
  );
  return { nodes, relationships: relationshipsResult.graph.relationships };
}
