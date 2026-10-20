import { clickHouseConfig, type ClickHouseConfig } from "./config";

/**
 * ClickHouse HTTP 客户端。
 *
 * 参数走命名参数（URL 上的 `param_<name>`）；64 位整数用字符串传输，
 * 只把安全整数恢复成 number，避免 JSON.parse 丢精度。
 */
export type ClickHouseParams = Record<string, string>;

type QueryOptions = {
  params?: ClickHouseParams;
  settings?: Record<string, string>;
  raw?: boolean;
};

function buildUrl(config: ClickHouseConfig, options: QueryOptions): URL {
  const url = new URL(`${config.url}/`);
  url.searchParams.set("database", config.database);
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
    if (!response.ok) throw new Error(`ClickHouse 执行失败（HTTP ${response.status}）：${text.trim().slice(0, 300)}`);
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

export async function clickHouseExecute(sql: string, options: QueryOptions = {}): Promise<void> {
  await execute(sql, options);
}
