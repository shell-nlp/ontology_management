import type { DataSourceConnector, DataSourceRecord } from "@/lib/datasource/types";
import type { OntologyDefinition } from "@/lib/ontology";
import { inferredBindingWarnings, withInferredDataSources } from "./bindings";
import { resolveQueryDsl } from "./resolve";
import { parseQueryDsl } from "./schema";
import { compileQuerySql } from "./compile/sql";
import { QueryDslError } from "./errors";

export type QueryDslExecutionDeps = {
  getDataSource?: (sourceId: string) => Promise<DataSourceRecord | null>;
  openConnector?: (record: DataSourceRecord) => Promise<DataSourceConnector>;
  /** 只在定义里有没绑资源的来源时才会被调（见 bindings.ts）。 */
  listDataSources?: () => Promise<readonly DataSourceRecord[]>;
};

export type QueryDslExecutionResult = {
  data_source: string;
  data_source_kind: DataSourceRecord["kind"];
  columns: string[];
  rows: unknown[][];
  returned: number;
  row_limit: number;
  truncated: boolean;
  elapsed_ms: number;
  warnings: string[];
};

async function defaultDataSource(sourceId: string): Promise<DataSourceRecord | null> {
  const { getDataSource } = await import("@/lib/datasource/sources");
  return getDataSource(sourceId);
}

async function defaultConnector(record: DataSourceRecord): Promise<DataSourceConnector> {
  const { openDataSource } = await import("@/lib/datasource/sources");
  return openDataSource(record);
}

async function defaultListDataSources(): Promise<readonly DataSourceRecord[]> {
  const { listDataSources } = await import("@/lib/datasource/sources");
  return listDataSources();
}

export async function executeQueryDsl(
  definition: OntologyDefinition,
  input: unknown,
  deps: QueryDslExecutionDeps = {},
): Promise<QueryDslExecutionResult> {
  const query = parseQueryDsl(input);
  /*
   * 导入态的本体常常只填了「模式.表」、没填 dataSourceId。按模式名唯一匹配兜底补上，
   * 与 get_object_type / get_table_ddl 的读法保持一致，别让同一个本体能看不能查。
   */
  const bound = await withInferredDataSources(definition, deps.listDataSources ?? defaultListDataSources);
  const plan = resolveQueryDsl(bound.definition, query);
  const record = await (deps.getDataSource ?? defaultDataSource)(plan.root.dataSourceId);
  if (!record) {
    throw new QueryDslError("ENTITY_NOT_BOUND", `对象类型「${plan.root.entityTypeName}」绑定的数据资源已不存在。`);
  }
  const compiled = compileQuerySql(plan, record.kind);
  const connector = await (deps.openConnector ?? defaultConnector)(record);
  if (!connector.runReadOnlyQuery) {
    throw new QueryDslError("INVALID_QUERY", `数据资源「${record.name}」不支持 SQL 查询。`);
  }

  const startedAt = Date.now();
  const result = await connector.runReadOnlyQuery(compiled.statement, {
    limit: compiled.limit,
    parameters: compiled.parameters,
  });
  // 只报这次真正用到的对象类型：一个本体几十个类型没绑是常态，全列一遍会把结果淹掉。
  const warnings = [
    ...inferredBindingWarnings(bound.inferred, [...plan.entities.values()].map((entity) => entity.entityTypeName)),
    ...compiled.warnings,
  ];
  if (!result.readOnlyTransaction) warnings.push("这个驱动起不了只读事务，本次只有语句检查在挡，请只读使用。");
  if (result.truncated) warnings.push(`结果已被截断：只返回了前 ${result.rows.length} 行（本次上限 ${result.rowLimit}）。`);

  return {
    data_source: record.name,
    data_source_kind: record.kind,
    columns: result.columns,
    rows: result.rows.map((row) => result.columns.map((column) => row[column])),
    returned: result.rows.length,
    row_limit: result.rowLimit,
    truncated: result.truncated,
    elapsed_ms: Date.now() - startedAt,
    warnings,
  };
}