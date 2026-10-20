import type { DataSourceRecord } from "@/lib/datasource/types";
import type { LogicalPlan } from "./ast";

/** 本体查询的统一结果。 */
export type QueryDslExecutionResult = {
  data_source: string;
  /** 实际读取的数据源类型；ODS 固定在 ClickHouse 执行。 */
  data_source_kind: DataSourceRecord["kind"] | "CLICKHOUSE";
  columns: string[];
  rows: unknown[][];
  returned: number;
  row_limit: number;
  truncated: boolean;
  elapsed_ms: number;
  warnings: string[];
  /** 真正发到源库的语句：本体 SQL 的"我写的那句"和"实际执行的这句"是两回事，排障要能对上。 */
  statement: string;
};

/** 源表 ODS 查询执行端口；没有完整 READY ODS 时返回 null，由查询层回退源库。 */
export interface OdsQueryExecutor {
  executeLogicalQuery(plan: LogicalPlan): Promise<QueryDslExecutionResult | null>;
}
