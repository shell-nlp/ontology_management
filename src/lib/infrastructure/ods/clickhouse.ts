import { createHash } from "node:crypto";
import { clickHouseConfig } from "@/lib/infrastructure/clickhouse/config";
import { clickHouseExecute, clickHouseQuery, type ClickHouseParams } from "@/lib/infrastructure/clickhouse/client";
import { odsTableName } from "@/lib/infrastructure/ods/naming";
import type { DataSourceRowFilter, DataSourceRowSort } from "@/lib/shared/common/data-source-kind";
import type { OdsColumn, OdsReadQuery, OdsReadResult, OdsStore, OdsTableSpec } from "@/lib/infrastructure/ods/types";

const INSERT_CHUNK_ROWS = 1000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quote(name: string) {
  if (!name.trim()) throw new Error("ODS 标识符不能为空。");
  return `\`${name.replace(/`/g, "``")}\``;
}

function safeDatabase() {
  const { database } = clickHouseConfig();
  if (!IDENTIFIER.test(database)) throw new Error(`ClickHouse 数据库名不合法：${database}`);
  return database;
}

function tableRef(table: string) {
  if (!IDENTIFIER.test(table)) throw new Error(`ODS 表名不合法：${table}`);
  return `${safeDatabase()}.${table}`;
}

export { odsTableName } from "@/lib/infrastructure/ods/naming";

/** 把源库字段类型收敛成 ClickHouse 可存储、可比较的保守类型。 */
export function clickHouseTypeFor(sourceType: string, sourceKind?: string) {
  const type = sourceType.trim().toUpperCase();
  if (/^(BOOLEAN|BOOL|BIT)$/.test(type)) return "UInt8";
  const decimal = type.match(/^(?:NUMBER|NUMERIC|DECIMAL|DEC)\((\d+),\s*(\d+)\)/);
  if (decimal && Number(decimal[1]) <= 76 && Number(decimal[2]) <= Number(decimal[1])) return `Decimal(${Number(decimal[1])}, ${Number(decimal[2])})`;
  if (/^(TINYINT|SMALLINT|MEDIUMINT|INTEGER|INT|BIGINT|NUMBER\([0-9]+\)|NUMERIC\([0-9]+\))/.test(type) && !/,[1-9]/.test(type)) return "Int64";
  if (/^(NUMBER|NUMERIC|DECIMAL|DEC|REAL|FLOAT|DOUBLE)/.test(type)) return "Float64";
  if (/^DATE$/.test(type)) return sourceKind === "ORACLE" ? "DateTime64(3, 'UTC')" : "Date";
  if (/TIMESTAMP|DATETIME|DATE TIME/.test(type)) return "DateTime64(3, 'UTC')";
  return "String";
}

export function odsCreateTableStatement(
  databaseTable: string,
  columns: OdsColumn[],
  mode: "LIVE" | "STAGE" = "LIVE",
  origin?: Pick<OdsTableSpec, "sourceSchema" | "sourceTable">,
) {
  const comment = (text: string) => `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const sourceName = origin?.sourceTable
    ? `${origin.sourceSchema ? `${origin.sourceSchema}.` : ""}${origin.sourceTable}`
    : "";
  const tableComment = sourceName
    ? `${sourceName} 的 ODS 派生镜像；按主键去重，可重建，不保存本体版本实例`
    : "源表派生镜像，按源主键去重，不保存本体版本实例";
  const lines = [
    "`_source_id` String COMMENT 'ODS 配置标识'",
    "`_row_key` String COMMENT '完整源主键值生成的稳定行键'",
    "`_source_updated_at` DateTime64(3, 'UTC') COMMENT '当前镜像行写入时间'",
    "`_sync_batch` UInt64 COMMENT '同步批次标识'",
    "`_is_deleted` UInt8 DEFAULT 0 COMMENT '删除标记：0 正常，1 删除'",
    ...columns.map((column) => `${quote(column.name)} Nullable(${column.clickhouseType}) COMMENT ${comment(column.comment || `源业务列 ${column.name}，类型 ${column.sourceType}`)}`),
  ];
  const engine = mode === "STAGE"
    ? "MergeTree ORDER BY (_source_id, _row_key)"
    : "ReplacingMergeTree(_source_updated_at, _is_deleted) ORDER BY (_source_id, _row_key)";
  return `CREATE TABLE IF NOT EXISTS ${databaseTable} (${lines.join(", ")}) ENGINE=${engine} COMMENT ${comment(tableComment)}`;
}

function normalizeValue(value: unknown, column?: OdsColumn): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (column?.clickhouseType === "UInt8" && typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function rowKey(spec: OdsTableSpec, row: Record<string, unknown>) {
  const byLower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  const columns = spec.primaryKeyColumns.length ? spec.primaryKeyColumns : spec.columns.map((column) => column.name);
  const values = columns.map((column) => normalizeValue(byLower.get(column.toLowerCase())));
  if (spec.primaryKeyColumns.length && values.some((value) => value === null || value === "")) {
    throw new Error(`源行主键不完整（${spec.primaryKeyColumns.join(", ")}），ODS 拒绝静默丢弃。`);
  }
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

function rowForInsert(spec: OdsTableSpec, sourceId: string, batchId: number, row: Record<string, unknown>) {
  const byLower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  const record: Record<string, unknown> = {
    _source_id: sourceId,
    _row_key: rowKey(spec, row),
    _source_updated_at: new Date().toISOString(),
    _sync_batch: batchId,
    _is_deleted: 0,
  };
  for (const column of spec.columns) record[column.name] = normalizeValue(byLower.get(column.name.toLowerCase()), column);
  return record;
}

async function insertRows(table: string, spec: OdsTableSpec, batchId: number, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const body = rows.map((row) => JSON.stringify(rowForInsert(spec, spec.sourceId, batchId, row))).join("\n");
  await clickHouseExecute(`INSERT INTO ${tableRef(table)} FORMAT JSONEachRow\n${body}`, {
    raw: true,
    settings: { date_time_input_format: "best_effort", input_format_null_as_default: "1" },
  });
}

async function writeStream(input: {
  spec: OdsTableSpec;
  rows: AsyncIterable<Record<string, unknown>>;
  batchId: number;
  targetTable: string;
  onProgress?: (progress: { scanned: number; rows: number; pages: number }) => void | Promise<void>;
}) {
  let scanned = 0;
  let written = 0;
  let pages = 0;
  let buffer: Record<string, unknown>[] = [];
  for await (const row of input.rows) {
    scanned += 1;
    buffer.push(row);
    if (buffer.length >= INSERT_CHUNK_ROWS) {
      await insertRows(input.targetTable, input.spec, input.batchId, buffer);
      written += buffer.length;
      pages += 1;
      buffer = [];
      await input.onProgress?.({ scanned, rows: written, pages });
    }
  }
  if (buffer.length) {
    await insertRows(input.targetTable, input.spec, input.batchId, buffer);
    written += buffer.length;
    pages += 1;
    await input.onProgress?.({ scanned, rows: written, pages });
  }
  return { rows: written, pages };
}

function filterSql(filter: DataSourceRowFilter, params: ClickHouseParams, name: (prefix: string) => string) {
  const column = quote(filter.column);
  if (filter.operator === "EXISTS") return `${column} IS NOT NULL`;
  if (filter.operator === "IN") {
    const values = (Array.isArray(filter.value) ? filter.value : [filter.value]).filter((value) => value !== undefined).slice(0, 200);
    if (!values.length) return "1 = 0";
    return values.map((value) => {
      const key = name("in");
      params[key] = String(value ?? "");
      return `toString(${column}) = {${key}:String}`;
    }).join(" OR ") || "1 = 0";
  }
  if (filter.operator === "CONTAINS") {
    const key = name("contains");
    params[key] = String(filter.value ?? "");
    return `position(toString(${column}), {${key}:String}) > 0`;
  }
  if (filter.operator === "GT" || filter.operator === "GTE" || filter.operator === "LT") {
    const key = name("bound");
    params[key] = String(filter.value ?? "");
    return `toFloat64OrNull(toString(${column})) ${filter.operator === "GT" ? ">" : filter.operator === "GTE" ? ">=" : "<"} toFloat64OrNull({${key}:String})`;
  }
  const key = name("eq");
  params[key] = String(filter.value ?? "");
  return `toString(${column}) ${filter.operator === "NE" ? "!=" : "="} {${key}:String}`;
}

export function createClickHouseOdsStore(): OdsStore {
  return {
    kind: "CLICKHOUSE",

    async writeFull(input) {
      const live = tableRef(input.spec.tableName);
      const stageName = `${input.spec.tableName}__stage_${input.batchId}`.slice(0, 120);
      const stage = tableRef(stageName);
      const nextName = `${input.spec.tableName}__next_${input.batchId}`.slice(0, 120);
      const next = tableRef(nextName);
      await clickHouseExecute(odsCreateTableStatement(live, input.spec.columns, "LIVE", input.spec));
      await clickHouseExecute(odsCreateTableStatement(next, input.spec.columns, "LIVE", input.spec));
      await clickHouseExecute(`DROP TABLE IF EXISTS ${stage}`);
      await clickHouseExecute(odsCreateTableStatement(stage, input.spec.columns, "STAGE", input.spec));
      try {
        const result = await writeStream({ spec: input.spec, rows: input.rows, batchId: input.batchId, targetTable: stageName, onProgress: input.onProgress });
        const selectedColumns = input.spec.columns.map((column) => quote(column.name)).join(", ");
        const keyColumns = input.spec.primaryKeyColumns.map((column) => quote(column)).join(", ");
        const duplicateGroups = await clickHouseQuery<Record<string, unknown>>(
          `SELECT ${keyColumns}, count() AS total, uniqExact(tuple(${selectedColumns})) AS variants
             FROM ${stage}
            GROUP BY ${input.spec.primaryKeyColumns.map((column) => quote(column)).join(", ")}
           HAVING count() > 1
            LIMIT 100000`,
        );
        const conflicting = duplicateGroups.filter((row) => Number(row.variants ?? 0) > 1);
        if (conflicting.length) {
          const samples = conflicting.slice(0, 3).map((row) => input.spec.primaryKeyColumns.map((column) => `${column}=${String(row[column] ?? "")}`).join(" / ")).join("；");
          throw new Error(`源表主键不唯一：同一主键下存在业务列值不同的 ${conflicting.length.toLocaleString()} 组记录（${samples}）。不能安全折叠，请补充主键列或先在源视图去重；本次不替换线上 ODS。`);
        }
        const identicalDuplicates = duplicateGroups.reduce((total, row) => total + Math.max(0, Number(row.total ?? 0) - 1), 0);
        await clickHouseExecute(`INSERT INTO ${next} SELECT * FROM ${stage}`);
        const counts = await clickHouseQuery<{ total: number }>(`SELECT count() AS total FROM ${next} FINAL`);
        const stored = Number(counts[0]?.total ?? 0);
        const expected = result.rows - identicalDuplicates;
        if (stored !== expected) {
          throw new Error(`源表行键校验失败：读取 ${result.rows} 行，完全相同重复 ${identicalDuplicates} 行，预期镜像 ${expected} 行，实际 ${stored} 行；本次不替换线上 ODS。`);
        }
        await clickHouseExecute(`EXCHANGE TABLES ${live} AND ${next}`);
        const warnings = identicalDuplicates > 0
          ? [`源表有 ${identicalDuplicates.toLocaleString()} 行与另一行在本次同步的 ${input.spec.columns.length} 个业务列上完全相同，已按一条镜像保存；对象查询不会重复计数。`]
          : [];
        await clickHouseExecute(`DROP TABLE IF EXISTS ${stage}`);
        await clickHouseExecute(`DROP TABLE IF EXISTS ${next}`);
        return { ...result, storedRows: stored, warnings };
      } catch (error) {
        await clickHouseExecute(`DROP TABLE IF EXISTS ${stage}`).catch(() => undefined);
        await clickHouseExecute(`DROP TABLE IF EXISTS ${next}`).catch(() => undefined);
        throw error;
      }
    },

    async writeIncremental(input) {
      const live = tableRef(input.spec.tableName);
      await clickHouseExecute(odsCreateTableStatement(live, input.spec.columns, "LIVE", input.spec));
      const result = await writeStream({ spec: input.spec, rows: input.rows, batchId: input.batchId, targetTable: input.spec.tableName, onProgress: input.onProgress });
      return { ...result, storedRows: result.rows, warnings: [] };
    },

    async read(query: OdsReadQuery): Promise<OdsReadResult> {
      const table = tableRef(query.tableName);
      const params: ClickHouseParams = { source: query.sourceId };
      let seq = 0;
      const name = (prefix: string) => `${prefix}${(seq += 1)}`;
      const conditions = ["_source_id = {source:String}", "_is_deleted = 0"];
      for (const filter of query.filters) conditions.push(`(${filterSql(filter, params, name)})`);
      if (query.keyGroups) conditions.push(query.keyGroups.length ? `(${query.keyGroups.map((group) => `(${group.map((key) => filterSql(key, params, name)).join(" AND ")})`).join(" OR ")})` : "1 = 0");
      const text = query.search?.text.trim() ?? "";
      const searchColumns = (query.search?.columns ?? []).filter((column) => column.trim());
      if (text && searchColumns.length) {
        const key = name("search");
        params[key] = text;
        conditions.push(`(${searchColumns.map((column) => `positionCaseInsensitive(toString(${quote(column)}), {${key}:String}) > 0`).join(" OR ")})`);
      }
      if (!query.columns.length) throw new Error("ODS 查询至少要选一列。");
      const select = query.columns.map(quote).join(", ");
      const order = (query.sort ?? []).filter((item) => item.column.trim()).map((item) => `${quote(item.column)} ${item.direction ?? "ASC"}`).join(", ");
      const limit = Math.min(20000, Math.max(1, Math.floor(query.limit)));
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      const where = conditions.join(" AND ");
      const statement = `SELECT ${select} FROM ${table} FINAL WHERE ${where}${order ? ` ORDER BY ${order}` : ""} LIMIT ${limit + 1} OFFSET ${offset}`;
      const [rows, counts] = await Promise.all([
        clickHouseQuery<Record<string, unknown>>(statement, { params }),
        query.count === false ? Promise.resolve(null) : clickHouseQuery<{ total: number }>(`SELECT count() AS total FROM ${table} FINAL WHERE ${where}`, { params }),
      ]);
      return {
        columns: query.columns,
        rows: rows.slice(0, limit),
        total: counts === null ? null : Number(counts[0]?.total ?? 0),
        truncated: rows.length > limit,
        statement,
      };
    },

    async count(spec) {
      const rows = await clickHouseQuery<{ total: number }>(`SELECT count() AS total FROM ${tableRef(spec.tableName)} FINAL WHERE _source_id = {source:String}`, {
        params: { source: spec.sourceId },
      });
      return Number(rows[0]?.total ?? 0);
    },

    async drop(sourceId, tableName) {
      void sourceId;
      await clickHouseExecute(`DROP TABLE IF EXISTS ${tableRef(tableName)}`);
    },
  };
}
