import { createSqlConnector, type DataSourceCredentials } from "@/lib/data-source/sql";
import { isDataSourceKind, type DataSourceConnector, type DataSourceRecord } from "@/lib/data-source/types";

export * from "@/lib/data-source/types";

/**
 * 数据来源注册表。
 *
 * 上层只调用 openDataSourceConnector(record, credentials)，不关心底层是关系库还是别的什么。
 * 接入一类新来源：在 types.ts 登记 kind 与元数据，然后在这里加一个分支 ——
 * 界面、API、平台表都不用动。
 *
 * 注意：本模块会引入具体驱动（typeorm / pg / mysql2 / oracledb），只能在服务端使用；
 * 客户端请引用 @/lib/data-source/types 里的纯类型与元数据。
 */
export function openDataSourceConnector(record: DataSourceRecord, credentials: DataSourceCredentials): Promise<DataSourceConnector> {
  const kind = isDataSourceKind(record.kind) ? record.kind : "POSTGRES";
  // 目前登记的三类都是关系库，共用同一份 SQL 实现；接入 ES / 接口 / 文件时在这里分流。
  return createSqlConnector(kind, { ...record, kind }, credentials);
}
