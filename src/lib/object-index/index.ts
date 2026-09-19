import { createPostgresObjectIndex } from "@/lib/object-index/postgres";
import type { ObjectIndex, ObjectIndexKind } from "@/lib/object-index/types";

export * from "@/lib/object-index/types";
export { buildIndexEntries, buildIndexEntry, resolveEntityType, resolvePrimaryKey, MAX_SEARCH_TEXT, type IndexableNode } from "@/lib/object-index/entries";

/*
 * `./sql.ts` 是**后端内部件**（PostgreSQL 的查询规划与 LIKE 转义），不从这里转出去：
 * 转出去就等于把"索引后端 = PostgreSQL"写进公共契约，将来接别的后端要么照抄、要么改调用方。
 * 要单测它就直接引 `@/lib/object-index/sql`（现有用例就是这么做的）。
 */

/**
 * **后端注册表：加一个后端 = 实现 `ObjectIndex` + 扩 `ObjectIndexKind` + 在这里登记一行。**
 * 现在只有 PostgreSQL（表 `ontology_platform.object_entries`：tsvector + pg_trgm + pgvector）；
 * 换成 ES / OpenSearch / Solr 时，上层（对象服务、界面、AI 工具）一行都不用动。
 */
const factories = new Map<ObjectIndexKind, () => ObjectIndex>([["POSTGRES", () => createPostgresObjectIndex()]]);

/**
 * 实例缓存挂 `globalThis`：dev 下模块会被反复求值，模块级变量会漏掉上一份实例 ——
 * 和 `@/lib/data-source/sql` 的连接池同一个道理（同一件事只留一份）。
 */
const instances = (() => {
  const holder = globalThis as typeof globalThis & { __ontologyObjectIndexes?: Map<ObjectIndexKind, ObjectIndex> };
  holder.__ontologyObjectIndexes ??= new Map();
  return holder.__ontologyObjectIndexes;
})();

/**
 * 对象检索索引的入口。**只能服务端使用**（当前实现会引入 `pg`）；
 * 客户端请直接引用 `@/lib/object-index/types` 里的纯类型。
 */
export function getObjectIndex(kind: ObjectIndexKind = "POSTGRES"): ObjectIndex {
  const cached = instances.get(kind);
  if (cached) return cached;
  const factory = factories.get(kind);
  if (!factory) throw new Error(`还没有 ${kind} 的检索索引实现：实现 ObjectIndex 之后在 @/lib/object-index 的 factories 里登记。`);
  const created = factory();
  instances.set(kind, created);
  return created;
}
