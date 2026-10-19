import type { DataSourceRecord } from "@/lib/datasource/types";
import type { LogicalPlan } from "./ast";

/** 本体查询的统一结果。源库查询与物化索引查询都返回这个形状。 */
export type QueryDslExecutionResult = {
  data_source: string;
  /** 源库类型，或对象索引的 ClickHouse。 */
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

/**
 * 已物化对象的逻辑查询执行端口。
 *
 * `query-dsl` 只认这个接口，不认识 ClickHouse、表名或 SQL 方言。具体实现在对象索引适配层，
 * 由应用入口注入；没有注入或数据没有完整物化时，查询自动回退业务库。
 */
export interface MaterializedQueryExecutor {
  executeLogicalQuery(plan: LogicalPlan, targetId: string): Promise<QueryDslExecutionResult | null>;
}
