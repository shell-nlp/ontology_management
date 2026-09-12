import { createPostgresObjectIndex } from "@/lib/object-index/postgres";
import type { ObjectIndex } from "@/lib/object-index/types";

export * from "@/lib/object-index/types";
export { buildIndexEntries, MAX_SEARCH_TEXT, type IndexableNode } from "@/lib/object-index/entries";
export { escapeLike, normalizeSearchQuery, planObjectSearch } from "@/lib/object-index/sql";

let instance: ObjectIndex | undefined;

/**
 * 对象检索索引的入口。
 *
 * 注意：当前实现会引入 `pg`，只能服务端使用；客户端请直接引用
 * @/lib/object-index/types 里的纯类型。将来接 OpenSearch / Solr 时在这里分派。
 */
export function getObjectIndex(): ObjectIndex {
  instance ??= createPostgresObjectIndex();
  return instance;
}
