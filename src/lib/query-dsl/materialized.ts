import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { clickHouseQuery } from "@/lib/infrastructure/object-index/clickhouse/client";
import { clickHouseConfig } from "@/lib/infrastructure/object-index/clickhouse/config";
import { compileLogicalQueryForClickHouse } from "@/lib/infrastructure/object-index/clickhouse/query-dsl";
import type { LogicalPlan } from "./ast";
import type { QueryDslExecutionResult } from "./execute";

/**
 * `run_query` 的执行路由：涉及的对象类型与关系类型都已经**完整物化**时，读 ClickHouse 对象索引；
 * 任意一处没物化、只物化了一部分、或物化清单已经清掉时，返回 null，由调用方回源业务库。
 *
 * 这里刻意不把“物化对象数”当成完整性的判据：空类型也可能已经完整物化（rows=0、truncated=false），
 * 真正的判据是它有没有完整跑到源尾的清单。
 */
async function fullyMaterialized(plan: LogicalPlan, targetId: string): Promise<boolean> {
  try {
    const manifests = await getObjectIndex().listMaterializations(targetId);
    const byName = new Map(manifests.map((manifest) => [manifest.entityType, manifest]));
    const required = [
      ...[...plan.entities.values()].map((entity) => entity.entityTypeName),
      ...plan.relationships.map((relationship) => relationship.relationName),
    ];
    return required.every((name) => {
      const manifest = byName.get(name);
      return Boolean(manifest && !manifest.truncated);
    });
  } catch {
    return false;
  }
}

export async function tryExecuteMaterializedQuery(plan: LogicalPlan, targetId: string | undefined): Promise<QueryDslExecutionResult | null> {
  if (!targetId || !(await fullyMaterialized(plan, targetId))) return null;

  const config = clickHouseConfig();
  const compiled = compileLogicalQueryForClickHouse(plan, targetId, config.database);
  const startedAt = Date.now();
  const rows = await clickHouseQuery<Record<string, unknown>>(compiled.statement, { params: compiled.params });
  const truncated = rows.length > compiled.limit;
  const visible = truncated ? rows.slice(0, compiled.limit) : rows;

  return {
    data_source: "ClickHouse 对象索引",
    data_source_kind: "CLICKHOUSE",
    columns: compiled.columns,
    rows: visible.map((row) => compiled.columns.map((column) => row[column])),
    returned: visible.length,
    row_limit: compiled.limit,
    truncated,
    elapsed_ms: Date.now() - startedAt,
    warnings: ["本次查询命中已完整物化的对象索引（ClickHouse），没有回源业务库。", ...compiled.warnings],
    statement: compiled.statement,
  };
}
