import neo4j from "neo4j-driver";
import { executeCypher, type GraphData } from "@/lib/neo4j";
import type { DataType } from "@/lib/instance-property-editor";
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
