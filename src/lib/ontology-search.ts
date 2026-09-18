import type { Definition } from "@/lib/ontology-draft";

export type OntologySearchHit = {
  kind: "entity" | "relation";
  id: string;
  name: string;
  reason: string;
  propertyName?: string;
  rank: number;
};

/** 搜索建模定义，不过滤画布：搜索只是定位工具，不改变类型与关系的上下文。 */
export function searchOntologyDefinition(definition: Definition, query: string): OntologySearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const hits: OntologySearchHit[] = [];
  const add = (kind: OntologySearchHit["kind"], id: string, name: string, fields: [string, string | undefined][]) => {
    const match = fields.find(([, value]) => value?.toLocaleLowerCase().includes(needle));
    if (!match) return;
    const [reason, value] = match;
    const normalizedName = name.toLocaleLowerCase();
    hits.push({ kind, id, name, reason: reason === "属性" ? `属性 · ${value}` : reason, propertyName: reason === "属性" ? value : undefined, rank: normalizedName === needle ? 0 : normalizedName.startsWith(needle) ? 1 : reason === "对象类型" || reason === "关系类型" ? 2 : 3 });
  };
  for (const entity of definition.entityTypes) {
    add("entity", entity.id, entity.name, [
      ["对象类型", entity.name],
      ...entity.properties.flatMap((property): [string, string | undefined][] => [["属性", property.name], ["属性", property.displayName]]),
    ]);
  }
  for (const relation of definition.relationshipTypes) {
    add("relation", relation.id, relation.name, [
      ["关系类型", relation.name],
      ...relation.properties.flatMap((property): [string, string | undefined][] => [["属性", property.name], ["属性", property.displayName]]),
    ]);
  }
  return hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "zh-CN"));
}
