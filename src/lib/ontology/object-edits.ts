import type { OntologyDefinition } from "@/lib/ontology";

export type ObjectEdit = { entityTypeId: string; primaryKey: Record<string, string>; base: Record<string, unknown> | null; deleted?: boolean };

/** A source refresh changes untouched fields; only explicit edits override it. */
export function changedProperties(base: Record<string, unknown>, current: Record<string, unknown>) {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (key === "fx" || key === "fy") continue;
    if (JSON.stringify(base[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  return changes;
}

export function overlayObjectProperties(definition: OntologyDefinition, entityTypeId: string, source: Record<string, unknown>, base: Record<string, unknown>, edited: Record<string, unknown>) {
  const names = new Set(definition.entityTypes.find((type) => type.id === entityTypeId)?.properties.map((property) => property.name) ?? []);
  const patch = changedProperties(base, edited);
  return Object.fromEntries(Object.entries({ ...source, ...patch }).filter(([key]) => names.has(key)));
}
