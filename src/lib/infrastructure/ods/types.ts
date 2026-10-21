import type { DataSourceRowFilter, DataSourceRowSort } from "@/lib/shared/common/data-source-kind";

/** 一列 ODS 映射：源列名 + 源类型 + ClickHouse 存储类型。 */
export type OdsColumn = {
  name: string;
  sourceType: string;
  clickhouseType: string;
  nullable: boolean;
  primaryKey: boolean;
  comment?: string;
};

/** 一张 ODS 源表镜像的物理规格。 */
export type OdsTableSpec = {
  sourceId: string;
  tableName: string;
  /** 物理镜像对应的原始模式；用于表注释和运维识别。 */
  sourceSchema?: string;
  /** 物理镜像对应的原始表名；用于表注释和运维识别。 */
  sourceTable?: string;
  columns: OdsColumn[];
  primaryKeyColumns: string[];
};

export type OdsReadQuery = {
  /** false 时只取当前页，不执行全表计数；total 返回 null。 */
  count?: boolean;
  sourceId: string;
  tableName: string;
  columns: string[];
  filters: DataSourceRowFilter[];
  keyGroups?: DataSourceRowFilter[][];
  search?: { text: string; columns: string[] };
  sort?: DataSourceRowSort[];
  limit: number;
  offset?: number;
};

export type OdsReadResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number | null;
  truncated: boolean;
  statement: string;
};

export type OdsWriteProgress = {
  scanned: number;
  rows: number;
  pages: number;
  message?: string;
};

export type OdsWriteResult = {
  /** 从源侧实际读到的行数。 */
  rows: number;
  /** 最终可读取的镜像行数；完全相同重复行折叠后会小于 rows。 */
  storedRows: number;
  pages: number;
  /** 可安全继续但必须让用户看到的同步告警。 */
  warnings: string[];
};

export type OdsObjectChangeOperation = "CREATE" | "UPDATE" | "DELETE";

/**
 * 发布版本中的一个稀疏对象变更。
 *
 * UPDATE 同时保留 `base`（发布时的源基线）和 `properties`（完整有效对象），
 * 查询时只应用相对 base 真正变化的字段，未修改字段继续跟随当前 ODS 基础镜像。
 */
export type OdsPublishedObjectChange = {
  versionId: string;
  entityTypeId: string;
  entityType: string;
  objectId: string;
  primaryKey: Record<string, string>;
  operation: OdsObjectChangeOperation;
  base: Record<string, unknown> | null;
  properties: Record<string, unknown>;
  changedProperties: string[];
};

export type OdsRelationshipChangeOperation = "CREATE" | "UPDATE" | "DELETE";

/** 发布版本中的一个稀疏关系变更。 */
export type OdsPublishedRelationshipChange = {
  versionId: string;
  relationshipTypeId: string;
  relationshipType: string;
  relationshipId: string;
  sourceEntityTypeId: string;
  targetEntityTypeId: string;
  sourceObjectId: string;
  targetObjectId: string;
  sourcePrimaryKey: Record<string, string>;
  targetPrimaryKey: Record<string, string>;
  operation: OdsRelationshipChangeOperation;
  properties: Record<string, unknown>;
};

export type OdsVersionChanges = {
  objects: OdsPublishedObjectChange[];
  relationships: OdsPublishedRelationshipChange[];
};

/**
 * ODS 存储契约。
 *
 * 业务层只说“一张源表、这些列、这个主键、这批行”，不写 ClickHouse SQL；
 * 换 Doris / StarRocks / 其它分析存储时只替换本接口实现。
 */
export interface OdsStore {
  readonly kind: string;
  writeFull(input: {
    spec: OdsTableSpec;
    rows: AsyncIterable<Record<string, unknown>>;
    batchId: number;
    onProgress?: (progress: OdsWriteProgress) => void | Promise<void>;
  }): Promise<OdsWriteResult>;
  writeIncremental(input: {
    spec: OdsTableSpec;
    rows: AsyncIterable<Record<string, unknown>>;
    batchId: number;
    onProgress?: (progress: OdsWriteProgress) => void | Promise<void>;
  }): Promise<OdsWriteResult>;
  read(query: OdsReadQuery): Promise<OdsReadResult>;
  count(spec: OdsTableSpec): Promise<number>;
  drop(sourceId: string, tableName: string): Promise<void>;
  /** 原子替换一个发布版本的稀疏对象/关系变更集；版本未发布前可安全重试。 */
  replaceVersionChanges(versionId: string, changes: OdsVersionChanges): Promise<void>;
  readVersionChanges(versionId: string): Promise<OdsVersionChanges>;
  /** 删除本体版本时清理该版本的稀疏变更集。 */
  deleteVersionChanges(versionId: string): Promise<void>;
}
