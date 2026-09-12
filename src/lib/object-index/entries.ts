import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectIndexEntry } from "@/lib/object-index/types";

/** 快照节点进索引时只看这三项，正好是 VersionSnapshot 里节点的形状。 */
export type IndexableNode = { id: string; labels: string[]; properties: Record<string, unknown> };

/** 合并文本的上限：防止一条超长 JSON 把索引行撑爆。 */
export const MAX_SEARCH_TEXT = 4000;

type ClassMeta = {
  displayProperty: string;
  /** 业务主键的列 -> 属性名映射；列名与属性名相同也接受。 */
  keyMapping: { column: string; property: string }[];
};

function collectClassMeta(definition: OntologyDefinition): Map<string, ClassMeta> {
  const meta = new Map<string, ClassMeta>();
  for (const entity of definition.entityTypes) {
    const columns = entity.sources?.[0]?.primaryKey?.filter((column) => column?.trim()) ?? [];
    const keyMapping = columns.map((column) => {
      const matched = entity.properties.find((property) => property.sourceField?.trim() === column || property.name === column);
      return { column, property: matched?.name ?? "" };
    });
    meta.set(entity.name, {
      displayProperty: entity.displayProperty?.trim() ?? "",
      keyMapping: keyMapping.filter((item) => item.property),
    });
  }
  return meta;
}

function scalarText(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarText);
  // 对象 / 嵌套 JSON 不参与关键词检索：它们没有稳定的分词行为，只会污染命中。
  return [];
}

/**
 * 标题的取法：先按类的展示属性取，再退回 name，再退回任意字符串属性，
 * 最后用对象 id 前 8 位兜底——保证界面上永远有个能看的名字。
 */
export function resolveObjectTitle(node: IndexableNode, meta: Map<string, ClassMeta>): string {
  for (const label of node.labels) {
    const property = meta.get(label)?.displayProperty;
    if (!property) continue;
    const text = scalarText(node.properties[property])[0];
    if (text) return text.slice(0, 200);
  }
  const named = scalarText(node.properties["name"])[0];
  if (named) return named.slice(0, 200);
  for (const value of Object.values(node.properties)) {
    const text = scalarText(value)[0];
    if (text) return text.slice(0, 200);
  }
  return node.id.slice(0, 8);
}

/** 业务主键值：按 sources[0].primaryKey 的列顺序取值，取不到就留空。 */
export function resolvePrimaryKey(node: IndexableNode, meta: Map<string, ClassMeta>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const label of node.labels) {
    const mapping = meta.get(label)?.keyMapping ?? [];
    for (const { column, property } of mapping) {
      if (result[column] !== undefined) continue;
      const text = scalarText(node.properties[property])[0];
      if (text) result[column] = text;
    }
  }
  return result;
}

export function buildSearchText(title: string, properties: Record<string, unknown>) {
  const parts = [title, ...Object.values(properties).flatMap(scalarText)];
  return [...new Set(parts)].join(" ").slice(0, MAX_SEARCH_TEXT);
}

/**
 * 把已发布快照映射成索引条目。纯函数：发布流程与「重建索引」接口共用这一份逻辑，
 * 两边不会各说各话。
 */
export function buildIndexEntries(definition: OntologyDefinition, nodes: readonly IndexableNode[]): ObjectIndexEntry[] {
  const meta = collectClassMeta(definition);
  return nodes.map((node) => {
    const title = resolveObjectTitle(node, meta);
    return {
      objectId: node.id,
      labels: [...node.labels],
      title,
      properties: node.properties,
      primaryKey: resolvePrimaryKey(node, meta),
      searchText: buildSearchText(title, node.properties),
    };
  });
}
