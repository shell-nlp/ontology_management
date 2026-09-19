import type { DataSourceRowFilter } from "@/lib/data-source/types";
import { isLinkSourceConfigured, planLinkSource, type LinkPlan, type LinkSourceDefinition, type LinkSourceRelation } from "@/lib/link-source";
import { objectIdOf, objectRefOf, type ObjectPrimaryKey } from "@/lib/object-identity";
import { connectorFor, selectRowsBy } from "@/lib/object-service/data-source";
import type { ObjectContext } from "@/lib/object-service/types";

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
    if (!isLinkSourceConfigured(relation.linkSource)) return false;
    if (!wanted) return true;
    return relation.name === wanted || relation.id === wanted;
  });
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

  for (const relation of relationsToRead(context, query)) {
    const plan = planLinkSource(definition, relation);
    if (!plan.ok) {
      warnings.push(plan.reason);
      continue;
    }
    const filters = query.seed ? linkSeedFilters(plan, query.seed) : [];
    if (filters === null) continue; // 这条关系类型跟这个对象无关，不是问题，别报。
    relationshipTypes.push(relation.name);

    const { connector, label } = await connectorFor(plan.dataSourceId);
    if (!connector.selectRows) {
      warnings.push(`数据资源「${label}」不支持结构化取行，读不出关系类型「${relation.name}」的实例。`);
      continue;
    }
    const propertyColumns = (relation as { properties?: readonly { name: string; sourceField?: string }[] }).properties ?? [];
    const wanted = [...new Set([...plan.columns, ...propertyColumns.map((property) => (property.sourceField ?? "").trim()).filter(Boolean)])];
    const result = await connector.selectRows({ view: { schema: plan.table.schema || undefined, name: plan.table.name }, columns: wanted, filters, limit });
    if (result.truncated) warnings.push(`关系类型「${relation.name}」命中行数超过 ${result.rowLimit} 行，只返回了前 ${result.rowLimit} 行。`);
    counted = true;
    if (connector.countRows) {
      try {
        total = (total ?? 0) + (await connector.countRows({ view: { schema: plan.table.schema || undefined, name: plan.table.name }, filters }));
      } catch { total = null; }
    } else {
      total = null;
    }

    let skipped = 0;
    for (const row of result.rows) {
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
    if (skipped) warnings.push(`关系类型「${relation.name}」有 ${skipped} 行的键不全（连接行里的连接列是空值），这些行没有取成边。`);
  }

  // 同一个 (关系类型, 起点, 终点) 只留一条：连接表里重复行不该在图上画出两条边。
  const unique = new Map<string, ObjectLinkRecord>();
  for (const link of links) {
    const key = `${link.relationshipTypeId}|${link.source.objectId}|${link.target.objectId}`;
    if (!unique.has(key)) unique.set(key, link);
  }
  return { links: [...unique.values()], total: counted ? total : null, relationshipTypes, warnings };
}
