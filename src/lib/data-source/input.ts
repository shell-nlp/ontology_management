import { z } from "zod";

import { DATA_SOURCE_KINDS, dataSourceKindInfo } from "@/lib/data-source/types";

/** 连接表单的请求体：三种关系库共用一份，字段标签由元数据决定。 */
export const dataSourceInput = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(DATA_SOURCE_KINDS.map((item) => item.kind) as [string, ...string[]]).default("POSTGRES"),
  host: z.string().trim().min(1).max(200),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  /** PostgreSQL / MySQL 是库名；Oracle 是服务名。 */
  databaseName: z.string().trim().min(1).max(200),
  /** PostgreSQL 的 schema、Oracle 的模式；MySQL 留空（库名即容器）。 */
  schemaName: z.string().trim().max(200).default(""),
  username: z.string().trim().min(1).max(200),
  password: z.string().max(500).default(""),
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.unknown()).default({}),
});

export const dataSourcePatch = dataSourceInput.partial().extend({ password: z.string().max(500).optional() });

export type DataSourceInput = z.infer<typeof dataSourceInput>;

/** 没填端口时按类型补默认端口：5432 / 3306 / 1521。 */
export function resolvePort(kind: string, port: number | undefined) {
  if (port && port > 0) return port;
  const info = DATA_SOURCE_KINDS.find((item) => item.kind === kind) ?? DATA_SOURCE_KINDS[0];
  return info.defaultPort;
}

/** 按 kind 取类型名；kind 不合法时退回第一种，避免报错信息里出现 undefined。 */
export function sourceKindLabel(kind: string) {
  const info = DATA_SOURCE_KINDS.find((item) => item.kind === kind) ?? DATA_SOURCE_KINDS[0];
  return dataSourceKindInfo(info.kind).label;
}
