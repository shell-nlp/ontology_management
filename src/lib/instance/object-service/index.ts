import { objectIdOf, objectRefOf, primaryKeyColumns, propertyForColumn, type ObjectPrimaryKey } from "@/lib/ontology/object-identity";
import { createOdsFirstObjectSource } from "@/lib/instance/object-service/ods-source";
import type { ObjectContext, ObjectQuery, ObjectQueryResult, ObjectOrigin, ObjectRecord, ObjectSource } from "@/lib/instance/object-service/types";
import { clamp } from "@/lib/instance/object-service/common";
import { getTarget } from "@/lib/platform/targets";
import { listVersionRecords } from "@/lib/versioning/snapshot";
import { applyObjectEdit, queryWithEdits, readEditSnapshot } from "./edit-overlay";

/**
 * 对象服务：平台里唯一的对象读取入口。
 *
 * 按当前版本从 ODS / 业务源投影对象，再合并版本编辑。普通读取不使用对象副本。
 */
export * from "@/lib/instance/object-service/types";

export function getObjectSource(kind: "DATA_SOURCE" = "DATA_SOURCE"): ObjectSource {
  switch (kind) {
    case "DATA_SOURCE":
    default:
      return createOdsFirstObjectSource();
  }
}

export async function resolveObjectContext(targetId: string, versionId?: string | null): Promise<ObjectContext> {
  const target = await getTarget(targetId);
  if (!target) throw new Error("本体存储不存在。");
  const records = await listVersionRecords(targetId);
  const record = versionId ? records.find((item) => item.id === versionId) : records.find((item) => item.status === "PUBLISHED");
  if (!record) throw new Error(versionId ? "该本体版本不存在。" : "这个本体还没有发布版本，暂时没有可读的对象。");
  return { targetId, definition: record.definition, versionId: record.id };
}

export async function getObject(
  context: ObjectContext,
  entityTypeName: string,
  primaryKey: ObjectPrimaryKey,
  options: { origin?: "auto" | ObjectOrigin } = {},
): Promise<ObjectRecord | null> {
  const editSnapshot = await readEditSnapshot(context);
  const objectId = objectIdOf(entityTypeName, primaryKey);
  const local = applyObjectEdit(context, editSnapshot, null, entityTypeName, objectId);
  if (local || editSnapshot?.objectEdits?.[objectId]?.deleted) return local;
  void options;
  const { record } = await getObjectSource().readByKey(context.definition, entityTypeName, primaryKey);
  return applyObjectEdit(context, editSnapshot, record, entityTypeName, objectId);
}

/** 兼容旧入参；读取路径统一由来源 readMode 决定。 */
export function resolveReadOrigin(
  policy: "AUTO" | "INDEXED" | "FEDERATED" | undefined,
  requested: "auto" | ObjectOrigin | undefined,
): "auto" | ObjectOrigin {
  void policy;
  void requested;
  return "source";
}

export async function queryObjects(context: ObjectContext, query: ObjectQuery): Promise<ObjectQueryResult> {
  query.signal?.throwIfAborted();
  return queryWithEdits(context, query, (next) => queryObjectsWithoutEdits(context, next));
}

async function queryObjectsWithoutEdits(context: ObjectContext, query: ObjectQuery): Promise<ObjectQueryResult> {
  const started = Date.now();
  const type = context.definition.entityTypes.find((item) => item.name === query.entityType);
  if (!type) throw new Error(`对象类型「${query.entityType}」不存在。`);
  if (!type.sources?.some((source) => source.dataSourceId && (source.view || source.sql))) {
    return { entityType: type.name, rows: [], total: 0, origin: "none", warnings: ["没有可读数据来源，仅展示当前版本的本地对象。"], tookMs: Date.now() - started };
  }
  const limit = clamp(query.limit, 1, 200, 20);
  const offset = clamp(query.offset, 0, 100000, 0);
  const defaultSort = primaryKeyColumns(type)
    .map((column) => propertyForColumn(type, column))
    .filter((property): property is string => Boolean(property))
    .map((property) => ({ property, direction: "ASC" as const }));
  const source = await getObjectSource().query(context.definition, query.entityType, {
    ...query,
    sort: query.sort?.length ? query.sort : defaultSort,
    origin: "source",
    limit,
    offset,
  });
  query.signal?.throwIfAborted();
  return {
    entityType: query.entityType,
    rows: source.rows,
    total: source.total,
    origin: source.rows.length ? "source" : "none",
    warnings: source.warnings,
    tookMs: Date.now() - started,
  };
}

/** 按定义中的类型顺序拼接虚拟列表；只取当前页，不把全表加载到内存。 */
export async function queryAllObjects(
  context: ObjectContext,
  query: { labels?: string[]; text?: string; limit?: number; offset?: number; count?: boolean; signal?: AbortSignal } = {},
): Promise<ObjectQueryResult> {
  const started = Date.now();
  const limit = clamp(query.limit, 1, 200, 20);
  let skip = clamp(query.offset, 0, 100000, 0);
  const rows: ObjectRecord[] = [];
  const warnings: string[] = [];
  let total: number | null = 0;
  const types = context.definition.entityTypes.filter((type) => !query.labels?.length || query.labels.includes(type.name));
  const unknown = query.labels?.filter((label) => !context.definition.entityTypes.some((type) => type.name === label));
  if (unknown?.length) throw new Error(`对象类型不存在：${unknown.join("、")}。`);
  for (const type of types) {
    query.signal?.throwIfAborted();
    if (query.count === false && rows.length >= limit) {
      total = null;
      warnings.push("当前页已满，未继续查询其它类型或统计跨类型总数；请选择具体类型收窄范围。");
      break;
    }
    let first: ObjectQueryResult;
    try {
      first = await queryObjects(context, {
        entityType: type.name,
        text: query.text,
        limit: Math.max(1, limit - rows.length),
        offset: 0,
        count: query.count !== false || skip > 0,
        signal: query.signal,
      });
    } catch (error) {
      query.signal?.throwIfAborted();
      if (skip) throw new Error(`「${type.name}」查询失败，无法保证跨类型分页完整；请选择具体类型。${error instanceof Error ? error.message : String(error)}`);
      total = null;
      warnings.push(`「${type.name}」未能查询，本页不包含该类型，结果不完整：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    warnings.push(...first.warnings.map((warning) => `「${type.name}」：${warning}`));
    if (total !== null) total = first.total === null ? null : total + first.total;
    if (rows.length >= limit) continue;
    if (first.total !== null && skip >= first.total) {
      skip -= first.total;
      continue;
    }
    if (skip && first.total === null) {
      throw new Error(`「${type.name}」无法确定完整对象总数，不能保证跨类型分页不漏项；请选择具体对象类型分页查看。`);
    }
    const page = skip
      ? await queryObjects(context, {
        entityType: type.name,
        text: query.text,
        limit: limit - rows.length,
        offset: skip,
        count: query.count !== false,
        signal: query.signal,
      })
      : first;
    if (page !== first) warnings.push(...page.warnings.map((warning) => `「${type.name}」：${warning}`));
    rows.push(...page.rows);
    skip = 0;
  }
  return { entityType: "", rows, total: query.count === false ? null : total, origin: rows.length ? "source" : "none", warnings: [...new Set(warnings)], tookMs: Date.now() - started };
}

/** 把数据源里的对象取入草稿快照；身份确定，重复调用不会创建第二份。 */
export async function ensureObjectInDraft(
  context: ObjectContext,
  draftVersionId: string,
  entityTypeName: string,
  primaryKey: ObjectPrimaryKey,
): Promise<{ record: ObjectRecord; created: boolean; warnings: string[] }> {
  const [{ createSnapshotEntity }, { readVersionSnapshot }] = await Promise.all([
    import("@/lib/instance/snapshot-editing"),
    import("@/lib/versioning/snapshot"),
  ]);
  const objectId = objectIdOf(entityTypeName, primaryKey);
  const snapshot = await readVersionSnapshot(draftVersionId).catch(() => null);
  const existing = objectId ? snapshot?.nodes.find((node) => node.id === objectId) : undefined;
  if (existing) {
    return {
      record: {
        objectId: existing.id,
        entityType: entityTypeName,
        primaryKey,
        title: "",
        properties: existing.properties,
        origin: "source",
        objectRef: objectRefOf(entityTypeName, primaryKey),
        warnings: [],
      },
      created: false,
      warnings: [],
    };
  }
  const source = await getObject(context, entityTypeName, primaryKey, { origin: "source" });
  if (!source) throw new Error(`数据资源里没有找到「${objectRefOf(entityTypeName, primaryKey)}」这个对象。`);
  const unmappedRequired = (context.definition.entityTypes.find((item) => item.name === entityTypeName)?.properties ?? [])
    .filter((property) => property.required && !(property.sourceField ?? "").trim() && !(property.name in source.properties));
  if (unmappedRequired.length) {
    throw new Error(`对象类型「${entityTypeName}」的必填属性「${unmappedRequired.map((property) => property.name).join("、")}」没有映射来源列，取进草稿也填不上值：请到「本体建模」给它选一列，或取消必填。`);
  }
  const created = await createSnapshotEntity(draftVersionId, entityTypeName, source.properties, { sourceBase: source.properties });
  return {
    record: { ...source, objectId: created.id, properties: created.properties, origin: "source" },
    created: true,
    warnings: source.warnings,
  };
}
