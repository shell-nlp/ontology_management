/**
 * 数据资源抽象层。
 *
 * 这一层只回答一件事：一个"能列出结构、能读字段、能看几行数据"的外部来源长什么样。
 * 图数据库不在其中 —— 它是本体自己的存储（见 @/lib/graph），不是外部数据来源。
 *
 * 分工与 @/lib/graph 一致：本文件是纯类型与元数据，客户端可以直接引用；
 * 真正引入驱动的注册表在 @/lib/data-source/index.ts，只能在服务端使用。
 * 接入一种新数据库 = 这里登记类型与元数据 + 注册表加一个分支，界面不用改。
 */

export type DataSourceKind = "POSTGRES" | "MYSQL" | "ORACLE";

/** 类型卡片上的图形：每个都画这种库自己的数据模型，而不是通用数据库图标。 */
export type DataSourceMark = "rows" | "grid" | "table";

export type DataSourceFieldKey = "host" | "port" | "databaseName" | "schemaName" | "username" | "password";

/** 连接表单的一个字段。表单顺序就是数组顺序，所以新增类型不需要动界面代码。 */
export type DataSourceField = {
  key: DataSourceFieldKey;
  label: string;
  placeholder: string;
  example: string;
  required: boolean;
  input: "text" | "number" | "password";
  /** 端口这类数值字段的兜底值。 */
  fallback?: string;
};

export type DataSourceKindInfo = {
  kind: DataSourceKind;
  label: string;
  shortLabel: string;
  description: string;
  /** 数据模型的一句话说法，用在卡片的能力行。 */
  modelLabel: string;
  accent: string;
  mark: DataSourceMark;
  /** TypeORM 的 type 值：接入新关系库通常只改这一行。 */
  ormType: "postgres" | "mysql" | "oracle";
  /** 运行时需要的驱动包名，缺失时错误信息要指名道姓。 */
  driverPackage: string;
  defaultPort: number;
  connectionExample: string;
  /** 表/视图所在的容器怎么称呼：PG 叫模式，MySQL 叫库，Oracle 叫模式。 */
  containerLabel: string;
  containerPlaceholder: string;
  containerRequired: boolean;
  fields: DataSourceField[];
};

const host: DataSourceField = { key: "host", label: "主机", placeholder: "db.internal", example: "127.0.0.1", required: true, input: "text" };
const username: DataSourceField = { key: "username", label: "用户名", placeholder: "只读账号更安全", example: "reader", required: true, input: "text" };
const password: DataSourceField = { key: "password", label: "密码", placeholder: "加密保存", example: "", required: true, input: "password" };

export const DATA_SOURCE_KINDS: DataSourceKindInfo[] = [
  {
    kind: "POSTGRES",
    label: "PostgreSQL",
    shortLabel: "PG",
    description: "关系库里最常见的一种：模式 + 表 + 列，支持视图与物化视图。",
    modelLabel: "关系表",
    accent: "#0b84d8",
    mark: "rows",
    ormType: "postgres",
    driverPackage: "pg",
    defaultPort: 5432,
    connectionExample: "postgresql://reader@db.internal:5432/warehouse",
    containerLabel: "模式（schema）",
    containerPlaceholder: "public",
    containerRequired: false,
    fields: [
      host,
      { key: "port", label: "端口", placeholder: "5432", example: "5432", required: true, input: "number", fallback: "5432" },
      { key: "databaseName", label: "数据库", placeholder: "warehouse", example: "warehouse", required: true, input: "text" },
      { key: "schemaName", label: "模式（schema）", placeholder: "public", example: "public", required: false, input: "text" },
      username,
      password,
    ],
  },
  {
    kind: "MYSQL",
    label: "MySQL",
    shortLabel: "MySQL",
    description: "库名即容器：一个连接看一个库里的表与视图，兼容 MariaDB。",
    modelLabel: "关系表",
    accent: "#0f766e",
    mark: "grid",
    ormType: "mysql",
    driverPackage: "mysql2",
    defaultPort: 3306,
    connectionExample: "mysql://reader@db.internal:3306/warehouse",
    containerLabel: "库（database）",
    containerPlaceholder: "warehouse",
    containerRequired: true,
    fields: [
      host,
      { key: "port", label: "端口", placeholder: "3306", example: "3306", required: true, input: "number", fallback: "3306" },
      { key: "databaseName", label: "数据库", placeholder: "warehouse", example: "warehouse", required: true, input: "text" },
      username,
      password,
    ],
  },
  {
    kind: "ORACLE",
    label: "Oracle",
    shortLabel: "Oracle",
    description: "以服务名连接，模式即用户；表与视图挂在模式下面。",
    modelLabel: "关系表",
    accent: "#b45309",
    mark: "table",
    ormType: "oracle",
    driverPackage: "oracledb",
    defaultPort: 1521,
    connectionExample: "oracle://reader@db.internal:1521/ORCLPDB1",
    containerLabel: "模式（schema / 用户）",
    containerPlaceholder: "留空表示用连接用户的模式",
    containerRequired: false,
    fields: [
      host,
      { key: "port", label: "端口", placeholder: "1521", example: "1521", required: true, input: "number", fallback: "1521" },
      { key: "databaseName", label: "服务名（service name）", placeholder: "ORCLPDB1", example: "ORCLPDB1", required: true, input: "text" },
      { key: "schemaName", label: "模式（schema / 用户）", placeholder: "留空表示用连接用户的模式", example: "REPORTING", required: false, input: "text" },
      username,
      password,
    ],
  },
];

/**
 * 路线图上的来源类型，只用于选择器的「规划中」分类。
 * 刻意不并入 DataSourceKind：kind 的联合类型只应包含真正能连上的来源。
 */
export type PlannedDataSource = {
  key: string;
  label: string;
  description: string;
  capability: string;
  note: string;
  accent: string;
  mark: DataSourceMark;
};

export const PLANNED_DATA_SOURCES: PlannedDataSource[] = [
  { key: "ELASTICSEARCH", label: "Elasticsearch", description: "文档检索与聚合，适合把索引当作对象的属性来源。", capability: "索引 · 检索", note: "规划中", accent: "#65a30d", mark: "grid" },
  { key: "REST", label: "REST 接口", description: "按接口拉取 JSON，字段由返回结构推断。", capability: "接口 · JSON", note: "规划中", accent: "#6d4aff", mark: "table" },
  { key: "FILE", label: "文件集合", description: "CSV / Parquet 等文件集，按目录或对象存储接入。", capability: "文件 · 批量", note: "规划中", accent: "#0891b2", mark: "rows" },
];

export function isDataSourceKind(value: unknown): value is DataSourceKind {
  return typeof value === "string" && DATA_SOURCE_KINDS.some((item) => item.kind === value);
}

export function dataSourceKindInfo(kind: DataSourceKind): DataSourceKindInfo {
  return DATA_SOURCE_KINDS.find((item) => item.kind === kind) ?? DATA_SOURCE_KINDS[0];
}

/** 数据资源记录：字段是所有来源共用的最小集合，来源专属配置放在 options 里。 */
export type DataSourceRecord = {
  id: string;
  name: string;
  kind: DataSourceKind;
  host: string;
  port: number;
  /** PostgreSQL / MySQL 是库名；Oracle 是服务名。 */
  database_name: string;
  /** PostgreSQL 的 schema、Oracle 的模式；MySQL 留空（库名即容器）。 */
  schema_name: string;
  username: string;
  credential_secret: string;
  options: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
};

/** 交给前端的形状：绝不包含密文。 */
export type PublicDataSource = {
  id: string;
  name: string;
  kind: DataSourceKind;
  kindLabel: string;
  modelLabel: string;
  host: string;
  port: number;
  databaseName: string;
  schemaName: string;
  username: string;
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date | string;
  /** 一眼能看懂的连接串；密码永远是掩码。 */
  address: string;
};

export type DataViewKind = "table" | "view" | "materialized-view";

export type DataViewSummary = {
  schema: string;
  name: string;
  kind: DataViewKind;
  columnCount: number;
  comment: string;
};

export type DataViewField = {
  name: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  comment: string;
  position: number;
};

export type DataViewPreview = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** 是否因为行数上限被截断。 */
  truncated: boolean;
};

/** 只读 SQL 查询的结果。 */
export type SqlQueryResult = {
  /** 实际执行的语句：入参去掉尾分号、套上行数上限之后的版本。 */
  statement: string;
  columns: string[];
  rows: Record<string, unknown>[];
  /** 这次允许返回多少行。 */
  rowLimit: number;
  /** 命中上限被截断了。只可能是 SHOW / EXPLAIN 这类套不上行数上限的语句。 */
  truncated: boolean;
  /**
   * 服务端是否真的进了只读事务。false = 这个驱动起不了只读事务，
   * 只剩词法闸门在挡 —— 要如实报出去，别让人以为还有库那层保险。
   */
  readOnlyTransaction: boolean;
};

/** 一张表 / 视图的建表语句。 */
export type TableDdl = {
  schema: string;
  name: string;
  kind: DataViewKind;
  ddl: string;
  /** native = 库里自带的原始 DDL；metadata = 由列元数据还原出来的。 */
  source: "native" | "metadata";
  /** 超长被截到多少字符；没截断就没有这一项。 */
  truncatedAt?: number;
  /** 这份 DDL 少说了什么，如实写清楚。 */
  notes: string[];
};

export type DataViewRef = { schema?: string; name: string };

export type DataSourceHealth = {
  connected: boolean;
  /** 服务端自报的身份，例如 "PostgreSQL 16.3"。 */
  agent: string;
  /** 这次连接实际读的是哪个容器。 */
  container: string;
  detail?: string;
};

/**
 * 一种来源要能接入平台，只需要实现这四个动作。
 * 图数据库没有实现它，因为本体存储不是"数据来源"。
 */
export interface DataSourceConnector {
  test(): Promise<DataSourceHealth>;
  /** refresh 为 true 表示绕过服务端结构缓存，直接回库重读（界面上「刷新结构」用它）。 */
  listViews(options?: { schema?: string; search?: string; limit?: number; refresh?: boolean }): Promise<DataViewSummary[]>;
  describeView(view: DataViewRef): Promise<DataViewField[]>;
  previewView(view: DataViewRef, limit: number): Promise<DataViewPreview>;
  /**
   * 只读查询。**不是每种来源都提供**（将来接 Elasticsearch 就没有 SQL），所以是可选的：
   * 没有这个方法就是没有，调用方如实拒绝，别假装支持。
   */
  runReadOnlyQuery?(sql: string, options?: { limit?: number }): Promise<SqlQueryResult>;
  /** 建表语句 / 视图定义。同样只有关系库提供。 */
  describeTableDdl?(view: DataViewRef): Promise<TableDdl>;
}
