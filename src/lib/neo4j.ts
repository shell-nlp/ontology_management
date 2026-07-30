import neo4j, { type Driver } from "neo4j-driver";
import { decryptSecret } from "@/lib/crypto";
import type { Neo4jTarget } from "@/lib/platform-db";

export type GraphNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GraphRelationship = { id: string; type: string; source: string; target: string; properties: Record<string, unknown> };
export type GraphData = { nodes: GraphNode[]; relationships: GraphRelationship[] };

export function createTargetDriver(target: Neo4jTarget): Driver {
  return neo4j.driver(target.uri, neo4j.auth.basic(target.username, decryptSecret(target.credential_secret)));
}

export function containsWriteCypher(cypher: string) {
  return /\b(create|merge|delete|detach|set|remove|drop|alter|rename|grant|revoke|load\s+csv|call\s+apoc\.[^\s]+(?:\.import|\.export|\.periodic))\b/i.test(cypher);
}

export async function executeCypher(target: Neo4jTarget, cypher: string, parameters: Record<string, unknown> = {}) {
  const driver = createTargetDriver(target);
  const session = driver.session({ database: target.database_name });
  try {
    const result = await session.run(cypher, parameters);
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
