/**
 * ClickHouse 连接配置。
 *
 * 全走环境变量（本机开发写在 `.env.local`，容器部署写在 `.env.docker`）：
 * - `CLICKHOUSE_URL`        HTTP 接口地址，默认 `http://localhost:8123`
 * - `CLICKHOUSE_DATABASE`   数据库名，默认 `ontology_index`
 * - `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`
 * - `CLICKHOUSE_TIMEOUT_MS` 单条查询超时，默认 15000
 *
 * 只认 HTTP 接口：ODS 与旧索引都曾复用这份最小客户端，现在 ODS 是唯一使用方。
 */
export type ClickHouseConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
  timeoutMs: number;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function clickHouseConfig(): ClickHouseConfig {
  const url = (process.env.CLICKHOUSE_URL ?? "").trim() || "http://localhost:8123";
  const database = (process.env.CLICKHOUSE_DATABASE ?? "").trim() || "ontology_index";
  if (!IDENTIFIER.test(database)) {
    throw new Error(`CLICKHOUSE_DATABASE 只能是字母、数字、下划线，且不能以数字开头（当前：${database}）。`);
  }
  const timeout = Number(process.env.CLICKHOUSE_TIMEOUT_MS ?? "");
  return {
    url: url.replace(/\/+$/, ""),
    database,
    user: (process.env.CLICKHOUSE_USER ?? "").trim() || "default",
    password: process.env.CLICKHOUSE_PASSWORD ?? "",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 15000,
  };
}
