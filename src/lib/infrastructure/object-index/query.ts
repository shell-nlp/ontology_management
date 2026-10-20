import type { ObjectSearchQuery } from "@/lib/infrastructure/object-index/types";

/**
 * 检索请求的**后端无关**归一化。
 *
 * 放在这里（而不是某个后端的 SQL 规划器里）是因为限额与"脏输入算不算一条有效过滤"这类规则
 * 跟后端没关系：PostgreSQL 与 ClickHouse 必须给出同样宽严的判定，否则同一句请求在不同后端上
 * 会返回不同结果。只有"怎么翻译成查询语言"才是各后端自己的事。
 */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;
export const MAX_SEARCH_FILTERS = 20;
export const MAX_SEARCH_TEXT = 200;

export type NormalizedSearchQuery = {
  targetId: string;
  labels: string[];
  text: string;
  filters: NonNullable<ObjectSearchQuery["filters"]>;
  sort: NonNullable<ObjectSearchQuery["sort"]>;
  limit: number;
  offset: number;
  vector: number[] | undefined;
};

export function isNumericLiteral(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim());
}

export function normalizeSearchQuery(query: ObjectSearchQuery): NormalizedSearchQuery {
  const rawLimit = Number.isFinite(query.limit) ? Math.floor(query.limit as number) : DEFAULT_SEARCH_LIMIT;
  const rawOffset = Number.isFinite(query.offset) ? Math.floor(query.offset as number) : 0;
  return {
    targetId: query.targetId,
    labels: [...new Set((query.labels ?? []).map((label) => label.trim()).filter(Boolean))],
    text: (query.text ?? "").trim().slice(0, MAX_SEARCH_TEXT),
    filters: (query.filters ?? [])
      .filter((filter) => filter.property?.trim())
      // EXISTS 之外都要有值，否则这条过滤没有意义，直接丢掉比生成半截查询安全。
      .filter((filter) => filter.operator === "EXISTS" || filter.value !== undefined)
      // 大小比较的边界值本身也要是数字：非数字的边界属于写错的过滤条件，宁可丢掉也不能让整个查询报错。
      .filter((filter) => (filter.operator === "GT" || filter.operator === "LT" ? isNumericLiteral(filter.value) : true))
      .slice(0, MAX_SEARCH_FILTERS),
    sort: (query.sort ?? [])
      .map((item) => ({ ...item, property: item.property.trim() }))
      .filter((item) => item.property)
      .slice(0, 10),
    limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, rawLimit)),
    offset: Math.max(0, rawOffset),
    vector: query.vector?.length ? query.vector.filter((item) => Number.isFinite(item)) : undefined,
  };
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}
