import type { DataSourceConnector, DataSourceRecord } from "@/lib/datasource/types";
import type { OntologyDefinition } from "@/lib/ontology";
import { compileQuerySql, type CompiledSqlQuery } from "./compile/sql";
import { resolveQueryDsl } from "./resolve";
import { parseQueryDsl } from "./schema";
import type { QueryDslExecutionDeps } from "./execute";
import { QueryDslError } from "./errors";

export type ShadowDifference = {
  row: number;
  column: string;
  dsl: unknown;
  reference: unknown;
};

export type ShadowComparisonResult = {
  equal: boolean;
  dsl: {
    statement: string;
    parameters: Record<string, string | number | boolean | null>;
    columns: string[];
    rows: unknown[][];
  };
  reference: {
    statement: string;
    columns: string[];
    rows: unknown[][];
  };
  differences: ShadowDifference[];
  warnings: string[];
};

async function resolveRecord(sourceId: string, deps: QueryDslExecutionDeps): Promise<DataSourceRecord | null> {
  if (deps.getDataSource) return deps.getDataSource(sourceId);
  const { getDataSource } = await import("@/lib/datasource/sources");
  return getDataSource(sourceId);
}

async function resolveConnector(record: DataSourceRecord, deps: QueryDslExecutionDeps): Promise<DataSourceConnector> {
  if (deps.openConnector) return deps.openConnector(record);
  const { openDataSource } = await import("@/lib/datasource/sources");
  return openDataSource(record);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  if (left instanceof Date || right instanceof Date) return String(left) === String(right);
  return Object.is(left, right);
}

function diffRows(dslColumns: string[], dslRows: unknown[][], referenceColumns: string[], referenceRows: unknown[][]): ShadowDifference[] {
  const differences: ShadowDifference[] = [];
  const columns = dslColumns.length === referenceColumns.length ? dslColumns : dslColumns.slice(0, referenceColumns.length);
  const rows = Math.max(dslRows.length, referenceRows.length);
  for (let row = 0; row < rows; row += 1) {
    for (let index = 0; index < columns.length; index += 1) {
      const dslValue = dslRows[row]?.[index];
      const referenceValue = referenceRows[row]?.[index];
      if (!sameValue(dslValue, referenceValue)) {
        differences.push({ row, column: columns[index], dsl: dslValue, reference: referenceValue });
      }
    }
  }
  if (dslColumns.length !== referenceColumns.length) {
    differences.push({ row: -1, column: "__columns__", dsl: dslColumns, reference: referenceColumns });
  }
  if (dslRows.length !== referenceRows.length) {
    differences.push({ row: Math.min(dslRows.length, referenceRows.length), column: "__row_count__", dsl: dslRows.length, reference: referenceRows.length });
  }
  return differences;
}

export async function compareQueryDslWithSql(
  definition: OntologyDefinition,
  input: unknown,
  referenceSql: string,
  deps: QueryDslExecutionDeps = {},
): Promise<ShadowComparisonResult> {
  const query = parseQueryDsl(input);
  const plan = resolveQueryDsl(definition, query);
  const record = await resolveRecord(plan.root.dataSourceId, deps);
  if (!record) throw new QueryDslError("ENTITY_NOT_BOUND", `对象类型「${plan.root.entityTypeName}」绑定的数据资源已不存在。`);
  const compiled: CompiledSqlQuery = compileQuerySql(plan, record.kind);
  const connector = await resolveConnector(record, deps);
  if (!connector.runReadOnlyQuery) throw new QueryDslError("INVALID_QUERY", `数据资源「${record.name}」不支持 SQL 查询。`);

  const dslResult = await connector.runReadOnlyQuery(compiled.statement, {
    limit: compiled.limit,
    parameters: compiled.parameters,
  });
  const referenceResult = await connector.runReadOnlyQuery(referenceSql, { limit: compiled.limit });
  const dslRows = dslResult.rows.map((row) => dslResult.columns.map((column) => row[column]));
  const referenceRows = referenceResult.rows.map((row) => referenceResult.columns.map((column) => row[column]));
  const differences = diffRows(dslResult.columns, dslRows, referenceResult.columns, referenceRows);

  return {
    equal: differences.length === 0,
    dsl: {
      statement: compiled.statement,
      parameters: compiled.parameters,
      columns: dslResult.columns,
      rows: dslRows,
    },
    reference: {
      statement: referenceResult.statement,
      columns: referenceResult.columns,
      rows: referenceRows,
    },
    differences,
    warnings: [...compiled.warnings],
  };
}