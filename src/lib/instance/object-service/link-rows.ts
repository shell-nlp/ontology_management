import { getOdsStore } from "@/lib/infrastructure/ods";
import { OdsSourceEntity, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import type { DataSourceRowFilter } from "@/lib/datasource/types";
import type { LinkPlan } from "@/lib/ontology/link-source";
import type { ObjectContext } from "./types";

/** 关系与对象共用来源读取策略：READY 镜像优先，显式 ODS 缺失时拒绝。 */
export async function readOdsLinkRows(
  context: ObjectContext,
  plan: LinkPlan & { ok: true },
  columns: string[],
  filters: DataSourceRowFilter[],
  keyGroups: DataSourceRowFilter[][] | undefined,
  limit: number,
) {
  const holder = plan.mode === "FOREIGN_KEY" ? context.definition.entityTypes.find((type) => type.name === plan.holder.entityTypeName)?.sources?.[0] : undefined;
  if (holder?.readMode === "DIRECT") return null;
  const explicit = holder?.readMode === "ODS";
  if (holder?.kind === "DERIVED") {
    if (explicit) throw new Error("关系的取数口径尚不能在 ODS 上执行，请调整关系来源配置。");
    return null;
  }
  const repo = await platformRepo(OdsSourceEntity);
  const mirror = await repo.findOne({ where: { dataSourceId: plan.dataSourceId, schemaName: plan.table.schema || "", tableName: plan.table.name, enabled: true } });
  const available = new Set((mirror?.columns ?? []).map((column: { name?: unknown }) => String(column.name ?? "").toLowerCase()));
  const missing = columns.filter((column) => !available.has(column.toLowerCase()));
  if (!mirror || mirror.status !== "READY" || missing.length) {
    if (explicit) throw new Error(`关系来源「${plan.table.name}」要求 ODS，但没有 READY 镜像或缺少列：${missing.join("、")}。请同步所需列后重试。`);
    return null;
  }
  const result = await getOdsStore().read({ sourceId: mirror.id, tableName: mirror.chTable, columns, filters, keyGroups, limit });
  return { ...result, rowLimit: limit };
}
