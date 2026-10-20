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
  }): Promise<{ rows: number; pages: number }>;
  writeIncremental(input: {
    spec: OdsTableSpec;
    rows: AsyncIterable<Record<string, unknown>>;
    batchId: number;
    onProgress?: (progress: OdsWriteProgress) => void | Promise<void>;
  }): Promise<{ rows: number; pages: number }>;
  read(query: OdsReadQuery): Promise<OdsReadResult>;
  count(spec: OdsTableSpec): Promise<number>;
  drop(sourceId: string, tableName: string): Promise<void>;
}
