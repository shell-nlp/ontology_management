import neo4j, { type Driver } from "neo4j-driver";
import { decryptSecret } from "@/lib/crypto";
import type { Neo4jTarget } from "@/lib/platform-db";
import type { VersionSnapshot } from "@/lib/version-snapshot";

const SNAPSHOT_ID_PROPERTY = "__ontology_id";

export type GraphNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GraphRelationship = { id: string; type: string; source: string; target: string; properties: Record<string, unknown> };
export type GraphData = { nodes: GraphNode[]; relationships: GraphRelationship[] };

export function createTargetDriver(target: Neo4jTarget): Driver {
  return neo4j.driver(target.uri, neo4j.auth.basic(target.username, decryptSecret(target.credential_secret)));
}

export function containsWriteCypher(cypher: string) {
  return /\b(create|merge|delete|detach|set|remove|drop|alter|rename|grant|revoke|load\s+csv|call\s+apoc\.[^\s]+(?:\.import|\.export|\.periodic))\b/i.test(cypher);
}

export async function executeCypher(target: Neo4jTarget, cypher: string, parameters: Record<string, unknown> = {}, options: { readOnly?: boolean } = {}) {
  const driver = createTargetDriver(target);
  const session = driver.session({ database: target.database_name });
  try {
    const result = options.readOnly
      ? await session.executeRead((transaction) => transaction.run(cypher, parameters))
      : await session.run(cypher, parameters);
    const nodes = new Map<string, GraphNode>();
    const relationships = new Map<string, GraphRelationship>();
    const normalize = (value: unknown): unknown => {
      if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
      if (neo4j.isNode(value)) {
        const node = value as unknown as { elementId: string; labels: string[]; properties: Record<string, unknown> };
        const normalized: GraphNode = { id: node.elementId, labels: node.labels, properties: normalize(node.properties) as Record<string, unknown> };
        nodes.set(normalized.id, normalized);
        return normalized;
      }
      if (neo4j.isRelationship(value)) {
        const relationship = value as unknown as { elementId: string; type: string; startNodeElementId: string; endNodeElementId: string; properties: Record<string, unknown> };
        const normalized: GraphRelationship = { id: relationship.elementId, type: relationship.type, source: relationship.startNodeElementId, target: relationship.endNodeElementId, properties: normalize(relationship.properties) as Record<string, unknown> };
        relationships.set(normalized.id, normalized);
        return normalized;
      }
      if (neo4j.isPath(value)) {
        const path = value as unknown as { start: unknown; end: unknown; segments: { start: unknown; relationship: unknown; end: unknown }[] };
        normalize(path.start);
        for (const segment of path.segments) { normalize(segment.start); normalize(segment.relationship); normalize(segment.end); }
        normalize(path.end);
        return { type: "Path", length: path.segments.length };
      }
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalize(nested)]));
      return value;
    };
    return {
      keys: result.records[0]?.keys ?? [],
      records: result.records.map((record) => normalize(record.toObject()) as Record<string, unknown>),
      graph: { nodes: [...nodes.values()], relationships: [...relationships.values()] } satisfies GraphData,
      summary: result.summary.query.text,
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

function quoteIdentifier(identifier: string) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function batches<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function neo4jCompatibleProperties(properties: Record<string, unknown>, jsonProperties: Set<string>) {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => {
    if (value === null || value === undefined) return [key, null];
    if (jsonProperties.has(key)) return [key, typeof value === "string" ? value : JSON.stringify(value)];
    if (Array.isArray(value)) return [key, value.every((item) => ["string", "number", "boolean"].includes(typeof item)) ? value : JSON.stringify(value)];
    if (typeof value === "object") return [key, JSON.stringify(value)];
    return [key, value];
  }));
}

export async function replaceGraphWithSnapshot(target: Neo4jTarget, _versionId: string, snapshot: VersionSnapshot, batchSize = 1000) {
  if (batchSize <= 0) throw new Error("发布批次大小必须大于 0。");
  const driver = createTargetDriver(target);
  const session = driver.session({ database: target.database_name });
  try {
    await session.executeWrite(async (transaction) => {
      await transaction.run("MATCH (n) DETACH DELETE n");
      const entityJsonProperties = new Map(snapshot.definition.entityTypes.map((type) => [type.name, new Set(type.properties.filter((property) => property.dataType === "JSON").map((property) => property.name))]));
      const relationshipJsonProperties = new Map(snapshot.definition.relationshipTypes.map((type) => [type.name, new Set(type.properties.filter((property) => property.dataType === "JSON").map((property) => property.name))]));
      const nodeGroups = new Map<string, typeof snapshot.nodes>();
      for (const node of snapshot.nodes) {
        const key = JSON.stringify([...node.labels].sort());
        const group = nodeGroups.get(key) ?? [];
        group.push(node);
        nodeGroups.set(key, group);
      }
      for (const [key, group] of nodeGroups) {
        const labels = (JSON.parse(key) as string[]).map(quoteIdentifier).join(":");
        for (const rows of batches(group, batchSize)) {
          const jsonProperties = entityJsonProperties.get(rows[0]?.labels[0] ?? "") ?? new Set<string>();
          await transaction.run(
            `UNWIND $rows AS row CREATE (n:${labels}) SET n = row.properties
             SET n.${quoteIdentifier(SNAPSHOT_ID_PROPERTY)} = row.id`,
            { rows: rows.map((row) => ({ ...row, properties: neo4jCompatibleProperties(row.properties, jsonProperties) })) },
          );
        }
      }
      const relationshipGroups = new Map<string, typeof snapshot.relationships>();
      for (const relationship of snapshot.relationships) {
        const group = relationshipGroups.get(relationship.type) ?? [];
        group.push(relationship);
        relationshipGroups.set(relationship.type, group);
      }
      for (const [type, group] of relationshipGroups) {
        for (const rows of batches(group, batchSize)) {
          const jsonProperties = relationshipJsonProperties.get(type) ?? new Set<string>();
          await transaction.run(
            `UNWIND $rows AS row
             MATCH (source {${quoteIdentifier(SNAPSHOT_ID_PROPERTY)}: row.sourceId}),
                   (target {${quoteIdentifier(SNAPSHOT_ID_PROPERTY)}: row.targetId})
             CREATE (source)-[r:${quoteIdentifier(type)}]->(target) SET r = row.properties`,
            { rows: rows.map((row) => ({ ...row, properties: neo4jCompatibleProperties(row.properties, jsonProperties) })) },
          );
        }
      }
      await transaction.run(`MATCH (n) REMOVE n.${quoteIdentifier(SNAPSHOT_ID_PROPERTY)}`);
    });
  } finally {
    await session.close();
    await driver.close();
  }
}
