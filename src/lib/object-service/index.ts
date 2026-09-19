import { getObjectIndex } from "@/lib/object-index";
import { buildIndexEntry } from "@/lib/object-index/entries";
import type { ObjectIndexEntry } from "@/lib/object-index/types";
import { objectKeyOf, objectRefOf, type ObjectPrimaryKey } from "@/lib/object-identity";
import { createDataSourceObjectSource } from "@/lib/object-service/data-source";
import type { ObjectContext, ObjectQuery, ObjectQueryResult, ObjectOrigin, ObjectRecord, ObjectSource } from "@/lib/object-service/types";
import { getTarget } from "@/lib/targets";
import { listVersionRecords } from "@/lib/version-snapshot";

/**
 * 对象服务（S2）：平台里**唯一**的"按对象类型 + 主键取对象"的入口。
 *
 * 它把"对象从哪来"变成可替换的一层：
 * - `origin: "index"` —— 物化检索索引里有（快，支持全文 / 过滤 / 向量）；
 * - `origin: "source"` —— 按需回源到业务库（全，业务表有多少行就能取多少行）；
 * - `auto`（默认）—— 先问索引，索引里没有这个对象再回源。
 *
 * 上层（API 路由、界面、AI 工具）只认 `(本体, 对象类型, 主键)`，
 * 不认识图库、不认识索引表、也不认识业务库；换中间件只改上面这两个来源的实现。
 */

export * from "@/lib/object-service/types";

/** 对象来源注册表：接入新的对象来源（物化层 / ES / REST）时在这里加分支。 */
export function getObjectSource(kind: "DATA_SOURCE" = "DATA_SOURCE"): ObjectSource {
  switch (kind) {
    case "DATA_SOURCE":
    default:
      return createDataSourceObjectSource();
  }
}

/**
 * 解析对象上下文：默认用**已发布**版本（对象服务读的就是线上那一版），
 * 也可以点名某个版本（草稿预览用）。
 */
export async function resolveObjectContext(targetId: string, versionId?: string | null): Promise<ObjectContext> {
  const target = await getTarget(targetId);
  if (!target) throw new Error("本体存储不存在。");
  const records = await listVersionRecords(targetId);
  const record = versionId ? records.find((item) => item.id === versionId) : records.find((item) => item.status === "PUBLISHED");
  if (!record) throw new Error(versionId ? "该本体版本不存在。" : "这个本体还没有发布版本，暂时没有可读的对象。");
  return { targetId, definition: record.definition, versionId: record.id };
}

/** 索引条目与检索命中都满足这个形状，转成对象记录只用到这几项。 */
type IndexedRecord = Pick<ObjectIndexEntry, "objectId" | "entityType" | "primaryKey" | "title" | "properties">;

function recordFromEntry(entry: IndexedRecord, origin: ObjectOrigin): ObjectRecord {
  return {
    objectId: entry.objectId,
    entityType: entry.entityType,
    primaryKey: entry.primaryKey,
    title: entry.title,
    properties: entry.properties,
    origin,
    objectRef: objectRefOf(entry.entityType, entry.primaryKey),
    warnings: [],
  };
}

function clamp(value: number | undefined, min: number, max: number, fallback: number) {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * 按主键取一个对象。索引里有就走索引；没有（或点名要回源）就按
 * `sources[]` 的映射回业务库取，多个来源按主键合并属性。
 */
export async function getObject(
  context: ObjectContext,
  entityTypeName: string,
  primaryKey: ObjectPrimaryKey,
  options: { origin?: "auto" | ObjectOrigin } = {},
): Promise<ObjectRecord | null> {
  const origin = options.origin ?? "auto";
  const objectKey = objectKeyOf(entityTypeName, primaryKey);
  if (origin !== "source" && objectKey) {
    const entry = await getObjectIndex().readObject(context.targetId, objectKey);
    if (entry) return recordFromEntry(entry, "index");
  }
  if (origin === "index") return null;
  const { record } = await getObjectSource().readByKey(context.definition, entityTypeName, primaryKey);
  return record;
}

/**
 * 列 / 检索对象。`auto` 的口径：索引里这个对象类型有数据就用索引，
 * 否则回源（典型场景：只建了类型、还没把业务数据物化进索引）。
 */
export async function queryObjects(context: ObjectContext, query: ObjectQuery): Promise<ObjectQueryResult> {
  const started = Date.now();
  const origin = query.origin ?? "auto";
  const limit = clamp(query.limit, 1, 200, 20);
  const offset = clamp(query.offset, 0, 100000, 0);

  if (origin !== "source") {
    const result = await getObjectIndex().searchObjects({
      targetId: context.targetId,
      labels: [query.entityType],
      text: query.text,
      filters: query.filters,
      limit,
      offset,
    });
    if (result.total > 0 || origin === "index") {
      return {
        entityType: query.entityType,
        rows: result.hits.map((hit) => recordFromEntry(hit, "index")),
        total: result.total,
        origin: "index",
        warnings: result.textMode === "none" && query.text ? ["索引里没有可用的全文检索能力，这次只按属性过滤。"] : [],
        tookMs: Date.now() - started,
      };
    }
  }

  const source = await getObjectSource().query(context.definition, query.entityType, { ...query, limit, offset });
  return {
    entityType: query.entityType,
    rows: source.rows,
    total: source.total,
    origin: source.rows.length ? "source" : "none",
    warnings: source.warnings,
    tookMs: Date.now() - started,
  };
}

/**
 * 把对象写进检索索引（S3 的"改一行同步一行"）。
 *
 * 给了 `keys` 就只同步这几条（增量）；没给就按 `limit` 从数据源拉一批。
 * **只 upsert 不 prune**：发布才是权威，这条路径只负责把新数据补进索引。
 */
export async function syncObjectsToIndex(
  context: ObjectContext,
  entityTypeName: string,
  options: { keys?: ObjectPrimaryKey[]; limit?: number } = {},
): Promise<{ upserted: number; total: number; warnings: string[] }> {
  const source = getObjectSource();
  const warnings: string[] = [];
  const entries: ObjectIndexEntry[] = [];
  const toEntry = (record: ObjectRecord) =>
    buildIndexEntry(context.definition, { id: record.objectId, labels: [entityTypeName], properties: record.properties });

  if (options.keys?.length) {
    for (const key of options.keys) {
      const { record, warnings: readWarnings } = await source.readByKey(context.definition, entityTypeName, key);
      warnings.push(...readWarnings);
      if (record?.objectId) entries.push(toEntry(record));
    }
  } else {
    const result = await source.query(context.definition, entityTypeName, {
      entityType: entityTypeName,
      limit: clamp(options.limit, 1, 500, 100),
    });
    warnings.push(...result.warnings);
    for (const record of result.rows) if (record.objectId) entries.push(toEntry(record));
  }

  const synced = await getObjectIndex().syncTargetObjects(context.targetId, entries, { versionId: context.versionId, prune: false });
  return { upserted: synced.upserted, total: synced.total, warnings };
}
