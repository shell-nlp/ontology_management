import type { DataSourceRowFilter } from "@/lib/datasource/types";
import { hasKeyMappings, planLinkSource, type LinkPlan, type LinkSourceDefinition, type LinkSourceRelation } from "@/lib/ontology/link-source";
import { objectIdOf, objectRefOf, type ObjectPrimaryKey } from "@/lib/ontology/object-identity";
import { connectorFor, selectRowsBy } from "@/lib/instance/object-service/data-source";
import type { ObjectContext } from "@/lib/instance/object-service/types";
import { readOdsLinkRows } from "./link-rows";

/**
 * 关系实例（边）的读取（backlog D2）。
 *
 * 和对象服务对称：上层只说"要哪条关系类型的边、以哪个对象为起点"，"边存在哪张表、怎么连"
 * 全交给 `@/lib/link-source` 的计划，这里只负责取行、拼对象身份、去重与如实告知。
 *
 * 一条边不存副本：两端的对象 id 由 `(对象类型, 主键)` 确定性推出来（S1），
 * 所以这里返回的 id 与对象页 / 图谱 / 索引用的是同一套身份，边不会挂到别的节点上。
 */

/** 单次取边最多多少行：图上一屏也画不下更多。 */
export const MAX_LINK_ROWS = 500;
const DEFAULT_LINK_ROWS = 200;

export type ObjectLinkEndpoint = {
  entityType: string;
  objectId: string;
  primaryKey: ObjectPrimaryKey;
  objectRef: string;
};

export type ObjectLinkRecord = {
  relationshipTypeId: string;
  relationshipType: string;
  source: ObjectLinkEndpoint;
  target: ObjectLinkEndpoint;
  /** 关系类型自己声明的属性里，映射到连接行上的那一部分。 */
  properties: Record<string, unknown>;
  origin: "source";
  /** 稳定引用串：`关系类型/起点引用->终点引用`，界面和 AI 之间传它。 */
  linkRef: string;
  warnings: string[];
};

export type ObjectLinkQuery = {
  /** 关系类型名或 id；不传就是所有配好了数据来源的关系类型。 */
  relationshipType?: string;
  /**
   * 只看某一端是这些对象的边（对象类型 + 一批主键）。
   * 图谱"取一批节点再看它们之间的边"就是这么用的：过滤下推成 `IN`，一次查询搞定，不必拉整张连接表。
   */
  seed?: { entityType: string; keys: readonly ObjectPrimaryKey[] };
  limit?: number;
};

export type ObjectLinkQueryResult = {
  links: ObjectLinkRecord[];
  /** 拿不到精确总数时是 null，不编造。 */
  total: number | null;
  /** 这次实际问到哪些关系类型（按名字，去重）。 */
  relationshipTypes: string[];
  warnings: string[];
  /** 命中查询上限，返回的边不是全部。 */
  truncated: boolean;
};

export type ObjectLinkNeighborhoodQuery = ObjectLinkQuery & {
  /** 从种子对象向外走几跳；默认 1，最大 3。 */
  depth?: number;
  /** 整张子图最多保留多少端对象；默认 200，最大 500。 */
  maxNodes?: number;
  /** 整张子图最多保留多少条边；默认 500，最大 2000。 */
  maxLinks?: number;
};

export type ObjectLinkNeighborhoodResult = ObjectLinkQueryResult & {
  depthReached: number;
  truncated: boolean;
};

/** 行里的列名大小写由库决定（Oracle 会折成大写），取值一律按小写匹配并去空格。 */
function reader(row: Record<string, unknown>) {
  const byLower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  return (column: string): string => {
    const value = byLower.get(column.toLowerCase());
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (value instanceof Date) return value.toISOString();
    return "";
  };
}

function keyFromPairs(pairs: readonly { rowColumn: string; keyColumn: string }[], read: (column: string) => string) {
  const key: ObjectPrimaryKey = {};
  for (const pair of pairs) {
    const value = read(pair.rowColumn);
    if (!value) return null;
    key[pair.keyColumn] = value;
  }
  return key;
}

function endpoint(entityType: string, primaryKey: ObjectPrimaryKey): ObjectLinkEndpoint | null {
  const objectId = objectIdOf(entityType, primaryKey);
  if (!objectId) return null;
  return { entityType, objectId, primaryKey, objectRef: objectRefOf(entityType, primaryKey) };
}

/**
 * 把「只看这个对象相关的边」下推成数据源的过滤条件。
 * 返回 null = 这条关系类型跟这个对象没关系（不用问了）。
 */
export function linkSeedFilters(plan: LinkPlan, seed: { entityType: string; keys: readonly ObjectPrimaryKey[] }): DataSourceRowFilter[] | null {
  if (!plan.ok) return null;
  // 先把"这一侧的哪一列 对 对象主键的哪一列"列出来，两种模式只在取这份对应关系时不同。
  const mapping: { rowColumn: string; keyColumn: string }[] | null =
    plan.mode === "JOIN_TABLE"
      ? plan.source.entityTypeName === seed.entityType
        ? plan.source.pairs
        : plan.target.entityTypeName === seed.entityType ? plan.target.pairs : null
      : plan.holder.entityTypeName === seed.entityType
        ? plan.holder.keyColumns.map((column) => ({ rowColumn: column, keyColumn: column }))
        : plan.foreignKeys.referenced.entityTypeName === seed.entityType
          ? plan.foreignKeys.keyColumns.map((keyColumn, index) => ({ rowColumn: plan.foreignKeys.rowColumns[index], keyColumn }))
          : null;
  if (!mapping) return null;
  const filters: DataSourceRowFilter[] = [];
  for (const pair of mapping) {
    const values = [...new Set(seed.keys.map((key) => key[pair.keyColumn]).filter((value): value is string => Boolean(value)))];
    // 一个值都给不出来 = 这一批主键没覆盖到这一列，问下去只会得到错的结果。
    if (!values.length) return null;
    filters.push(values.length === 1
      ? { column: pair.rowColumn, operator: "EQ", value: values[0] }
      : { column: pair.rowColumn, operator: "IN", value: values });
  }
  return filters;
}

function relationsToRead(context: ObjectContext, query: ObjectLinkQuery): LinkSourceRelation[] {
  const wanted = (query.relationshipType ?? "").trim();
  return context.definition.relationshipTypes.filter((relation) => {
    // 外键式可以零配置（表和来源都从外键端主来源推断），所以判据是"键映射填了吗"。
    if (!hasKeyMappings(relation)) return false;
    if (!wanted) return true;
    return relation.name === wanted || relation.id === wanted;
  });
}

/** 这条关系类型要从连接表里取的列：键映射落到的列 + 关系类型自己属性落到的列。 */
export function linkReadColumns(relation: LinkSourceRelation, plan: LinkPlan & { ok: true }): string[] {
  const propertyColumns = (relation as { properties?: readonly { name: string; sourceField?: string }[] }).properties ?? [];
  return [...new Set([...plan.columns, ...propertyColumns.map((property) => (property.sourceField ?? "").trim()).filter(Boolean)])];
}

/**
 * 整份读连接表时按哪些列排序 / 做游标：键映射落到的那些**真实列**。
 * 这些列组合起来能唯一认出一行连接行，所以拿它当键集分页的排序键。
 */
export function linkOrderColumns(plan: LinkPlan & { ok: true }): string[] {
  return plan.mode === "JOIN_TABLE"
    ? [...new Set([...plan.source.pairs.map((pair) => pair.rowColumn), ...plan.target.pairs.map((pair) => pair.rowColumn)])]
    : [...new Set([...plan.holder.keyColumns, ...plan.foreignKeys.rowColumns])];
}

/**
 * 把一个连接行批次解码成边。**取数方式不同、解码只有这一处** ——
 * 按需读（一跳展开）与整份物化（落进索引）必须产出同一批边，不然两边迟早各说各话。
 */
export function linksFromRows(
  relation: LinkSourceRelation,
  plan: LinkPlan & { ok: true },
  rows: readonly Record<string, unknown>[],
): { links: ObjectLinkRecord[]; skipped: number } {
  const propertyColumns = (relation as { properties?: readonly { name: string; sourceField?: string }[] }).properties ?? [];
  const links: ObjectLinkRecord[] = [];
  let skipped = 0;
  for (const row of rows) {
    const read = reader(row);
    let sourceKey: ObjectPrimaryKey | null;
    let targetKey: ObjectPrimaryKey | null;
    let sourceType: string;
    let targetType: string;
    if (plan.mode === "JOIN_TABLE") {
      sourceKey = keyFromPairs(plan.source.pairs, read);
      targetKey = keyFromPairs(plan.target.pairs, read);
      sourceType = plan.source.entityTypeName;
      targetType = plan.target.entityTypeName;
    } else {
      const holderKey: ObjectPrimaryKey = {};
      for (const column of plan.holder.keyColumns) {
        const value = read(column);
        if (value) holderKey[column] = value;
      }
      const referencedKey: ObjectPrimaryKey = {};
      for (const [index, keyColumn] of plan.foreignKeys.keyColumns.entries()) {
        const value = read(plan.foreignKeys.rowColumns[index]);
        if (value) referencedKey[keyColumn] = value;
      }
      const holderIsSource = plan.keyHolder === "SOURCE";
      const holderComplete = plan.holder.keyColumns.every((column) => holderKey[column]);
      const referencedComplete = plan.foreignKeys.keyColumns.every((column) => referencedKey[column]);
      sourceKey = holderIsSource ? (holderComplete ? holderKey : null) : referencedComplete ? referencedKey : null;
      targetKey = holderIsSource ? (referencedComplete ? referencedKey : null) : holderComplete ? holderKey : null;
      sourceType = holderIsSource ? plan.holder.entityTypeName : plan.foreignKeys.referenced.entityTypeName;
      targetType = holderIsSource ? plan.foreignKeys.referenced.entityTypeName : plan.holder.entityTypeName;
    }
    const source = sourceKey && endpoint(sourceType, sourceKey);
    const target = targetKey && endpoint(targetType, targetKey);
    if (!source || !target) { skipped += 1; continue; }
    links.push({
      relationshipTypeId: relation.id ?? "",
      relationshipType: relation.name,
      source,
      target,
      properties: Object.fromEntries(propertyColumns.map((property) => [property.name, read(property.sourceField ?? property.name)]).filter(([, value]) => value !== "")),
      origin: "source",
      linkRef: `${relation.name}/${source.objectRef}->${target.objectRef}`,
      warnings: [],
    });
  }
  return { links, skipped };
}

/**
 * 读一批关系实例。
 *
 * `seed` 是"以某个对象为起点"的做法：过滤条件会下推到业务库（等值比较，走得了索引），
 * 而不是把整张连接表拉回来再筛。这是图谱"从数据源加载"能按一跳展开的关键。
 */
export async function queryLinks(context: ObjectContext, query: ObjectLinkQuery = {}): Promise<ObjectLinkQueryResult> {
  const definition = context.definition as unknown as LinkSourceDefinition;
  const limit = Math.min(MAX_LINK_ROWS, Math.max(1, Math.floor(query.limit ?? DEFAULT_LINK_ROWS)));
  const warnings: string[] = [];
  const links: ObjectLinkRecord[] = [];
  const relationshipTypes: string[] = [];
  let total: number | null = 0;
  let counted = false;
  let truncated = false;

  for (const relation of relationsToRead(context, query)) {
    const remaining = limit - links.length;
    if (remaining <= 0) { truncated = true; break; }
    const plan = planLinkSource(definition, relation);
    if (!plan.ok) {
      warnings.push(plan.reason);
      continue;
    }
    // 计划自己带的说明也如实转出去（例如"外键式自动判断：外键在起点、表取它的主来源"）。
    warnings.push(...plan.warnings);
    const filters = query.seed ? linkSeedFilters(plan, query.seed) : [];
    if (filters === null) continue; // 这条关系类型跟这个对象无关，不是问题，别报。
    relationshipTypes.push(relation.name);

    const wanted = linkReadColumns(relation, plan);
    const keyGroups = query.seed?.keys.map((key) => linkSeedFilters(plan, { entityType: query.seed!.entityType, keys: [key] })).filter((group): group is DataSourceRowFilter[] => Boolean(group));
    const ods = await readOdsLinkRows(context, plan, wanted, filters, keyGroups, remaining);
    const direct = ods ? null : await connectorFor(plan.dataSourceId);
    if (!ods && !direct?.connector.selectRows) {
      warnings.push(`数据资源「${direct?.label}」不支持结构化取行，读不出关系类型「${relation.name}」的实例。`);
      continue;
    }
    const result = ods ?? await direct!.connector.selectRows!({ view: { schema: plan.table.schema || undefined, name: plan.table.name }, columns: wanted, filters, ...(keyGroups ? { keyGroups } : {}), limit: remaining });
    if (result.truncated) {
      truncated = true;
      warnings.push(`关系类型「${relation.name}」命中行数超过 ${result.rowLimit} 行，只返回了前 ${result.rowLimit} 行。`);
    }
    counted = true;
    if (ods) {
      total = total === null || ods.total === null ? null : total + ods.total;
    } else if (direct?.connector.countRows) {
      try {
        const count = await direct.connector.countRows({ view: { schema: plan.table.schema || undefined, name: plan.table.name }, filters, ...(keyGroups ? { keyGroups } : {}) });
        if (total !== null) total += count;
      } catch { total = null; }
    } else {
      total = null;
    }

    const decoded = linksFromRows(relation, plan, result.rows);
    links.push(...decoded.links);
    if (decoded.skipped) warnings.push(`关系类型「${relation.name}」有 ${decoded.skipped} 行的键不全（连接行里的连接列是空值），这些行没有取成边。`);
  }

  // 同一个 (关系类型, 起点, 终点) 只留一条：连接表里重复行不该在图上画出两条边。
  const unique = new Map<string, ObjectLinkRecord>();
  for (const link of links) {
    const key = `${link.relationshipTypeId}|${link.source.objectId}|${link.target.objectId}`;
    if (!unique.has(key)) unique.set(key, link);
  }
  const uniqueLinks = [...unique.values()];
  if (links.length > uniqueLinks.length) warnings.push(`连接行重复：${links.length} 行形成 ${uniqueLinks.length} 条唯一关系，合并 ${links.length - uniqueLinks.length} 条重复边。`);
  if (uniqueLinks.length >= limit) truncated = true;
  return { links: uniqueLinks.slice(0, limit), total: counted ? total : null, relationshipTypes, warnings, truncated };
}

/**
 * 有界邻域遍历：从一个/一批种子对象逐跳读关系实例。
 *
 * 不允许无界递归。每次只扩展上一层的端对象，跳数、节点数和边数都有硬上限；达到上限就停止并报数，
 * 不把“只展开了一部分”伪装成完整子图。这里只返回边，节点属性由对象服务按端点主键批量补齐。
 */
export async function queryLinkNeighborhood(
  context: ObjectContext,
  query: ObjectLinkNeighborhoodQuery,
): Promise<ObjectLinkNeighborhoodResult> {
  if (!query.seed?.keys.length) throw new Error("邻域遍历必须提供至少一个种子对象。");
  const depthLimit = Math.min(3, Math.max(1, Math.floor(query.depth ?? 1)));
  const maxNodes = Math.min(500, Math.max(1, Math.floor(query.maxNodes ?? 200)));
  const maxLinks = Math.min(2000, Math.max(1, Math.floor(query.maxLinks ?? 500)));
  const allLinks = new Map<string, ObjectLinkRecord>();
  const seenNodes = new Map<string, { entityType: string; key: ObjectPrimaryKey }>();
  let frontier = new Map<string, Map<string, ObjectPrimaryKey>>();
  for (const key of query.seed.keys) {
    const endpointValue = endpoint(query.seed.entityType, key);
    if (!endpointValue || seenNodes.has(endpointValue.objectId)) continue;
    const item = { entityType: query.seed.entityType, key };
    seenNodes.set(endpointValue.objectId, item);
    const bucket = frontier.get(item.entityType) ?? new Map<string, ObjectPrimaryKey>();
    bucket.set(endpointValue.objectId, key);
    frontier.set(item.entityType, bucket);
  }
  // 同类型种子一次批量问；不同 seed 类型由调用方分别发起邻域。
  const warnings: string[] = [];
  const relationshipTypes = new Set<string>();
  let depthReached = 0;
  let truncated = false;

  while (frontier.size && depthReached < depthLimit) {
    const remaining = maxLinks - allLinks.size;
    if (remaining <= 0) { truncated = true; warnings.push(`边数达到上限 ${maxLinks}，邻域已停止扩展。`); break; }
    const next = new Map<string, Map<string, ObjectPrimaryKey>>();
    let pageHadMore = false;
    for (const [entityType, keys] of frontier) {
      if (allLinks.size >= maxLinks) { truncated = true; break; }
      const room = Math.min(MAX_LINK_ROWS, maxLinks - allLinks.size);
      const result = await queryLinks(context, {
        relationshipType: query.relationshipType,
        seed: { entityType, keys: [...keys.values()] },
        limit: room,
      });
      warnings.push(...result.warnings);
      if (result.truncated) pageHadMore = true;
      for (const name of result.relationshipTypes) relationshipTypes.add(name);
      if (result.links.length >= room) pageHadMore = true;
      for (const link of result.links) {
        if (allLinks.size >= maxLinks) { truncated = true; break; }
        const endpoints = [link.source, link.target];
        const newEndpoints = endpoints.filter((side) => !seenNodes.has(side.objectId));
        if (seenNodes.size + newEndpoints.length > maxNodes) {
          truncated = true;
          continue;
        }
        if (!allLinks.has(link.linkRef)) allLinks.set(link.linkRef, link);
        for (const side of endpoints) {
          if (seenNodes.has(side.objectId)) continue;
          seenNodes.set(side.objectId, { entityType: side.entityType, key: side.primaryKey });
          const bucket = next.get(side.entityType) ?? new Map<string, ObjectPrimaryKey>();
          bucket.set(side.objectId, side.primaryKey);
          next.set(side.entityType, bucket);
        }
      }
    }
    depthReached += 1;
    if (truncated) {
      warnings.push(`邻域达到节点上限 ${maxNodes} 或边数上限 ${maxLinks}，已返回有界子图。`);
      break;
    }
    if (!next.size) break;
    if (pageHadMore) {
      truncated = true;
      warnings.push(`当前层关系边达到单次读取上限 ${MAX_LINK_ROWS}，邻域没有继续向更深一层扩展。`);
      break;
    }
    frontier = next;
  }
  return {
    links: [...allLinks.values()],
    total: allLinks.size,
    relationshipTypes: [...relationshipTypes],
    depthReached,
    truncated,
    warnings: [...new Set(warnings)],
  };
}
