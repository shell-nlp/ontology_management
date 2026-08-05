import { z } from "zod";
import { executeCypher } from "@/lib/neo4j";
import type { Neo4jTarget } from "@/lib/platform-db";

const propertySchema = z.object({
  name: z.string().trim().min(1).max(120),
  dataType: z.enum(["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"]),
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
});

export const ontologyDefinitionSchema = z.object({
  entityTypes: z.array(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), description: z.string().max(500).default(""), properties: z.array(propertySchema).default([]) })).default([]),
  relationshipTypes: z.array(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), sourceEntityTypeId: z.string().uuid(), targetEntityTypeId: z.string().uuid(), properties: z.array(propertySchema).default([]) })).default([]),
});

export type OntologyDefinition = z.infer<typeof ontologyDefinitionSchema>;

type Violation = { rule: string; message: string; count: number };

function quote(identifier: string) {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

function asCount(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "toNumber" in value && typeof value.toNumber === "function") return Number(value.toNumber());
  return Number(value ?? 0);
}

async function count(target: Neo4jTarget, cypher: string) {
  const result = await executeCypher(target, cypher);
  return asCount(result.records[0]?.count);
}

export async function validateOntology(target: Neo4jTarget, input: OntologyDefinition) {
  const violations: Violation[] = [];
  const entitiesById = new Map(input.entityTypes.map((entity) => [entity.id, entity]));
  const duplicateNames = new Set<string>();
  for (const entity of input.entityTypes) {
    if (duplicateNames.has(entity.name)) violations.push({ rule: entity.name, message: "实体类型名称重复。", count: 1 });
    duplicateNames.add(entity.name);
    for (const property of entity.properties) {
      if (!property.required) continue;
      const amount = await count(target, `MATCH (n:${quote(entity.name)}) WHERE n.${quote(property.name)} IS NULL RETURN count(n) AS count`);
      if (amount) violations.push({ rule: `${entity.name}.${property.name}`, message: "存在缺失必填属性的实体实例。", count: amount });
    }
  }
  for (const relationship of input.relationshipTypes) {
    const source = entitiesById.get(relationship.sourceEntityTypeId);
    const targetEntity = entitiesById.get(relationship.targetEntityTypeId);
    if (!source || !targetEntity) {
      violations.push({ rule: relationship.name, message: "关系契约引用了不存在的实体类型。", count: 1 });
      continue;
    }
    const amount = await count(target, `MATCH (source)-[r:${quote(relationship.name)}]->(target) WHERE NOT source:${quote(source.name)} OR NOT target:${quote(targetEntity.name)} RETURN count(r) AS count`);
    if (amount) violations.push({ rule: relationship.name, message: `存在不符合 ${source.name} -> ${targetEntity.name} 端点契约的关系实例。`, count: amount });
    for (const property of relationship.properties.filter((item) => item.required)) {
      const missing = await count(target, `MATCH ()-[r:${quote(relationship.name)}]->() WHERE r.${quote(property.name)} IS NULL RETURN count(r) AS count`);
      if (missing) violations.push({ rule: `${relationship.name}.${property.name}`, message: "存在缺失必填属性的关系实例。", count: missing });
    }
  }
  return violations;
}

function ruleName(kind: string, typeName: string, propertyName: string) {
  return quote(`ontology_${kind}_${typeName}_${propertyName}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 55));
}

export async function supportsExistenceConstraints(target: Neo4jTarget) {
  try {
    const result = await executeCypher(target, "CALL dbms.components() YIELD edition RETURN edition LIMIT 1");
    const edition = result.records[0]?.edition;
    return typeof edition === "string" && edition.toLowerCase().includes("enterprise");
  } catch {
    return false;
  }
}

export async function applyStrongRules(target: Neo4jTarget, input: OntologyDefinition) {
  const canEnforceRequired = await supportsExistenceConstraints(target);
  for (const entity of input.entityTypes) {
    for (const property of entity.properties) {
      const label = quote(entity.name);
      const key = quote(property.name);
      if (property.unique) await executeCypher(target, `CREATE CONSTRAINT ${ruleName("unique", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${key} IS UNIQUE`);
      else if (property.indexed) await executeCypher(target, `CREATE INDEX ${ruleName("index", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) ON (n.${key})`);
      if (property.required && canEnforceRequired) await executeCypher(target, `CREATE CONSTRAINT ${ruleName("required", entity.name, property.name)} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${key} IS NOT NULL`);
    }
  }
}
