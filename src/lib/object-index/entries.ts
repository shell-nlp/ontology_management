import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectIndexEntry } from "@/lib/object-index/types";
import { fallbackObjectKey, objectKeyOf, primaryKeyFromProperties, type IdentityEntityType, type ObjectPrimaryKey } from "@/lib/object-identity";

/** 快照节点进索引时只看这三项，正好是 VersionSnapshot 里节点的形状。 */
export type IndexableNode = { id: string; labels: string[]; properties: Record<string, unknown> };

/** 合并文本的上限：防止一条超长 JSON 把索引行撑爆。 */
export const MAX_SEARCH_TEXT = 4000;

type ClassMeta = {
  displayProperty: string;
};

function collectClassMeta(definition: OntologyDefinition): Map<string, ClassMeta> {
  const meta = new Map<string, ClassMeta>();
  for (const entity of definition.entityTypes) {
    meta.set(entity.name, { displayProperty: entity.displayProperty?.trim() ?? "" });
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

/**
 * 节点属于哪个**对象类型**：取标签里第一个在定义中登记为对象类型的那个
 * （节点可能同时带接口标签 —— 接口是契约，不是它所属的对象类型）。
 */
export function resolveEntityType(node: IndexableNode, definition: OntologyDefinition): IdentityEntityType | null {
  for (const label of node.labels) {
    const entity = definition.entityTypes.find((item) => item.name === label);
    if (entity) return entity;
  }
  return null;
}

/** 业务主键值：按该对象类型的 sources[0].primaryKey 取值，取不到就留空。 */
export function resolvePrimaryKey(node: IndexableNode, definition: OntologyDefinition): ObjectPrimaryKey {
  const entityType = resolveEntityType(node, definition);
  if (!entityType) return {};
  return primaryKeyFromProperties(entityType, node.properties).primaryKey;
}

export function buildSearchText(title: string, properties: Record<string, unknown>) {
  const parts = [title, ...Object.values(properties).flatMap(scalarText)];
  return [...new Set(parts)].join(" ").slice(0, MAX_SEARCH_TEXT);
}

/**
 * 一个对象 -> 一条索引条目。**单条与整批共用这一份**，所以"发布时怎么写"与
 * "对象服务/增量同步怎么写"永远不会各说各话。
 */
export function buildIndexEntry(definition: OntologyDefinition, node: IndexableNode, meta?: Map<string, ClassMeta>): ObjectIndexEntry {
  const resolvedMeta = meta ?? collectClassMeta(definition);
  const title = resolveObjectTitle(node, resolvedMeta);
  const entityType = resolveEntityType(node, definition);
  const primaryKey = entityType ? primaryKeyFromProperties(entityType, node.properties).primaryKey : {};
  return {
    objectId: node.id,
    entityType: entityType?.name ?? "",
    objectKey: objectKeyOf(entityType?.name ?? "", primaryKey) || fallbackObjectKey(node.id),
    labels: [...node.labels],
    title,
    properties: node.properties,
    primaryKey,
    searchText: buildSearchText(title, node.properties),
  };
}

/**
 * 把已发布快照映射成索引条目。纯函数：发布流程与「重建索引」接口共用这一份逻辑，
 * 两边不会各说各话。
 */
export function buildIndexEntries(definition: OntologyDefinition, nodes: readonly IndexableNode[]): ObjectIndexEntry[] {
  const meta = collectClassMeta(definition);
  return nodes.map((node) => buildIndexEntry(definition, node, meta));
}
