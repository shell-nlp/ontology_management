import { createHash } from "node:crypto";
import type { OntologyDefinition } from "@/lib/ontology";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
}
const hash = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

export function materializationStamp(definition: OntologyDefinition, name: string, versionId?: string | null) {
  const entity = definition.entityTypes.find((type) => type.name === name);
  const relation = definition.relationshipTypes.find((type) => type.name === name);
  const ends = relation ? definition.entityTypes.filter((type) => type.id === relation.sourceEntityTypeId || type.id === relation.targetEntityTypeId) : [];
  const resource = entity ?? relation;
  const definitionHash = resource ? hash({ resource, ends }) : "";
  const mappingHash = resource ? hash(entity ? { sources: entity.sources, properties: entity.properties.map(({ name, sourceId, sourceField }) => ({ name, sourceId, sourceField })) } : { relation, ends: ends.map(({ id, sources, properties }) => ({ id, sources, properties })) }) : "";
  return { definitionVersionId: versionId ?? "", definitionHash, mappingHash };
}

export function isMaterializationCurrent(definition: OntologyDefinition, name: string, manifest: { truncated: boolean; definitionHash?: string; mappingHash?: string } | undefined) {
  if (!manifest || manifest.truncated) return false;
  const expected = materializationStamp(definition, name);
  return Boolean(expected.definitionHash && manifest.definitionHash === expected.definitionHash && manifest.mappingHash === expected.mappingHash);
}
