/** 平台支持的外部数据资源类型。客户端、迁移和适配器共用这一份枚举。 */
export const DATA_SOURCE_KIND_VALUES = ["POSTGRES", "MYSQL", "ORACLE"] as const;

export type DataSourceKind = (typeof DATA_SOURCE_KIND_VALUES)[number];

/** 行级过滤条件；数据源连接器与 SQL 编译器共用的纯契约。 */
export type DataSourceRowFilter = {
  column: string;
  operator: "EQ" | "NE" | "CONTAINS" | "IN";
  value: string | number | boolean | string[];
};
