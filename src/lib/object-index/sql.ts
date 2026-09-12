import type { ObjectSearchQuery } from "@/lib/object-index/types";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;
export const MAX_SEARCH_FILTERS = 20;
export const MAX_SEARCH_TEXT = 200;

export type SqlStatement = { text: string; values: unknown[] };

export type ObjectSearchFeatures = { trigram: boolean; vector: boolean };

export type ObjectSearchPlan = {
  hits: SqlStatement;
  count: SqlStatement;
  textMode: "fulltext+trigram" | "fulltext" | "none";
  vectorUsed: boolean;
};

/**
 * 关键字里的 % 与 _ 是 ILIKE 的通配符。用户输入 `%` 不应该变成「匹配一切」，
 * 所以进 SQL 之前先转义，并在语句里声明 ESCAPE。
 */
export function escapeLike(value: string) {
  return value.replace(/([\\%_])/g, "\\$1");
}

export type NormalizedSearchQuery = {
  targetId: string;
  labels: string[];
  text: string;
  filters: NonNullable<ObjectSearchQuery["filters"]>;
  limit: number;
  offset: number;
  vector: number[] | undefined;
};

export function normalizeSearchQuery(query: ObjectSearchQuery): NormalizedSearchQuery {
  const rawLimit = Number.isFinite(query.limit) ? Math.floor(query.limit as number) : DEFAULT_SEARCH_LIMIT;
  const rawOffset = Number.isFinite(query.offset) ? Math.floor(query.offset as number) : 0;
  return {
    targetId: query.targetId,
    labels: [...new Set((query.labels ?? []).map((label) => label.trim()).filter(Boolean))],
    text: (query.text ?? "").trim().slice(0, MAX_SEARCH_TEXT),
    filters: (query.filters ?? [])
      .filter((filter) => filter.property?.trim())
      // EXISTS 之外都要有值，否则这条过滤没有意义，直接丢掉比生成半截 SQL 安全。
      .filter((filter) => filter.operator === "EXISTS" || filter.value !== undefined)
      // 大小比较的边界值本身也要是数字：它会被当成 numeric 绑定参数，非数字会在参数绑定阶段报错，
      // WHERE 里的正则守卫救不了这种情况。
      .filter((filter) => (filter.operator === "GT" || filter.operator === "LT" ? isNumericLiteral(filter.value) : true))
      .slice(0, MAX_SEARCH_FILTERS),
    limit: Math.min(MAX_SEARCH_LIMIT, Math.max(1, rawLimit)),
    offset: Math.max(0, rawOffset),
    vector: query.vector?.length ? query.vector : undefined,
  };
}

export function isNumericLiteral(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  return /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim());
}

/**
 * 把检索请求翻译成两条参数化 SQL：命中列表与总数。
 *
 * 纯函数，便于单测；执行与后端能力探测都在 @/lib/object-index/postgres。
 * 所有用户输入一律走占位符，属性名也不例外。
 */
export function planObjectSearch(query: ObjectSearchQuery, features: ObjectSearchFeatures): ObjectSearchPlan {
  const q = normalizeSearchQuery(query);
  // WHERE 用到的值单独记账：总数查询只带这些，排序/分页/向量参数不能混进去。
  const whereValues: unknown[] = [q.targetId];
  const where: string[] = ["e.target_id = $1"];
  const w = (value: unknown) => {
    whereValues.push(value);
    return `$${whereValues.length}`;
  };
  const extras: unknown[] = [];
  const x = (value: unknown) => {
    extras.push(value);
    return `$${whereValues.length + extras.length}`;
  };

  if (q.labels.length) where.push(`e.labels && ${w(q.labels)}::text[]`);

  let textMode: ObjectSearchPlan["textMode"] = "none";
  let textScore = "0::real";
  if (q.text) {
    const like = w(escapeLike(q.text));
    const ts = w(q.text);
    where.push(`(e.search_doc @@ plainto_tsquery('simple', ${ts}) OR e.search_text ILIKE '%' || ${like} || '%' ESCAPE '\\')`);
    const rank = `ts_rank(e.search_doc, plainto_tsquery('simple', ${ts}))`;
    const titleHit = `CASE WHEN e.title ILIKE '%' || ${like} || '%' ESCAPE '\\' THEN 0.6 ELSE 0 END`;
    const bodyHit = `CASE WHEN e.search_text ILIKE '%' || ${like} || '%' ESCAPE '\\' THEN 0.3 ELSE 0 END`;
    textScore = features.trigram
      ? `GREATEST(${rank}, similarity(e.search_text, ${ts}), ${titleHit}, ${bodyHit})`
      : `GREATEST(${rank}, ${titleHit}, ${bodyHit})`;
    textMode = features.trigram ? "fulltext+trigram" : "fulltext";
  }

  for (const filter of q.filters) {
    const property = filter.property.trim();
    const operator = filter.operator;
    if (operator === "EXISTS") {
      where.push(`e.properties ? ${w(property)}`);
      continue;
    }
    if (operator === "EQ" || operator === "NE") {
      // 等值走 jsonb 包含判断，属性名进 JSON 值，不需要单独占位。
      const blob = w(JSON.stringify({ [property]: filter.value }));
      where.push(operator === "EQ" ? `e.properties @> ${blob}::jsonb` : `NOT (e.properties @> ${blob}::jsonb)`);
      continue;
    }
    // 其余算子都要按属性名取原始值，属性名一律走占位符。
    const key = w(property);
    if (operator === "IN") {
      const list = w(Array.isArray(filter.value) ? filter.value.map(String) : [String(filter.value)]);
      where.push(`e.properties->>${key} = ANY(${list}::text[])`);
      continue;
    }
    if (operator === "CONTAINS") {
      const needle = w(escapeLike(String(filter.value)));
      where.push(`e.properties->>${key} ILIKE '%' || ${needle} || '%' ESCAPE '\\'`);
      continue;
    }
    // GT / LT：先用正则确认是数字再转型，否则一条脏数据会让整条查询报错。
    const bound = w(String(filter.value));
    const numeric = `(e.properties->>${key}) ~ '^-?[0-9]+(\\.[0-9]+)?$'`;
    const comparison = operator === "GT" ? ">" : "<";
    where.push(`(${numeric} AND (e.properties->>${key})::numeric ${comparison} ${bound}::numeric)`);
  }

  const vectorUsed = Boolean(q.vector && features.vector);
  // 有文本检索能力时把算出来的相关度回传；否则前端只能拿到 0，排序看起来会毫无道理。
  let scoreSelect = textMode !== "none" ? `(${textScore}) AS score` : "0::real AS score";
  const order: string[] = [];
  if (vectorUsed) {
    where.push("e.embedding IS NOT NULL");
    const vec = x(`[${(q.vector as number[]).join(",")}]`);
    const similarity = `(1 - (e.embedding <=> ${vec}::vector))`;
    scoreSelect = `${similarity} AS score`;
    order.push(`${similarity} DESC`);
  }
  if (textMode !== "none") order.push(`(${textScore}) DESC`);
  order.push("e.title ASC", "e.object_id ASC");

  const limit = x(q.limit);
  const offset = x(q.offset);
  const whereSql = where.join(" AND ");

  return {
    hits: {
      text: `SELECT e.object_id, e.labels, e.title, e.properties, e.primary_key, ${scoreSelect}
               FROM ontology_platform.object_entries e
              WHERE ${whereSql}
              ORDER BY ${order.join(", ")}
              LIMIT ${limit} OFFSET ${offset}`,
      values: [...whereValues, ...extras],
    },
    count: {
      text: `SELECT COUNT(*)::int AS total FROM ontology_platform.object_entries e WHERE ${whereSql}`,
      values: [...whereValues],
    },
    textMode,
    vectorUsed,
  };
}
