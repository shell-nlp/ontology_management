import { getObjectIndex } from "@/lib/framework/object-index";
import { buildIndexEntry } from "@/lib/instance/object-index/entries";
import type { ObjectIndexEntry } from "@/lib/framework/object-index/types";
import { objectIdOf, objectKeyOf, objectRefOf, type ObjectPrimaryKey } from "@/lib/instance/object-identity";
import { createDataSourceObjectSource } from "@/lib/instance/object-service/data-source";
import type { ObjectContext, ObjectQuery, ObjectQueryResult, ObjectOrigin, ObjectRecord, ObjectSource } from "@/lib/instance/object-service/types";
import { getTarget } from "@/lib/platform/targets";
import { listVersionRecords } from "@/lib/versioning/snapshot";

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

export * from "@/lib/instance/object-service/types";

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
/**
 * 对象类型上配的**默认读法**（`entityTypes[].indexPolicy`）说了算：
 * - `FEDERATED` → 一律回源（策略优先于这次查询里临时选的来源）；
 * - `INDEXED` → 只读索引，没物化就明确告知，不静默回源；
 * - `AUTO`（默认） → 按调用方这次的选择走（`auto` / `index` / `source`）。
 * 纯函数，便于单测；老快照没有这个字段时读出 `AUTO`。
 */
export function resolveReadOrigin(
  policy: "AUTO" | "INDEXED" | "FEDERATED" | undefined,
  requested: "auto" | ObjectOrigin | undefined,
): "auto" | ObjectOrigin {
  if (policy === "FEDERATED") return "source";
  if (policy === "INDEXED") return "index";
  return requested ?? "auto";
}

export async function queryObjects(context: ObjectContext, query: ObjectQuery): Promise<ObjectQueryResult> {
  const started = Date.now();
  // 类型上配了策略就按策略，没配（老快照 / AUTO）才看这次调用临时选的来源。
  const policy = context.definition.entityTypes.find((item) => item.name === query.entityType)?.indexPolicy ?? "AUTO";
  const origin = resolveReadOrigin(policy, query.origin);
  const policyWarning =
    policy === "FEDERATED"
      ? ["这个对象类型按策略走业务库（FEDERATED）：不能跨类型 join、多跳遍历不完整、聚合受限。"]
      : [];
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
      const warnings = [
        ...policyWarning,
        ...(result.textMode === "none" && query.text ? ["索引里没有可用的全文检索能力，这次只按属性过滤。"] : []),
        ...(policy === "INDEXED" && result.total === 0
          ? ["这个对象类型要求走索引（INDEXED），但索引里没有它的对象：先到「索引与物化」整份物化；策略下不会自动回源。"]
          : []),
      ];
      // 半份必须报数（2026-10-12 用户口径）：这个类型如果上次物化撞了上限，就说清"只物化了 N 条"。
      const truncated = await getObjectIndex()
        .listMaterializations(context.targetId)
        .then((items) => items.find((item) => item.entityType === query.entityType))
        .catch(() => undefined);
      if (truncated?.truncated) {
        warnings.push(
          `这个对象类型只物化了 ${truncated.rows} 条（扫描 ${truncated.scanned} 条时撞到上限），源里可能还有更多；` +
          `要看全量请重新整份物化，或把来源切到「业务库」。`,
        );
      }
      return {
        entityType: query.entityType,
        rows: result.hits.map((hit) => recordFromEntry(hit, "index")),
        total: result.total,
        origin: "index",
        warnings,
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
    warnings: [...policyWarning, ...source.warnings],
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
  /** 不带 keys 的批量同步：这一批是否已经把源读完了（读满 limit 就当没读完）。 */
  let batchComplete = true;
  const toEntry = (record: ObjectRecord) =>
    buildIndexEntry(context.definition, { id: record.objectId, labels: [entityTypeName], properties: record.properties });

  if (options.keys?.length) {
    for (const key of options.keys) {
      const { record, warnings: readWarnings } = await source.readByKey(context.definition, entityTypeName, key);
      warnings.push(...readWarnings);
      if (record?.objectId) entries.push(toEntry(record));
    }
  } else {
    const limit = clamp(options.limit, 1, 500, 100);
    const result = await source.query(context.definition, entityTypeName, {
      entityType: entityTypeName,
      limit,
    });
    warnings.push(...result.warnings);
    for (const record of result.rows) if (record.objectId) entries.push(toEntry(record));
    // 不带 keys 的批量同步只是"补一批"：读满了 limit 就说明源里可能还有，如实记成不完整。
    batchComplete = result.rows.length < limit;
  }

  // 这条路径写的是"从业务库同步过来的行" = MATERIALIZED 来源：发布（SNAPSHOT）不许把这些行清掉。
  const synced = await getObjectIndex().syncTargetObjects(context.targetId, entries, {
    versionId: context.versionId,
    origin: "MATERIALIZED",
    prune: false,
  });
  if (!options.keys?.length) {
    await getObjectIndex()
      .saveMaterialization({
        targetId: context.targetId,
        entityType: entityTypeName,
        rows: synced.upserted,
        scanned: entries.length,
        truncated: !batchComplete,
        pages: 1,
        completedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  }
  return { upserted: synced.upserted, total: synced.total, warnings };
}

/** 整份物化的结果。`truncated` 为真表示撞到上限，源里可能还有更多 —— 必须回给用户。 */
export type MaterializeTypeResult = {
  entityType: string;
  /** 写进索引的条数。 */
  rows: number;
  /** 从源里读过的行数（撞上限时 = 上限）。 */
  scanned: number;
  truncated: boolean;
  pages: number;
  /** 源报告的总数（有的源不给）。 */
  total: number | null;
  tookMs: number;
  warnings: string[];
};

/**
 * **按对象类型整份物化**（S4 第一刀，2026-10-12 用户口径）。
 *
 * 口径：物化的粒度是**对象类型**，不是"一部分行" —— 半份物化会让 \`auto\` 读法静默截断
 * （索引里 total > 0 就不再回源，页面显示成"这个类型只有 N 个对象"）。所以这里分页读到
 * **源读完**才停；撞到 \`maxRows\` 就停下并如实回 \`truncated=true\`，此时**不做 prune**
 * （读一半就删会把源里还有的行删掉）。
 *
 * 只写 \`MATERIALIZED\` 这一来源：发布与「重建索引」只替换 \`SNAPSHOT\`，两边互不覆盖。
 */
export async function materializeObjectType(
  context: ObjectContext,
  entityTypeName: string,
  options: {
    pageSize?: number;
    maxRows?: number | null;
    /** 断点续跑：从第几条开始接着读（上一轮任务已读的条数）。默认 0 = 从头读。 */
    startOffset?: number;
    onProgress?: (progress: { scanned: number; rows: number; pages: number }) => void;
    shouldCancel?: () => boolean;
  } = {},
): Promise<MaterializeTypeResult> {
  const started = Date.now();
  const source = getObjectSource();
  const pageSize = clamp(options.pageSize, 1, 500, 500);
  // **默认不限制**（2026-10-12 用户口径）：不传 maxRows 就是"读到源读完"。
  // 传了正数才是硬上限（撞上就 truncated=true 且不 prune，如实报数）。
  const maxRows = typeof options.maxRows === "number" && options.maxRows > 0 ? Math.floor(options.maxRows) : Number.POSITIVE_INFINITY;
  const entries: ObjectIndexEntry[] = [];
  const warnings: string[] = [];
  // 断点续跑：offset/scanned 从断点开始（第一页就是"接着上次没读完的那一行"）。
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  let offset = startOffset;
  let pages = 0;
  let scanned = startOffset;
  let total: number | null = null;
  let truncated = false;

  let cancelled = false;
  /** 上一页的"身份签名"：整整一页跟上一页一模一样 = 源侧分页没前进。 */
  let previousPageKey: string | null = null;
  let stalled = false;
  while (scanned < maxRows) {
    if (options.shouldCancel?.()) { cancelled = true; break; }
    const limit = Number.isFinite(maxRows) ? Math.min(pageSize, maxRows - scanned) : pageSize;
    // 只有第一页问总数：物化不需要每页都 COUNT(*)。
    const result = await source.query(context.definition, entityTypeName, { entityType: entityTypeName, limit, offset, count: pages === 0 });
    options.onProgress?.({ scanned: scanned + result.rows.length, rows: entries.length + result.rows.length, pages: pages + 1 });
    warnings.push(...result.warnings);
    if (total === null && Number.isFinite(result.total)) total = result.total;
    pages += 1;
    scanned += result.rows.length;
    for (const record of result.rows) {
      if (record.objectId) {
        entries.push(buildIndexEntry(context.definition, { id: record.objectId, labels: [entityTypeName], properties: record.properties }));
      }
    }
    // 这一页没读满 = 源读完了；读满就继续下一页。
    if (result.rows.length < limit) break;
    /*
     * **翻页没前进就停**（绝不空转）：源侧分页一旦不生效（offset 被丢、或 Oracle 的 ROWNUM
     * 深翻页到了上限），每页都会"读满"，循环就会永远跑下去、scanned 越报越大，而索引里其实
     * 只有第一页那几百条（2026-10-12 真踩过：837 行的表被报成 28000 条 / 56 页）。
     * 判据是"这一页的对象身份跟上一页完全相同" —— 正常数据不会连续两页一模一样。
     */
    const pageKey = JSON.stringify(result.rows.map((record) => record.objectRef || record.objectId || record.title));
    if (pageKey === previousPageKey) { stalled = true; break; }
    previousPageKey = pageKey;
    offset += result.rows.length;
    if (Number.isFinite(maxRows) && scanned >= maxRows) truncated = true;
  }

  if (stalled) {
    warnings.push(
      "源侧分页没有前进（每页读到的还是上一批对象），已停止：这个对象类型只物化了第一页。" +
      "请先把数据来源的分页 / 深翻页上限修好，再重新整份物化。",
    );
  }
  const synced = await getObjectIndex().syncTargetObjects(context.targetId, entries, {
    versionId: context.versionId,
    origin: "MATERIALIZED",
    /*
     * 只有"从头读到尾、没取消、没截断、没卡住"才允许 prune：
     * 断点续跑的那一趟内存里只有后半段的条目，prune 会把前半段的索引行删掉（真踩过）。
     */
    prune: !truncated && !cancelled && !stalled && startOffset === 0,
  });
  await getObjectIndex().saveMaterialization({
    targetId: context.targetId,
    entityType: entityTypeName,
    rows: synced.upserted,
    scanned,
    truncated: truncated || cancelled || stalled,
    pages,
    completedAt: new Date().toISOString(),
  });
  return {
    entityType: entityTypeName,
    // rows 是"这一次写进去的条数"；断点续跑时它只是后半段。
    rows: synced.upserted,
    scanned,
    truncated: truncated || cancelled || stalled,
    pages,
    total,
    tookMs: Date.now() - started,
    warnings,
  };
}

/**
 * 把数据源里的一个对象**取进草稿快照**（动作页 / 对象页的「取进草稿」用它）。
 *
 * 为什么要这一步：动作引擎、对象编辑都作用在草稿快照上，而数据源里的对象本体里并没有副本。
 * 因为身份是 (对象类型, 主键) 推出来的确定性 id，这一步天然幂等 —— 同一个对象取两次还是同一条，
 * 不会造出两份。返回值是草稿里的对象行（可以直接拿去编辑或当动作主对象）。
 */
export async function ensureObjectInDraft(
  context: ObjectContext,
  draftVersionId: string,
  entityTypeName: string,
  primaryKey: ObjectPrimaryKey,
): Promise<{ record: ObjectRecord; created: boolean; warnings: string[] }> {
  const { createSnapshotEntity, readVersionSnapshot } = await import("@/lib/versioning/snapshot");
  // 身份是 (对象类型, 主键) 推出来的确定性 id：草稿里有没有它，比 id 就够了，不必再比一遍属性。
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
        origin: "index",
        objectRef: objectRefOf(entityTypeName, primaryKey),
        warnings: [],
      },
      created: false,
      warnings: [],
    };
  }
  const source = await getObject(context, entityTypeName, primaryKey, { origin: "source" });
  if (!source) throw new Error(`数据资源里没有找到「${objectRefOf(entityTypeName, primaryKey)}」这个对象。`);
  /*
   * 必填属性在来源里有列、只是这行是空值 -> 照常报错（数据问题）。
   * 必填属性**根本没映射来源列** -> 取进来也永远填不上，这里直接说清楚去哪修，
   * 否则用户只会看到一句"缺少必填属性：customer_id"，不知道该改哪里（体检里这条是 WARN，不挡发布）。
   */
  const unmappedRequired = (context.definition.entityTypes.find((item) => item.name === entityTypeName)?.properties ?? [])
    .filter((property) => property.required && !(property.sourceField ?? "").trim() && !(property.name in source.properties));
  if (unmappedRequired.length) {
    throw new Error(`对象类型「${entityTypeName}」的必填属性「${unmappedRequired.map((property) => property.name).join("、")}」没有映射来源列，取进草稿也填不上值：请到「本体建模」给它选一列，或取消必填。`);
  }
  const created = await createSnapshotEntity(draftVersionId, entityTypeName, source.properties);
  return {
    record: { ...source, objectId: created.id, properties: created.properties, origin: "index" },
    created: true,
    warnings: source.warnings,
  };
}
