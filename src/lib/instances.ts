import neo4j from "neo4j-driver";
import { executeCypher, type GraphData } from "@/lib/neo4j";
import { getPublishedOntology, quoteCypherIdentifier } from "@/lib/published-ontology";
import { parsePropertyValues, type PropertyDefinition } from "@/lib/instance-property-editor";
import type { Neo4jTarget } from "@/lib/platform-db";

export type RuntimeTypeInfo = { name: string; count: number };
export type RuntimeTypeSet = { labels: RuntimeTypeInfo[]; relationshipTypes: RuntimeTypeInfo[] };

export type EntityRecord = { id: string; labels: string[]; properties: Record<string, unknown> };
export type RelationshipRecord = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown> };

export async function readRuntimeTypes(target: Neo4jTarget): Promise<RuntimeTypeSet> {
  const [labelsResult, relationshipsResult] = await Promise.all([
    executeCypher(target, "MATCH (n) UNWIND labels(n) AS label RETURN label AS name, count(*) AS count ORDER BY count DESC"),
    executeCypher(target, "MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS count ORDER BY count DESC"),
  ]);
  return {
    labels: labelsResult.records.map((row) => ({ name: String(row.name), count: Number(row.count) })),
    relationshipTypes: relationshipsResult.records.map((row) => ({ name: String(row.name), count: Number(row.count) })),
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
  return "RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, properties(r) AS properties";
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
  const labelPart = labels.map(quoteCypherIdentifier).join("");
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
  options: { label?: string | null; search?: string | null; nodeLimit?: number } = {},
): Promise<GraphData> {
  const { label = null, search = null, nodeLimit = 300 } = options;
  const limit = neo4j.int(Number.isFinite(nodeLimit) ? Math.max(0, Math.floor(nodeLimit)) : 300);
  const nodesResult = await executeCypher(
    target,
    `MATCH (n)
     WHERE ($label IS NULL OR $label IN labels(n))
       AND ($search IS NULL OR any(k IN keys(n) WHERE toString(n[k]) CONTAINS $search))
     RETURN n
     LIMIT $limit`,
    { label, search, limit },
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
