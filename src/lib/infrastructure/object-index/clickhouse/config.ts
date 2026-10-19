/**
 * ClickHouse 连接配置。
 *
 * 全走环境变量（本机开发写在 `.env.local`，容器部署写在 `.env.docker`）：
 * - `CLICKHOUSE_URL`        HTTP 接口地址，默认 `http://localhost:8123`
 * - `CLICKHOUSE_DATABASE`   索引库名，默认 `ontology_index`（**库名进 DDL，必须校验字符集**）
 * - `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`
 * - `CLICKHOUSE_TIMEOUT_MS` 单条查询超时，默认 15000
 *
 * 只认 HTTP 接口（8123）：Node 侧用内置 `fetch`，不引 `@clickhouse/client` 之类的依赖 ——
 * 我们的查询形态简单（几条固定 SQL + 参数绑定），多一个客户端库只多一份升级负担。
 */
export const CLICKHOUSE_EMBEDDING_DIM = 1536;

export type ClickHouseConfig = {
  url: string;
  database: string;
  user: string;
  password: string;
  timeoutMs: number;
};

/** 库名会被拼进 DDL（CREATE DATABASE / 表名限定），标识符不允许参数化，只能白名单校验。 */
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
