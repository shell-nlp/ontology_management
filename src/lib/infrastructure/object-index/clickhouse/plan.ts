import { normalizeSearchQuery, type NormalizedSearchQuery } from "@/lib/infrastructure/object-index/query";
import type { ObjectSearchQuery, ObjectSearchResult } from "@/lib/infrastructure/object-index/types";
import { clickHouseArrayParam, type ClickHouseParams } from "@/lib/infrastructure/object-index/clickhouse/client";

/**
 * 检索请求 -> ClickHouse SQL 的**纯函数**规划器（不连库，便于单测）。
 *
 * 与 PostgreSQL 那版的语义对齐，写在这里以免以后跑偏：
 * 1. **只认命名参数**：属性名、关键字、对象键全进 `params`，SQL 文本里只有 `{name:Type}` 占位符；
 * 2. **过滤算子按值类型解释**：EQ/NE 看过滤值本身是字符串 / 数字 / 布尔；IN / CONTAINS 按文本比；
 *    GT/LT 先用正则确认属性值是数字再比（一条脏数据不能让整个查询报错）；
 * 3. **相关度要回传**：命中标题给 0.6、命中正文给 0.3，否则前端拿到的 score 全是 0，排序看着毫无道理。
 */
export type ClickHouseFeatures = {
  vector: boolean;
};

export type ClickHouseStatement = { sql: string; params: ClickHouseParams };

export type ClickHouseSearchPlan = {
  hits: ClickHouseStatement;
  count: ClickHouseStatement;
  textMode: ObjectSearchResult["textMode"];
  vectorUsed: boolean;
};

export function tableName(database: string) {
  return `${database}.object_entries`;
}

type Params = ClickHouseParams;

/** 等值比较：按过滤值的类型选 JSONExtract 家族里的那个，避免把数字 1 与字符串 "1" 混为一谈。 */
function equalsClause(raw: unknown, keyParam: string, params: Params, name: (prefix: string) => string) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const valueParam = name("num");
    params[valueParam] = String(raw);
    return `JSONExtractFloat(properties, {${keyParam}:String}) = {${valueParam}:Float64}`;
  }
  if (typeof raw === "boolean") {
    const valueParam = name("bool");
    params[valueParam] = raw ? "1" : "0";
    return `JSONExtractBool(properties, {${keyParam}:String}) = {${valueParam}:Bool}`;
  }
  const valueParam = name("str");
  params[valueParam] = String(raw ?? "");
  return `JSONExtractString(properties, {${keyParam}:String}) = {${valueParam}:String}`;
}

/** 一条属性过滤 -> WHERE 片段；属性名本身也是参数。 */
function filterClause(filter: NonNullable<ObjectSearchQuery["filters"]>[number], params: Params, name: (prefix: string) => string) {
  const keyParam = name("key");
  params[keyParam] = filter.property.trim();
  const key = `{${keyParam}:String}`;
  const raw = filter.value;

  switch (filter.operator) {
    case "EXISTS":
      return `JSONHas(properties, ${key})`;
    case "EQ":
      return equalsClause(raw, keyParam, params, name);
    case "NE":
      // 与 PostgreSQL 的 jsonb 取反一致：属性缺失也算"不等于"。
      return `NOT (${equalsClause(raw, keyParam, params, name)})`;
    case "IN": {
      const valueParam = name("in");
      params[valueParam] = clickHouseArrayParam(Array.isArray(raw) ? raw.map(String) : [String(raw)]);
      return `JSONExtractString(properties, ${key}) IN {${valueParam}:Array(String)}`;
    }
    case "CONTAINS": {
      const valueParam = name("contains");
      params[valueParam] = String(raw);
      return `positionCaseInsensitive(JSONExtractString(properties, ${key}), {${valueParam}:String}) > 0`;
    }
    default: {
      // GT / LT：先确认属性值是数字，再比大小。
      const valueParam = name("bound");
      params[valueParam] = String(Number(raw));
      const numeric = `match(JSONExtractString(properties, ${key}), '^-?[0-9]+(\\.[0-9]+)?$')`;
      const comparison = filter.operator === "GT" ? ">" : "<";
      return `(${numeric} AND JSONExtractFloat(properties, ${key}) ${comparison} {${valueParam}:Float64})`;
    }
  }
}

export function planClickHouseSearch(query: ObjectSearchQuery, features: ClickHouseFeatures, database: string): ClickHouseSearchPlan {
  const q: NormalizedSearchQuery = normalizeSearchQuery(query);
  // 只装 WHERE 用到的参数；LIMIT / OFFSET 最后单独加，别混进总数查询。
  const whereParams: Params = {};
  const where: string[] = [];
  let seq = 0;
  const name = (prefix: string) => `${prefix}${(seq += 1)}`;

  const targetParam = name("target");
  whereParams[targetParam] = q.targetId;
  where.push(`target_id = {${targetParam}:String}`);

  if (q.labels.length) {
    const labelsParam = name("labels");
    whereParams[labelsParam] = clickHouseArrayParam(q.labels);
    where.push(`hasAny(labels, {${labelsParam}:Array(String)})`);
  }

  let textMode: ClickHouseSearchPlan["textMode"] = "none";
  let textScore = "0.0";
  if (q.text) {
    const textParam = name("text");
    whereParams[textParam] = q.text;
    const needle = `{${textParam}:String}`;
    const substring = `(positionCaseInsensitive(search_text, ${needle}) > 0 OR positionCaseInsensitive(title, ${needle}) > 0)`;
    // token 至少 3 个字符才走分词通道（更短的词在 CH 里只可能是子串匹配）。
    const token = q.text.length >= 3 ? ` OR hasTokenCaseInsensitive(search_text, ${needle})` : "";
    where.push(`(${substring}${token})`);
    textScore = `(if(positionCaseInsensitive(title, ${needle}) > 0, 0.6, 0.0) + if(positionCaseInsensitive(search_text, ${needle}) > 0, 0.3, 0.0))`;
    textMode = "fulltext+trigram";
  }

  for (const filter of q.filters) where.push(filterClause(filter, whereParams, name));

  const vectorUsed = Boolean(q.vector?.length && features.vector);
  let score = textMode !== "none" ? textScore : "0.0";
  const order: string[] = [];
  if (vectorUsed) {
    where.push("notEmpty(embedding)");
    // 向量元素已经过滤成有限数字，直接内联；CH 的参数解析不认 JSON 数组字面量。
    const vector = `[${(q.vector as number[]).join(",")}]`;
    const distance = `cosineDistance(embedding, ${vector})`;
    score = `(1.0 - ${distance})`;
    order.push(`${distance} ASC`);
  }
  if (textMode !== "none") order.push(`(${textScore}) DESC`);
  order.push("title ASC", "object_id ASC");

  const limitParam = name("limit");
  const offsetParam = name("offset");
  const whereSql = where.join(" AND ");
  const table = tableName(database);
  const select = "object_id, entity_type, object_key, labels, title, properties, primary_key";

  return {
    hits: {
      sql: `SELECT ${select}, ${score} AS score
              FROM ${table} FINAL
             WHERE ${whereSql}
             ORDER BY ${order.join(", ")}
             LIMIT {${limitParam}:UInt32} OFFSET {${offsetParam}:UInt32}`,
      params: { ...whereParams, [limitParam]: String(q.limit), [offsetParam]: String(q.offset) },
    },
    count: {
      sql: `SELECT count() AS total FROM ${table} FINAL WHERE ${whereSql}`,
      params: whereParams,
    },
    textMode,
    vectorUsed,
  };
}
