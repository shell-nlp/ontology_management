import "reflect-metadata";

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DataSource, type DataSourceOptions } from "typeorm";

import {
  dataSourceKindInfo,
  type DataSourceConnector,
  type DataSourceHealth,
  type DataSourceKind,
  type DataSourceKindInfo,
  type DataSourceRecord,
  type DataViewField,
  type DataViewPreview,
  type DataViewRef,
  type DataViewSummary,
} from "@/lib/data-source/types";

/**
 * 关系库来源的通用实现。
 *
 * 三种数据库共用连接、预览、标识符处理；只有"结构从哪读"分成两份策略：
 * - PostgreSQL / MySQL：交给 ORM 的 QueryRunner（information_schema 已经抹平）；
 * - Oracle：TypeORM 1.1 的 ALL_TABLES 查询在旧服务端上会报 ORA-00923，改用 ALL_TABLES /
 *   ALL_VIEWS / ALL_TAB_COLUMNS 自己读 —— 这几张视图在 11g 起的版本上口径一致。
 *
 * 接入第四种关系库，需要改的就是"连接参数、标识符引用、行数上限、结构探查"这四处。
 */

const CONNECT_TIMEOUT_MS = 8000;
const PREVIEW_LIMIT_MAX = 200;
const VIEW_LIMIT_MAX = 5000;
const DEFAULT_PREVIEW_ROWS = 20;

export type DataSourceCredentials = { username: string; password: string };

/** 一个表/视图在结构清单里的最小信息。 */
export type CatalogObject = { schema: string; name: string; kind: DataViewSummary["kind"]; comment: string; columnCount: number };

/** 连接表单里填的容器；Oracle 没填模式时用连接用户名（Oracle 的模式即用户）。 */
export function resolveContainer(kind: DataSourceKind, record: Pick<DataSourceRecord, "schema_name" | "database_name" | "username">) {
  if (kind === "ORACLE") return record.schema_name || record.username.toUpperCase();
  return record.schema_name || record.database_name;
}

/** 拼 ORM 连接参数。纯函数，便于直接断言三种数据库的差异。 */
export function buildConnectionOptions(kind: DataSourceKind, record: DataSourceRecord, credentials: DataSourceCredentials): DataSourceOptions {
  const base = { name: `data-source-${record.id}`, entities: [], synchronize: false, logging: false as const };
  const username = credentials.username || record.username;
  const password = credentials.password;

  if (kind === "ORACLE") {
    return {
      ...base,
      type: "oracle",
      host: record.host,
      port: record.port,
      // Oracle 用服务名连接；模式留空时 ORM 用连接用户自己的模式。
      serviceName: record.database_name,
      username,
      password,
      ...(record.schema_name ? { schema: record.schema_name } : {}),
    } as DataSourceOptions;
  }

  if (kind === "MYSQL") {
    return {
      ...base,
      type: "mysql",
      host: record.host,
      port: record.port,
      database: record.database_name,
      username,
      password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      // 64 位主键在预览里不能丢精度。
      supportBigNumbers: true,
      bigNumberStrings: true,
    } as DataSourceOptions;
  }

  return {
    ...base,
    type: "postgres",
    host: record.host,
    port: record.port,
    database: record.database_name,
    username,
    password,
    schema: record.schema_name || "public",
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
  } as DataSourceOptions;
}

/** 标识符引用：PostgreSQL / Oracle 用双引号，MySQL 用反引号；内部同类引号翻倍转义。 */
export function quoteIdentifier(kind: DataSourceKind, name: string) {
  if (kind === "MYSQL") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** 字符串字面量；只用于把已经来自登记信息或库元数据的名字拼进系统表查询。 */
function quoteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 表/视图的完整限定名；schema 为空时只写对象名。 */
export function qualifiedName(kind: DataSourceKind, schema: string | undefined, name: string) {
  const target = quoteIdentifier(kind, name);
  return schema ? `${quoteIdentifier(kind, schema)}.${target}` : target;
}

/**
 * 预览语句。Oracle 没有 LIMIT，用 ROWNUM 包一层（FETCH FIRST 要 12c 起，旧库不认）；
 * 行数先夹到安全范围再拼，拼进去的一定是整数，标识符已经引号包裹。
 */
export function previewStatement(kind: DataSourceKind, schema: string | undefined, name: string, limit: number) {
  const rows = clampLimit(limit);
  const target = qualifiedName(kind, schema, name);
  return kind === "ORACLE" ? `SELECT * FROM (SELECT * FROM ${target}) WHERE ROWNUM <= ${rows}` : `SELECT * FROM ${target} LIMIT ${rows}`;
}

export function clampLimit(value: number, max = PREVIEW_LIMIT_MAX, fallback = DEFAULT_PREVIEW_ROWS) {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

/** 预览值要能直接进 JSON：日期转 ISO、二进制只报大小、大整数转字符串。 */
export function toPreviewValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(toPreviewValue);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function normalizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toPreviewValue(value)]));
}

/** 驱动缺失、认证失败、连不上主机，这三类要能一眼分清。 */
export function describeConnectionError(info: DataSourceKindInfo, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(message)) return `缺少 ${info.label} 驱动（${info.driverPackage}），请先安装后再连接。`;
  // 11g 及更早的服务端在 Thin 模式下会被驱动直接拒绝，只能靠 Instant Client 走 Thick 模式。
  if (/NJS-138|not supported by node-oracledb in Thin mode/i.test(message)) {
    return `${info.label} 服务端版本较旧，驱动的 Thin 模式连不上：需要 Oracle Instant Client（Thick 模式）。放到项目 .data/oracle-client/ 下，或用 ORACLE_CLIENT_LIB_DIR 指向它的目录${oracleClientState?.error ? `（当前探测失败：${oracleClientState.error}）` : ""}。`;
  }
  if (/NJS-118/i.test(message)) return `${info.label} 的连接模式已经锁在 Thin：需要重启服务后再连（oracledb 一旦建过连接就不能切模式）。`;
  if (/password|authentication|ORA-01017|access denied/i.test(message)) return `${info.label} 认证失败，请检查用户名与密码。`;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|ORA-12541|ORA-12154|NJS-503/i.test(message)) return `连不上 ${info.label}：${message}`;
  return `连接 ${info.label} 失败：${message}`;
}

/** Instant Client 的目录从哪来：环境变量优先，其次是项目内、再是常见安装位置。 */
export function defaultOracleClientCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  return [env.ORACLE_CLIENT_LIB_DIR ?? "", join(cwd, ".data", "oracle-client"), "C:\\oracle", "C:\\instantclient", join(homedir(), "oracle")].filter(Boolean);
}

/** 找到一个真正含客户端库的目录；也允许给上一级目录，里面平铺着 instantclient_23_0 这种子目录。 */
export function resolveOracleClientDir(candidates: string[] = defaultOracleClientCandidates()) {
  const hasClient = (dir: string) => existsSync(join(dir, "oci.dll")) || existsSync(join(dir, "libclntsh.so"));
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (hasClient(candidate)) return candidate;
    try {
      for (const entry of readdirSync(candidate, { withFileTypes: true })) {
        const nested = join(candidate, entry.name);
        if (entry.isDirectory() && hasClient(nested)) return nested;
      }
    } catch {
      // 目录读不了就换下一个候选
    }
  }
  return "";
}

let oracleClientState: { ready: boolean; libDir: string; error?: string } | undefined;
let oracleClientPromise: Promise<{ ready: boolean; libDir: string; error?: string }> | undefined;

/**
 * 让 oracledb 进入 Thick 模式。
 *
 * initOracleClient 一个进程只能调用一次，所以做成幂等；没找到客户端时不报错，
 * 让连接照常按 Thin 模式走 —— 连不上旧服务端时上面的错误信息会告诉用户缺什么。
 */
export async function ensureOracleClient() {
  oracleClientPromise ??= (async () => {
    const libDir = resolveOracleClientDir();
    if (!libDir) {
      oracleClientState = { ready: false, libDir: "", error: "没有找到 Instant Client 目录" };
      return oracleClientState;
    }
    try {
      const loaded = (await import("oracledb")) as unknown as { default?: { initOracleClient?: (options?: { libDir?: string }) => void }; initOracleClient?: (options?: { libDir?: string }) => void };
      const oracledb = loaded.default ?? loaded;
      oracledb.initOracleClient?.({ libDir });
      oracleClientState = { ready: true, libDir };
    } catch (error) {
      oracleClientState = { ready: false, libDir, error: error instanceof Error ? error.message : String(error) };
    }
    return oracleClientState;
  })();
  return oracleClientPromise;
}

/** 连接一次、干一件事、断开：管理界面是低频操作，按需连接不会因为某个来源挂掉拖住别的来源。 */
async function withConnection<T>(
  kind: DataSourceKind,
  record: DataSourceRecord,
  credentials: DataSourceCredentials,
  job: (info: DataSourceKindInfo, connection: DataSource) => Promise<T>,
): Promise<T> {
  const info = dataSourceKindInfo(kind);
  const connection = new DataSource(buildConnectionOptions(kind, record, credentials));
  try {
    await connection.initialize();
  } catch (error) {
    throw new Error(describeConnectionError(info, error));
  }
  try {
    return await job(info, connection);
  } finally {
    await connection.destroy().catch(() => undefined);
  }
}

/** 每种库"哪些对象是视图"的问法；表与列由 ORM 出。 */
const VIEW_CATALOG: Record<DataSourceKind, ((container: string) => string) | null> = {
  POSTGRES: (container) => `SELECT table_name AS name FROM information_schema.views WHERE table_schema = ${quoteLiteral(container)} UNION SELECT matviewname AS name FROM pg_matviews WHERE schemaname = ${quoteLiteral(container)}`,
  MYSQL: (container) => `SELECT table_name AS name FROM information_schema.views WHERE table_schema = ${quoteLiteral(container)}`,
  ORACLE: null,
};

function viewNames(rows: unknown) {
  const list = (Array.isArray(rows) ? rows : []) as Record<string, unknown>[];
  return new Set(list.map((row) => String(row.name ?? row.NAME ?? "").toLowerCase()).filter(Boolean));
}

/** ORM 策略：PostgreSQL / MySQL。 */
async function readCatalogFromOrm(connection: DataSource, kind: DataSourceKind, container: string): Promise<CatalogObject[]> {
  const runner = connection.createQueryRunner();
  try {
    const tables = await runner.getTables();
    const catalog = VIEW_CATALOG[kind];
    const views = catalog ? viewNames(await runner.query(catalog(container)).catch(() => [])) : new Set<string>();
    return tables.map((table) => {
      const schema = table.schema ?? container;
      // PostgreSQL 驱动会把非当前 schema 的对象名写成 "schema.table"，这里统一剥成裸名。
      const name = table.name.toLowerCase().startsWith(`${schema.toLowerCase()}.`) ? table.name.slice(schema.length + 1) : table.name;
      return { schema, name, kind: views.has(name.toLowerCase()) ? "view" as const : "table" as const, comment: table.comment ?? "", columnCount: table.columns?.length ?? 0 };
    });
  } finally {
    await runner.release();
  }
}

/**
 * Oracle 策略：直接读数据字典。
 * all_tables / all_views 给对象，all_tab_columns 给列与主键 —— 不再经过 ORM 的 getTables。
 */
async function readCatalogFromOracle(connection: DataSource, container: string): Promise<CatalogObject[]> {
  const owner = quoteLiteral(container);
  // 10g 起 comment 就是保留字，别名与引用一律加双引号，免得撞上关键字。
  const rows = (await connection.query(`
    SELECT o."object_kind", o."object_name", o."remarks", NVL(c."column_total", 0) AS "column_total"
      FROM (
        SELECT 'table' AS "object_kind", t.table_name AS "object_name", tc.comments AS "remarks"
          FROM all_tables t
          LEFT JOIN all_tab_comments tc ON tc.owner = t.owner AND tc.table_name = t.table_name
         WHERE UPPER(t.owner) = UPPER(${owner})
        UNION ALL
        SELECT 'view' AS "object_kind", v.view_name AS "object_name", NULL AS "remarks"
          FROM all_views v
         WHERE UPPER(v.owner) = UPPER(${owner})
      ) o
      LEFT JOIN (
        SELECT table_name AS "column_table", COUNT(*) AS "column_total"
          FROM all_tab_columns WHERE UPPER(owner) = UPPER(${owner}) GROUP BY table_name
      ) c ON UPPER(c."column_table") = UPPER(o."object_name")
     ORDER BY o."object_kind", o."object_name"`)) as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    schema: container,
    name: String(row.object_name ?? row.OBJECT_NAME ?? ""),
    kind: String(row.object_kind ?? row.OBJECT_KIND ?? "table").toLowerCase() === "view" ? "view" as const : "table" as const,
    comment: String(row.remarks ?? row.REMARKS ?? ""),
    columnCount: Number(row.column_total ?? row.COLUMN_TOTAL ?? 0),
  }));
}

/** Oracle 的列信息：类型、可空、主键、注释、顺序，一次问全。 */
async function readColumnsFromOracle(connection: DataSource, container: string, objectName: string) {
  const owner = quoteLiteral(container);
  const name = quoteLiteral(objectName);
  const rows = (await connection.query(`
    SELECT c.column_name AS "name", c.data_type AS "type", c.nullable AS "nullable", c.column_id AS "position",
           cc.comments AS "comment",
           CASE WHEN pk.column_name IS NULL THEN 0 ELSE 1 END AS "is_primary"
      FROM all_tab_columns c
      LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
      LEFT JOIN (
        SELECT ac.owner, ac.table_name, acc.column_name
          FROM all_constraints ac
          JOIN all_cons_columns acc ON acc.owner = ac.owner AND acc.constraint_name = ac.constraint_name
         WHERE ac.constraint_type = 'P'
      ) pk ON pk.owner = c.owner AND pk.table_name = c.table_name AND pk.column_name = c.column_name
     WHERE UPPER(c.owner) = UPPER(${owner}) AND UPPER(c.table_name) = UPPER(${name})
     ORDER BY c.column_id`)) as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : []).map((row, index) => ({
    name: String(row.name ?? row.NAME ?? ""),
    dataType: String(row.type ?? row.TYPE ?? ""),
    nullable: String(row.nullable ?? row.NULLABLE ?? "Y").toUpperCase() === "Y",
    primaryKey: Number(row.is_primary ?? row.IS_PRIMARY ?? 0) === 1,
    // 唯一约束要再连一张字典表，管理界面暂时只标主键，不猜。
    unique: false,
    comment: String(row.comment ?? row.COMMENT ?? ""),
    position: Number(row.position ?? row.POSITION ?? index + 1),
  }));
}

export async function createSqlConnector(kind: DataSourceKind, record: DataSourceRecord, credentials: DataSourceCredentials): Promise<DataSourceConnector> {
  const container = resolveContainer(kind, record);
  // Oracle 旧版本必须走 Thick 模式：在建连接之前先把 Instant Client 装上（幂等）。
  if (kind === "ORACLE") await ensureOracleClient();

  const readCatalog = (connection: DataSource) => kind === "ORACLE"
    ? readCatalogFromOracle(connection, container)
    : readCatalogFromOrm(connection, kind, container);

  const readColumns = async (connection: DataSource, objectName: string): Promise<DataViewField[]> => {
    if (kind === "ORACLE") return readColumnsFromOracle(connection, container, objectName);
    const runner = connection.createQueryRunner();
    try {
      const table = (await runner.getTables()).find((item) => item.name.split(".").pop()?.toLowerCase() === objectName.toLowerCase());
      if (!table) throw new Error(`数据源里没有表或视图「${objectName}」。`);
      return table.columns.map((column, index) => ({
        name: column.name,
        dataType: column.type ?? "",
        nullable: column.isNullable,
        primaryKey: column.isPrimary,
        unique: column.isUnique,
        comment: column.comment ?? "",
        position: index + 1,
      }));
    } finally {
      await runner.release();
    }
  };

  return {
    async test(): Promise<DataSourceHealth> {
      return withConnection(kind, record, credentials, async (info, connection) => {
        const agent = await describeAgent(connection, kind);
        return { connected: true, agent, container, detail: info.connectionExample };
      });
    },

    async listViews(options = {}): Promise<DataViewSummary[]> {
      return withConnection(kind, record, credentials, async (_info, connection) => {
        const catalog = await readCatalog(connection);
        // 登记时填了容器就以它为默认范围；看全库传 "*" —— 界面上的「全部模式」就是这个值。
        const scope = options.schema === "*" ? "" : options.schema ?? (kind === "MYSQL" ? "" : container);
        const needle = options.search?.trim().toLowerCase();
        return catalog
          .filter((item) => !scope || item.schema.toLowerCase() === scope.toLowerCase())
          .filter((item) => !needle || item.name.toLowerCase().includes(needle))
          .sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "table" ? -1 : 1)
          .slice(0, clampLimit(options.limit ?? 500, VIEW_LIMIT_MAX, 500));
      });
    },

    async describeView(view: DataViewRef): Promise<DataViewField[]> {
      return withConnection(kind, record, credentials, async (_info, connection) => {
        const catalog = await readCatalog(connection);
        const hit = catalog.find((item) => item.name.toLowerCase() === view.name.toLowerCase());
        if (!hit) throw new Error(`数据源里没有表或视图「${view.name}」。`);
        return readColumns(connection, hit.name);
      });
    },

    async previewView(view: DataViewRef, limit: number): Promise<DataViewPreview> {
      const rows = clampLimit(limit);
      return withConnection(kind, record, credentials, async (_info, connection) => {
        // 先确认对象确实存在，再拿库自己的名字去拼语句：
        // 预览语句里的标识符只可能来自库的元数据，不接受调用方传来的任意字符串。
        const catalog = await readCatalog(connection);
        const hit = catalog.find((item) => item.name.toLowerCase() === view.name.toLowerCase());
        if (!hit) throw new Error(`数据源里没有表或视图「${view.name}」。`);
        const statement = previewStatement(kind, hit.schema || undefined, hit.name, rows);
        const raw = await connection.query(statement);
        const list = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
        return {
          columns: list.length ? Object.keys(list[0]) : [],
          rows: list.map(normalizeRow),
          truncated: list.length >= rows,
        };
      });
    },
  };
}

/** 服务端自报的版本串；取不到就只报连接成功，不编造版本号。 */
async function describeAgent(connection: DataSource, kind: DataSourceKind) {
  const probe = kind === "ORACLE" ? "SELECT banner AS version FROM v$version WHERE ROWNUM = 1" : "SELECT version() AS version";
  try {
    const rows = (await connection.query(probe)) as Record<string, unknown>[];
    const raw = rows?.[0]?.version;
    if (typeof raw === "string" && raw.trim()) return raw.trim().split(" on ")[0].trim();
  } catch {
    // v$version 需要权限；拿不到不影响连接是否可用。
  }
  return dataSourceKindInfo(kind).label;
}
