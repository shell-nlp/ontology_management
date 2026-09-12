import { openDataSourceConnector } from "@/lib/data-source";
import {
  dataSourceKindInfo,
  isDataSourceKind,
  type DataSourceConnector,
  type DataSourceKind,
  type DataSourceRecord,
  type PublicDataSource,
} from "@/lib/data-source/types";
import { decryptSecret } from "@/lib/crypto";
import { platformQuery } from "@/lib/platform-db";

const COLUMNS = `id, name, kind, host, port, database_name, schema_name, username, credential_secret, options, enabled, created_at`;

export async function listDataSources(): Promise<DataSourceRecord[]> {
  const result = await platformQuery<DataSourceRecord>(
    `SELECT ${COLUMNS} FROM ontology_platform.data_sources ORDER BY kind, name`,
  );
  return result.rows.map(normalizeRecord);
}

export async function getDataSource(sourceId: string): Promise<DataSourceRecord | null> {
  const result = await platformQuery<DataSourceRecord>(
    `SELECT ${COLUMNS} FROM ontology_platform.data_sources WHERE id = $1`,
    [sourceId],
  );
  const row = result.rows[0];
  return row ? normalizeRecord(row) : null;
}

export function normalizeRecord(row: DataSourceRecord): DataSourceRecord {
  return {
    ...row,
    kind: normalizeDataSourceKind(row.kind),
    port: Number(row.port) || dataSourceKindInfo(normalizeDataSourceKind(row.kind)).defaultPort,
    options: parseDataSourceOptions(row.options),
  };
}

export function normalizeDataSourceKind(value: unknown): DataSourceKind {
  return isDataSourceKind(value) ? value : "POSTGRES";
}

export function parseDataSourceOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item)),
  );
}

/** 连接串只用于展示：用户名保留、密码永远是掩码，让人一眼看出连的是哪个库。 */
export function dataSourceAddress(record: Pick<DataSourceRecord, "kind" | "host" | "port" | "database_name" | "schema_name" | "username">) {
  const protocol = record.kind === "MYSQL" ? "mysql" : record.kind === "ORACLE" ? "oracle" : "postgresql";
  const user = record.username ? `${record.username}@` : "";
  const base = `${protocol}://${user}${record.host}:${record.port}/${record.database_name}`;
  return record.schema_name ? `${base}（模式 ${record.schema_name}）` : base;
}

/** 交给前端的形状：绝不包含密文。 */
export function publicDataSource(record: DataSourceRecord): PublicDataSource {
  const info = dataSourceKindInfo(record.kind);
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    kindLabel: info.label,
    modelLabel: info.modelLabel,
    host: record.host,
    port: record.port,
    databaseName: record.database_name,
    schemaName: record.schema_name,
    username: record.username,
    options: record.options,
    enabled: record.enabled,
    createdAt: record.created_at,
    address: dataSourceAddress(record),
  };
}

/** 取出明文密码；只在服务端用于建立连接。 */
export function dataSourcePassword(record: DataSourceRecord) {
  if (!record.credential_secret) return "";
  try {
    return decryptSecret(record.credential_secret);
  } catch {
    throw new Error("这个数据源的凭据无法解密，请重新填写密码。");
  }
}

/** 按记录开一个只读连接器；调用方用完即可丢弃，连接器每次操作自建连接。 */
export function openDataSource(record: DataSourceRecord): Promise<DataSourceConnector> {
  return openDataSourceConnector(record, { username: record.username, password: dataSourcePassword(record) });
}
