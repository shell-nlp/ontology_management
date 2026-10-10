import { RDF, RDF_TYPE, BKN_RELATIONSHIP, STRUCTURAL_PREDICATES, SparqlTerm } from "./vocabulary";
import { nodeIdFromTerm, localName, termValue, termIsResource, nodeLabelFromTerm } from "./protocol";
import { pushProperty } from "./replace";
import { dataTypeFromSparqlDatatype, isAutoUniqueCandidate } from "@/lib/framework/graph/schema-inference";
import { type EntityRecord, type GraphNode, type GraphRelationship, type RuntimeProperty } from "@/lib/framework/graph/types";

export function buildRuntimeProperties(rows: { name: string; key: string; count: number; distinctCount: number; maxLength: number; datatype: string | null }[]) {
  const result = new Map<string, RuntimeProperty[]>();
  for (const row of rows) {
    if (!row.name || !row.key) continue;
    if (!result.has(row.name)) result.set(row.name, []);
    result.get(row.name)!.push({
      name: row.key,
      dataType: dataTypeFromSparqlDatatype(row.datatype),
      required: false,
      unique: isAutoUniqueCandidate({ cnt: row.count, distinctCount: row.distinctCount, maxCharacterLength: row.maxLength }),
      indexed: false,
    });
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return result;
}

/** 展示名优先级与前端 entityTitle 保持一致，并补充 RDF 常见的 label / prefLabel。 */
export function displayNameOf(node: EntityRecord, displayProperties?: Record<string, string>) {
  for (const label of node.labels) {
    const property = displayProperties?.[label];
    if (property && node.properties[property] != null) return String(node.properties[property]);
  }
  for (const key of ["name", "名称", "title", "label", "prefLabel", "id"]) {
    const value = node.properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return node.labels[0] ?? node.id;
}

/** 从 SELECT 结果里识别 ?s / ?p / ?o 三元组变量。 */
export function extractTripleRows(vars: string[], rows: Record<string, SparqlTerm>[]) {
  const pick = (candidates: string[]) => vars.find((variable) => candidates.includes(variable.toLowerCase()));
  const subject = pick(["s", "subject", "source"]);
  const predicate = pick(["p", "predicate"]);
  const object = pick(["o", "object", "target"]);
  if (!subject || !predicate || !object || !rows.length) return [];
  return rows
    .filter((row) => row[subject]?.value && row[predicate]?.value && row[object])
    .map((row) => ({ subject: row[subject].value, predicate: row[predicate].value, object: row[object] }));
}

export function graphFromTriples(
  triples: { subject: string; predicate: string; object: SparqlTerm }[],
  options: { hydrate?: (term: string) => GraphNode | undefined; exclude?: (term: string) => boolean } = {},
) {
  const nodes = new Map<string, GraphNode>();
  const relationships: GraphRelationship[] = [];
  const hydratedIds = new Set<string>();
  const ensure = (term: string): GraphNode | null => {
    if (options.exclude?.(term)) return null;
    const id = nodeIdFromTerm(term);
    const existing = nodes.get(id);
    if (existing) return existing;
    const hydrated = options.hydrate?.(term);
    if (hydrated) hydratedIds.add(id);
    const node: GraphNode = hydrated
      ? { id, labels: [...hydrated.labels], properties: { ...hydrated.properties } }
      : { id, labels: [], properties: {} };
    nodes.set(id, node);
    return node;
  };
  for (const triple of triples) {
    const source = ensure(triple.subject);
    if (!source) continue;
    if (triple.predicate === RDF_TYPE) {
      if (triple.object.value === BKN_RELATIONSHIP) continue;
      const label = nodeLabelFromTerm(triple.object);
      if (label && !source.labels.includes(label)) source.labels.push(label);
      continue;
    }
    if (STRUCTURAL_PREDICATES.includes(triple.predicate)) continue;
    const key = localName(triple.predicate);
    if (termIsResource(triple.object)) {
      const target = ensure(triple.object.value);
      if (!target) continue;
      relationships.push({ id: `${triple.subject}|${triple.predicate}|${triple.object.value}`, type: key, source: source.id, target: target.id, properties: {} });
      continue;
    }
    // 已经按主语整体补水过的节点，字面量属性直接以补水结果为准，避免重复值。
    if (hydratedIds.has(source.id)) continue;
    pushProperty(source.properties, key, termValue(triple.object));
  }
  return { nodes: [...nodes.values()], relationships };
}
