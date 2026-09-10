import neo4j, { type Driver } from "neo4j-driver";
import { decryptSecret } from "@/lib/crypto";
import type { DataType } from "@/lib/instance-property-editor";
import { isAutoUniqueCandidate } from "@/lib/graph/schema-inference";
import { graphTargetKindInfo } from "@/lib/graph/types";
import type {
  ConnectionInfo,
  EntityRecord,
  EntitySearchHit,
  GraphData,
  GraphDefinitionLike,
  GraphExport,
  GraphNode,
  GraphRelationship,
  GraphStore,
  GraphTarget,
  GraphViolation,
  GraphWriteSnapshot,
  ListEntitiesOptions,
  ListRelationshipsOptions,
  QueryResult,
  ReadGraphOptions,
  RelationshipRecord,
  RuntimeProperty,
  RuntimeTypeSet,
  SearchEntitiesOptions,
} from "@/lib/graph/types";

const SNAPSHOT_ID_PROPERTY = "__ontology_id";

export function createNeo4jDriver(target: GraphTarget): Driver {
  return neo4j.driver(target.uri, neo4j.auth.basic(target.username, decryptSecret(target.credential_secret)));
}

const WRITE_CYPHER = /\b(create|merge|delete|detach|set|remove|drop|alter|rename|grant|revoke|load\s+csv|call\s+apoc\.[^\s]+(?:\.import|\.export|\.periodic))\b/i;

export function containsWriteCypher(cypher: string) {
  return WRITE_CYPHER.test(cypher);
}

function quoteIdentifier(identifier: string) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function batches<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function normalizeValue(value: unknown, collect: (value: GraphNode | GraphRelationship) => void): unknown {
  if (neo4j.isInt(value)) return value.inSafeRange() ? value.toNumber() : value.toString();
  if (neo4j.isNode(value)) {
    const node = value as unknown as { elementId: string; labels: string[]; properties: Record<string, unknown> };
    const normalized = { id: node.elementId, labels: node.labels, properties: normalizeValue(node.properties, collect) as Record<string, unknown> } satisfies GraphNode;
    collect(normalized);
    return normalized;
  }
  if (neo4j.isRelationship(value)) {
    const relationship = value as unknown as { elementId: string; type: string; startNodeElementId: string; endNodeElementId: string; properties: Record<string, unknown> };
    const normalized = { id: relationship.elementId, type: relationship.type, source: relationship.startNodeElementId, target: relationship.endNodeElementId, properties: normalizeValue(relationship.properties, collect) as Record<string, unknown> } satisfies GraphRelationship;
    collect(normalized);
    return normalized;
  }
  if (neo4j.isPath(value)) {
    const path = value as unknown as { start: unknown; end: unknown; segments: { start: unknown; relationship: unknown; end: unknown }[] };
    normalizeValue(path.start, collect);
    for (const segment of path.segments) { normalizeValue(segment.start, collect); normalizeValue(segment.relationship, collect); normalizeValue(segment.end, collect); }
    normalizeValue(path.end, collect);
    return { type: "Path", length: path.segments.length };
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, collect));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeValue(nested, collect)]));
  return value;
}

async function runQuery(target: GraphTarget, query: string, parameters: Record<string, unknown> = {}, options: { readOnly?: boolean } = {}): Promise<QueryResult> {
  const driver = createNeo4jDriver(target);
  const session = driver.session({ database: target.database_name });
  try {
    const result = options.readOnly
      ? await session.executeRead((transaction) => transaction.run(query, parameters))
      : await session.run(query, parameters);
    const nodes = new Map<string, GraphNode>();
    const relationships = new Map<string, GraphRelationship>();
    const collect = (value: GraphNode | GraphRelationship) => {
      if ("labels" in value) nodes.set(value.id, value);
      else relationships.set(value.id, value);
    };
    return {
      keys: (result.records[0]?.keys ?? []).map((key) => String(key)),
      records: result.records.map((record) => Object.fromEntries(Object.entries(record.toObject()).map(([key, value]) => [key, normalizeValue(value, collect)])) as Record<string, unknown>),
      graph: { nodes: [...nodes.values()], relationships: [...relationships.values()] } satisfies GraphData,
      summary: result.summary.query.text,
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

export function inferDataTypeFromNeo4jValueType(valueType: unknown): DataType {
  const type = String(valueType).toUpperCase();
  if (type.includes("BOOLEAN")) return "BOOLEAN";
  if (type.includes("INTEGER")) return "INTEGER";
  if (type.includes("FLOAT")) return "DECIMAL";
  if (type.includes("LIST")) return "TEXT_ARRAY";
  if (type.includes("DATETIME")) return "DATETIME";
  if (type.includes("DATE")) return "DATE";
  return "TEXT";
}

export { isAutoUniqueCandidate };

export function cypherPropertyText(value: string) {
  return `CASE WHEN valueType(${value}) STARTS WITH 'LIST<' THEN reduce(text = '', item IN ${value} | text + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') WHEN ${value} IS NULL THEN '' ELSE toString(${value}) END`;
}

/** 把每行 `{name, key, ...}` 聚合成“类型 -> 属性列表”。 */
function buildProperties(rows: { name: string; key: string; cnt: number; distinctCount: number; maxCharacterLength: number; valueType: unknown }[]) {
  const result = new Map<string, RuntimeProperty[]>();
  for (const row of rows) {
    if (!result.has(row.name)) result.set(row.name, []);
    result.get(row.name)!.push({ name: row.key, dataType: inferDataTypeFromNeo4jValueType(row.valueType), required: false, unique: isAutoUniqueCandidate(row), indexed: false });
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return result;
}

function safeText(expr: string) {
  return `CASE WHEN ${expr} IS NULL THEN '' ELSE reduce(s = '', item IN ${expr} | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') END`;
}

function clampedLimit(value: number | undefined, fallback: number, max: number) {
  const numeric = Number.isFinite(value) ? Math.floor(Number(value)) : fallback;
  return neo4j.int(Math.min(max, Math.max(1, numeric)));
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

function ruleNameValue(kind: string, typeName: string, propertyName: string) {
  return `ontology_${kind}_${typeName}_${propertyName}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 55);
}

function ruleName(kind: string, typeName: string, propertyName: string) {
  return quoteIdentifier(ruleNameValue(kind, typeName, propertyName));
}

function asCount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof (value as { toNumber: () => number }).toNumber === "function") return Number((value as { toNumber: () => number }).toNumber());
  return Number(value ?? 0);
}

export function createNeo4jStore(target: GraphTarget): GraphStore {
  const query = (text: string, parameters?: Record<string, unknown>, options?: { readOnly?: boolean }) => runQuery(target, text, parameters, options);

  async function count(cypher: string) {
    const result = await query(cypher);
    return asCount(result.records[0]?.count);
  }

  async function supportsExistenceConstraints() {
    try {
      const result = await query("CALL dbms.components() YIELD edition RETURN edition LIMIT 1");
      const edition = result.records[0]?.edition;
      return typeof edition === "string" && edition.toLowerCase().includes("enterprise");
    } catch {
      return false;
    }
  }

  async function applyStrongRules(definition: GraphDefinitionLike, canEnforceRequired: boolean) {
    for (const entity of definition.entityTypes) {
      for (const property of entity.properties) {
        const label = quoteIdentifier(entity.name);
        const key = quoteIdentifier(property.name);
        if (property.unique) await query(`CREATE CONSTRAINT ${ruleName("unique", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${key} IS UNIQUE`);
        else if (property.indexed) await query(`CREATE INDEX ${ruleName("index", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) ON (n.${key})`);
        if (property.required && canEnforceRequired) await query(`CREATE CONSTRAINT ${ruleName("required", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${key} IS NOT NULL`);
      }
    }
  }

  return {
    kind: "NEO4J",
    target,
    // 连接表单元数据只有一份：来自 @/lib/graph/types 的注册表。
    info: graphTargetKindInfo("NEO4J"),

    async testConnection(): Promise<ConnectionInfo> {
      const driver = createNeo4jDriver(target);
      try {
        const server = await driver.getServerInfo();
        return {
          connected: true,
          kind: "NEO4J",
          address: String(server.address ?? target.uri),
          agent: String(server.agent ?? "Neo4j"),
          protocolVersion: String(server.protocolVersion ?? ""),
          detail: { database: target.database_name },
        };
      } finally {
        await driver.close();
      }
    },

    containsWriteStatement: containsWriteCypher,
    execute: query,
    queryTemplate: () => ({
      defaultQuery: "MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100",
      placeholder: "MATCH (n)-[r]->(m) RETURN n, r, m LIMIT 100",
      visualizationHint: "返回节点、关系或路径即可在画布上可视化。",
    }),

    async readSchemaGraph() {
      return query("CALL db.schema.visualization()");
    },

    async readMeta() {
      const [labelsResult, relationshipsResult, keysResult] = await Promise.all([
        query("CALL db.labels() YIELD label RETURN label ORDER BY label"),
        query("CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType"),
        query("CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey"),
      ]);
      return {
        labels: labelsResult.records.map((row) => String(row.label)),
        relationshipTypes: relationshipsResult.records.map((row) => String(row.relationshipType)),
        propertyKeys: keysResult.records.map((row) => String(row.propertyKey)),
      };
    },

    async readRuntimeTypes(): Promise<RuntimeTypeSet> {
      const valueText = cypherPropertyText("value");
      const [labelsResult, relationshipsResult, countsResult, endpointsResult, labelPropsResult, relationshipPropsResult] = await Promise.all([
        query("MATCH (n) UNWIND labels(n) AS label RETURN label AS name, count(*) AS count ORDER BY count DESC"),
        query("MATCH ()-[r]->() RETURN type(r) AS name, count(*) AS count ORDER BY count DESC"),
        query("MATCH (n) WITH count(n) AS nodes OPTIONAL MATCH ()-[r]->() RETURN nodes AS nodeCount, count(r) AS relationshipCount"),
        query("MATCH (source)-[r]->(target) WHERE labels(source)[0] IS NOT NULL AND labels(target)[0] IS NOT NULL WITH type(r) AS relType, labels(source)[0] AS sourceLabel, labels(target)[0] AS targetLabel, count(*) AS count RETURN relType, sourceLabel, targetLabel, count ORDER BY relType, count DESC"),
        query(`MATCH (n) UNWIND labels(n) AS label WITH label, n UNWIND keys(n) AS key WITH label, key, n[key] AS value WITH label, key, count(*) AS cnt, count(DISTINCT value) AS distinctCount, max(size(${valueText})) AS maxCharacterLength, min(valueType(value)) AS valueType RETURN label AS name, key, cnt, distinctCount, maxCharacterLength, valueType`),
        query(`MATCH ()-[r]->() WITH type(r) AS relType, r UNWIND keys(r) AS key WITH relType, key, r[key] AS value WITH relType, key, count(*) AS cnt, count(DISTINCT value) AS distinctCount, max(size(${valueText})) AS maxCharacterLength, min(valueType(value)) AS valueType RETURN relType AS name, key, cnt, distinctCount, maxCharacterLength, valueType`),
      ]);
      const relationshipEndpoints: Record<string, { source: string; target: string }> = {};
      for (const row of endpointsResult.records) {
        const name = String(row.relType);
        if (name && !relationshipEndpoints[name]) relationshipEndpoints[name] = { source: String(row.sourceLabel), target: String(row.targetLabel) };
      }
      const labelProps = buildProperties(labelPropsResult.records.map((row) => ({ name: String(row.name), key: String(row.key), cnt: Number(row.cnt), distinctCount: Number(row.distinctCount), maxCharacterLength: Number(row.maxCharacterLength), valueType: row.valueType })));
      const relationshipProps = buildProperties(relationshipPropsResult.records.map((row) => ({ name: String(row.name), key: String(row.key), cnt: Number(row.cnt), distinctCount: Number(row.distinctCount), maxCharacterLength: Number(row.maxCharacterLength), valueType: row.valueType })));
      return {
        labels: labelsResult.records.map((row) => { const name = String(row.name); return { name, count: Number(row.count), properties: labelProps.get(name) }; }),
        relationshipTypes: relationshipsResult.records.map((row) => { const name = String(row.name); return { name, count: Number(row.count), properties: relationshipProps.get(name) }; }),
        entityCount: Number(countsResult.records[0]?.nodeCount ?? 0),
        relationshipCount: Number(countsResult.records[0]?.relationshipCount ?? 0),
        relationshipEndpoints,
      };
    },

    async readGraph(options: ReadGraphOptions = {}): Promise<GraphData> {
      const { label = null, labels = [], relationshipTypes = [], search = null, nodeLimit = 300 } = options;
      const limit = clampedLimit(nodeLimit, 300, 100000);
      const selectedLabels = [...new Set([...(label ? [label] : []), ...labels])];
      const selectedRelationshipTypes = [...new Set(relationshipTypes)];
      if (selectedRelationshipTypes.length) {
        const result = await query(
          `MATCH (source)-[r]->(target)
           WHERE type(r) IN $relationshipTypes
             AND ($labels = [] OR any(label IN labels(source) WHERE label IN $labels) OR any(label IN labels(target) WHERE label IN $labels))
             AND ($search IS NULL OR any(k IN keys(source) WHERE toLower(${safeText("source[k]")}) CONTAINS toLower($search)) OR any(k IN keys(target) WHERE toLower(${safeText("target[k]")}) CONTAINS toLower($search)))
           RETURN source, r, target
           LIMIT $limit`,
          { relationshipTypes: selectedRelationshipTypes, labels: selectedLabels, search, limit },
        );
        return result.graph;
      }
      const nodesResult = await query(
        `MATCH (n)
         WHERE ($labels = [] OR any(label IN labels(n) WHERE label IN $labels))
           AND ($search IS NULL OR any(k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($search)))
         RETURN n
         LIMIT $limit`,
        { labels: selectedLabels, search, limit },
      );
      const nodes = nodesResult.graph.nodes;
      const ids = nodes.map((node) => node.id);
      if (!ids.length) return { nodes: [], relationships: [] };
      const relationshipsResult = await query("MATCH (n)-[r]->(m) WHERE elementId(n) IN $ids AND elementId(m) IN $ids RETURN r", { ids });
      return { nodes, relationships: relationshipsResult.graph.relationships };
    },

    async readNeighborhood(id: string, limit: number): Promise<GraphData> {
      const result = await runQuery(
        target,
        `MATCH (focus) WHERE elementId(focus) = $nodeId
         OPTIONAL MATCH (focus)-[relationship]-(neighbor)
         RETURN focus, relationship, neighbor LIMIT $limit`,
        { nodeId: id, limit: clampedLimit(limit, 200, 10000) },
      );
      return result.graph;
    },

    async listEntities(options: ListEntitiesOptions = {}): Promise<EntityRecord[]> {
      const { label = null, labels = [], search = null, limit = 200, displayProperties = {} } = options;
      const selectedLabels = [...new Set([...(label ? [label] : []), ...labels])];
      const hasDisplayProperty = "any(label IN labels(n) WHERE label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL)";
      const displayMatch = `any(label IN labels(n) WHERE label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL AND toLower(${safeText("n[$displayProps[label]]")}) CONTAINS toLower($search))`;
      const genericMatch = `any(k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($search))`;
      const result = await query(
        `MATCH (n)
         WHERE ($labels = [] OR any(label IN labels(n) WHERE label IN $labels))
           AND ($search IS NULL OR ${displayMatch} OR (NOT ${hasDisplayProperty} AND ${genericMatch}))
         RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties
         ORDER BY id LIMIT $limit`,
        { labels: selectedLabels, search, displayProps: displayProperties, limit: clampedLimit(limit, 200, 10000) },
      );
      return result.records as unknown as EntityRecord[];
    },

    async readEntity(id: string): Promise<EntityRecord | null> {
      const result = await query(
        "MATCH (n) WHERE elementId(n) = $elementId RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties",
        { elementId: id },
      );
      return (result.records[0] as unknown as EntityRecord | undefined) ?? null;
    },

    async searchEntities(options: SearchEntitiesOptions): Promise<EntitySearchHit[]> {
      const { search, labels = [], limit = 12, displayProperties = {} } = options;
      const labelClause = labels.length > 0 ? "AND any(l IN $labels WHERE l IN labels(n))\n           " : "";
      const displayName = `reduce(d = '', label IN labels(n) | CASE WHEN d <> '' THEN d WHEN label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL THEN ${safeText("n[$displayProps[label]]")} ELSE d END)`;
      const valueMatch = `any(k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($q))`;
      const result = await query(
        `MATCH (n)
           WHERE ${valueMatch}
           ${labelClause}WITH n, [k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($q) | k] AS matched, ${displayName} AS displayName
           RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties, matched,
                  CASE WHEN toLower(displayName) = toLower($q) THEN 0
                       WHEN toLower(displayName) STARTS WITH toLower($q) THEN 1
                       WHEN any(k IN matched WHERE toLower(${safeText("n[k]")}) = toLower($q)) THEN 2
                       WHEN toLower(displayName) CONTAINS toLower($q) THEN 3
                       WHEN any(k IN matched WHERE toLower(${safeText("n[k]")}) STARTS WITH toLower($q)) THEN 4
                       ELSE 5 END AS rank
           ORDER BY rank, size(matched) DESC, id
           LIMIT $limit`,
        { q: search, labels, displayProps: displayProperties, limit: clampedLimit(limit, 12, 30) },
      );
      return result.records as unknown as EntitySearchHit[];
    },

    async listRelationships(options: ListRelationshipsOptions = {}): Promise<RelationshipRecord[]> {
      const { type = null, search = null, limit = 200 } = options;
      const relMatch = `any(k IN keys(r) WHERE toLower(${safeText("r[k]")}) CONTAINS toLower($search))`;
      const nodeMatch = `any(k IN keys(source) WHERE toLower(${safeText("source[k]")}) CONTAINS toLower($search)) OR any(k IN keys(target) WHERE toLower(${safeText("target[k]")}) CONTAINS toLower($search))`;
      const result = await query(
        `MATCH (source)-[r]->(target)
         WHERE ($type IS NULL OR type(r) = $type)
           AND ($search IS NULL OR ${relMatch} OR ${nodeMatch})
         RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, labels(source) AS sourceLabels, properties(source) AS sourceProperties, labels(target) AS targetLabels, properties(target) AS targetProperties, properties(r) AS properties
         ORDER BY id LIMIT $limit`,
        { type, search, limit: clampedLimit(limit, 200, 10000) },
      );
      return result.records as unknown as RelationshipRecord[];
    },

    async exportGraph(): Promise<GraphExport> {
      const [nodeResult, relationshipResult] = await Promise.all([
        query("MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties"),
        query(`MATCH (source)-[r]->(target)
               RETURN elementId(r) AS id, elementId(source) AS sourceId, elementId(target) AS targetId, type(r) AS type, properties(r) AS properties`),
      ]);
      return {
        nodes: nodeResult.records.map((record) => ({
          id: String(record.id),
          labels: (record.labels as string[]) ?? [],
          properties: (record.properties as Record<string, unknown>) ?? {},
        })),
        relationships: relationshipResult.records.map((record) => ({
          id: String(record.id),
          sourceId: String(record.sourceId),
          targetId: String(record.targetId),
          type: String(record.type),
          properties: (record.properties as Record<string, unknown>) ?? {},
        })),
      };
    },

    async replaceGraph(snapshot: GraphWriteSnapshot, batchSize = 1000) {
      if (batchSize <= 0) throw new Error("发布批次大小必须大于 0。");
      const driver = createNeo4jDriver(target);
      const session = driver.session({ database: target.database_name });
      try {
        await session.executeWrite(async (transaction) => {
          await transaction.run("MATCH (n) DETACH DELETE n");
          const entityJsonProperties = new Map(snapshot.definition.entityTypes.map((type) => [type.name, new Set(type.properties.filter((property) => property.dataType === "JSON").map((property) => property.name))]));
          const relationshipJsonProperties = new Map(snapshot.definition.relationshipTypes.map((type) => [type.name, new Set(type.properties.filter((property) => property.dataType === "JSON").map((property) => property.name))]));
          const nodeGroups = new Map<string, GraphWriteSnapshot["nodes"]>();
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
          const relationshipGroups = new Map<string, GraphWriteSnapshot["relationships"]>();
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
    },

    async validateDefinition(definition: GraphDefinitionLike): Promise<GraphViolation[]> {
      const violations: GraphViolation[] = [];
      const entityNameById = new Map(definition.entityTypes.filter((entity) => entity.id).map((entity) => [entity.id as string, entity.name]));
      for (const entity of definition.entityTypes) {
        for (const property of entity.properties) {
          if (!property.required) continue;
          const amount = await count(`MATCH (n:${quoteIdentifier(entity.name)}) WHERE n.${quoteIdentifier(property.name)} IS NULL RETURN count(n) AS count`);
          if (amount) violations.push({ rule: `${entity.name}.${property.name}`, message: "存在缺失必填属性的实体实例。", count: amount });
        }
      }
      for (const relationship of definition.relationshipTypes) {
        const source = relationship.sourceEntityTypeId ? entityNameById.get(relationship.sourceEntityTypeId) : undefined;
        const targetType = relationship.targetEntityTypeId ? entityNameById.get(relationship.targetEntityTypeId) : undefined;
        if (source && targetType) {
          const amount = await count(
            `MATCH (source)-[r:${quoteIdentifier(relationship.name)}]->(target)
             WHERE NOT source:${quoteIdentifier(source)} OR NOT target:${quoteIdentifier(targetType)}
             RETURN count(r) AS count`,
          );
          if (amount) violations.push({ rule: relationship.name, message: `存在不符合 ${source} -> ${targetType} 端点契约的关系实例。`, count: amount });
        }
        for (const property of relationship.properties.filter((item) => item.required)) {
          const missing = await count(`MATCH ()-[r:${quoteIdentifier(relationship.name)}]->() WHERE r.${quoteIdentifier(property.name)} IS NULL RETURN count(r) AS count`);
          if (missing) violations.push({ rule: `${relationship.name}.${property.name}`, message: "存在缺失必填属性的关系实例。", count: missing });
        }
      }
      return violations;
    },

    async reconcileStrongRules(definition: GraphDefinitionLike) {
      const canEnforceRequired = await supportsExistenceConstraints();
      const desiredConstraints = new Set<string>();
      const desiredIndexes = new Set<string>();
      for (const entity of definition.entityTypes) {
        for (const property of entity.properties) {
          if (property.unique) desiredConstraints.add(ruleNameValue("unique", entity.name, property.name));
          else if (property.indexed) desiredIndexes.add(ruleNameValue("index", entity.name, property.name));
          if (property.required && canEnforceRequired) desiredConstraints.add(ruleNameValue("required", entity.name, property.name));
        }
      }
      const constraints = await query("SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH 'ontology_' RETURN name");
      for (const row of constraints.records) {
        const name = String(row.name);
        if (!desiredConstraints.has(name)) await query(`DROP CONSTRAINT ${quoteIdentifier(name)} IF EXISTS`);
      }
      const indexes = await query("SHOW INDEXES YIELD name WHERE name STARTS WITH 'ontology_' RETURN name");
      for (const row of indexes.records) {
        const name = String(row.name);
        if (!desiredIndexes.has(name) && !desiredConstraints.has(name)) await query(`DROP INDEX ${quoteIdentifier(name)} IF EXISTS`);
      }
      await applyStrongRules(definition, canEnforceRequired);
      return { enforced: canEnforceRequired };
    },
  };
}
