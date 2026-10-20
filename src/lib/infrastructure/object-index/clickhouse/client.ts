import { clickHouseConfig, type ClickHouseConfig } from "@/lib/infrastructure/object-index/clickhouse/config";

/**
 * ClickHouse HTTP 客户端。
 *
 * 两件事必须做对，否则要么注入、要么解析出错：
 * 1. **参数一律走命名参数**（URL 上的 `param_<name>`，SQL 里写 `{name:String}`）——
 *    属性名、关键字、对象键这些用户输入永远不进 SQL 文本；
 * 2. **64 位整数用带引号 JSON 传输**，只将安全范围内的整数恢复为 number，
 *    大主键保留为字符串，避免 JSON.parse 造成精度丢失。
 */
export type ClickHouseParams = Record<string, string>;

type QueryOptions = {
  params?: ClickHouseParams;
  /** 覆盖默认设置（例如 `mutations_sync=1`）。 */
  settings?: Record<string, string>;
  /** 插入语句不需要 JSON 解析，可以跳过。 */
  raw?: boolean;
};

function buildUrl(config: ClickHouseConfig, options: QueryOptions): URL {
  const url = new URL(`${config.url}/`);
  url.searchParams.set("database", config.database);
  // Keep large identifiers exact; safe integers are normalized after JSON parsing.
  url.searchParams.set("output_format_json_quote_64bit_integers", "1");
  if (!options.raw) url.searchParams.set("default_format", "JSON");
  for (const [key, value] of Object.entries(options.settings ?? {})) url.searchParams.set(key, value);
  for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(`param_${key}`, value);
  return url;
}

async function execute(sql: string, options: QueryOptions = {}): Promise<string> {
  const config = clickHouseConfig();
  const url = buildUrl(config, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": config.user,
        "X-ClickHouse-Key": config.password,
        "content-type": "text/plain; charset=utf-8",
      },
      body: sql,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse 执行失败（HTTP ${response.status}）：${text.trim().slice(0, 300)}`);
    }
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`ClickHouse 查询超时（${config.timeoutMs}ms）：${sql.slice(0, 120)}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 查询并取 `data` 数组（列名 -> 值）。 */
export async function clickHouseQuery<T = Record<string, unknown>>(sql: string, options: QueryOptions = {}): Promise<T[]> {
  const text = await execute(sql, options);
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as { data?: T[]; meta?: { name: string; type: string }[] };
  const integerColumns = (parsed.meta ?? []).filter((column) => /\bU?Int(?:64|128|256)\b/.test(column.type));
  for (const row of parsed.data ?? []) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    for (const column of integerColumns) {
      const value = record[column.name];
      if (typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) record[column.name] = Number(value);
    }
  }
  return parsed.data ?? [];
}

/** 执行不关心结果的语句（DDL / INSERT / DELETE）。 */
export async function clickHouseExecute(sql: string, options: QueryOptions = {}): Promise<void> {
  await execute(sql, options);
}

/** 把 JS 数组序列化成 ClickHouse 的参数值（`['a','b']`，不是 JSON —— CH 不认双引号形式）。 */
export function clickHouseArrayParam(values: readonly string[]): string {
  return `[${values.map((value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}]`;
}
