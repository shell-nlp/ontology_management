import type { ObjectIndex, ObjectIndexMaterialization } from "@/lib/infrastructure/object-index/types";
import type { LogicalPlan } from "@/lib/query-dsl/ast";
import type { MaterializedQueryExecutor, QueryDslExecutionResult } from "@/lib/query-dsl/contract";
import { clickHouseQuery } from "./client";
import { clickHouseConfig } from "./config";
import { compileLogicalQueryForClickHouse } from "./query-dsl";
import { isMaterializationCurrent } from "@/lib/ontology/materialization-stamp";

function completeManifest(manifest: ObjectIndexMaterialization | undefined): boolean {
  // 空类型也可能已经完整物化：rows=0 本身不是问题，跑到源尾且没有截断才算完整。
  return Boolean(manifest && !manifest.truncated);
}

function requiredNames(plan: LogicalPlan): string[] {
  return [
    ...[...plan.entities.values()].map((entity) => entity.entityTypeName),
    ...plan.relationships.map((relationship) => relationship.relationName),
  ];
}

/**
 * ClickHouse 的物化查询适配器。
 *
 * 它只通过 `ObjectIndex` 契约读取物化清单，ClickHouse SQL 的编译与 HTTP 调用都留在这个目录里。
 */
export function createClickHouseMaterializedQueryExecutor(index: ObjectIndex): MaterializedQueryExecutor {
  return {
    async executeLogicalQuery(plan, targetId, definition): Promise<QueryDslExecutionResult | null> {
      // 虚拟查询优先：AUTO / FEDERATED 都回源；只有显式 INDEXED 才允许自动读 CH。
      if ([...plan.entities.values()].some((entity) => entity.indexPolicy !== "INDEXED")) return null;

      let manifests: ObjectIndexMaterialization[];
      try {
        manifests = await index.listMaterializations(targetId);
      } catch {
        // 物化清单不可用不能挡住正常问数：回退源库。
        return null;
      }

      const byName = new Map(manifests.map((manifest) => [manifest.entityType, manifest]));
      if (!definition || !requiredNames(plan).every((name) => completeManifest(byName.get(name)) && isMaterializationCurrent(definition, name, byName.get(name)))) return null;

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
    },
  };
}
