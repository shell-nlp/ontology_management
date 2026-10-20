import { createClickHouseOdsStore } from "@/lib/infrastructure/ods/clickhouse";
import { clickHouseTypeFor, odsTableName } from "@/lib/infrastructure/ods/clickhouse";
import { createClickHouseOdsQueryExecutor } from "@/lib/infrastructure/ods/logical-query";
import type { OdsStore } from "@/lib/infrastructure/ods/types";
import type { OdsQueryExecutor } from "@/lib/query-dsl/contract";

export * from "@/lib/infrastructure/ods/types";

/** ODS 后端注册表；业务层只依赖 OdsStore 契约。 */
export function getOdsStore(kind: "CLICKHOUSE" = "CLICKHOUSE"): OdsStore {
  switch (kind) {
    case "CLICKHOUSE":
    default:
      return createClickHouseOdsStore();
  }
}

export function getOdsQueryExecutor(): OdsQueryExecutor {
  return createClickHouseOdsQueryExecutor();
}

/** Storage-specific physical planning stays behind this public module boundary. */
export const odsStorageType = (sourceType: string, sourceKind?: string) => clickHouseTypeFor(sourceType, sourceKind);
export const odsStorageTable = (sourceId: string, schema: string, table: string) => odsTableName(sourceId, schema, table);
