import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { DEFAULT_MATERIALIZE_PAGE_SIZE, MAX_MATERIALIZE_PAGE_SIZE, MIN_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";
import { buildIndexEntry } from "@/lib/instance/object-index/entries";
import type { ObjectIndexEntry } from "@/lib/infrastructure/object-index/types";
import { objectIdOf, objectKeyOf, objectRefOf, primaryKeyColumns, propertyForColumn, type ObjectPrimaryKey } from "@/lib/ontology/object-identity";
import { connectorFor, createDataSourceObjectSource, selectRowsBy } from "@/lib/instance/object-service/data-source";
import { linkOrderColumns, linkReadColumns, linksFromRows } from "@/lib/instance/object-service/links";
import { planLinkSource, type LinkSourceDefinition } from "@/lib/ontology/link-source";
import type { MaterializeCursor, ObjectContext, ObjectQuery, ObjectQueryResult, ObjectOrigin, ObjectRecord, ObjectSource } from "@/lib/instance/object-service/types";
import type { ObjectIndexLink } from "@/lib/infrastructure/object-index/types";
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
 * **不限对象类型**地查对象（对象页「全部标签」用它）。
 *
 * 只能走索引：回源得先知道是哪张表，「全部标签」没有单一来源可回。
 * 所以索引里没有就如实说"还没物化"，不假装有数据。
 */
export async function queryAllObjects(
  context: ObjectContext,
  query: { text?: string; limit?: number; offset?: number } = {},
): Promise<ObjectQueryResult> {
  const started = Date.now();
  const limit = clamp(query.limit, 1, 200, 20);
  const offset = clamp(query.offset, 0, 100000, 0);
  const result = await getObjectIndex().searchObjects({
    targetId: context.targetId,
    labels: [],
    text: query.text,
    limit,
    offset,
  });
  return {
    entityType: "",
    rows: result.hits.map((hit) => recordFromEntry(hit, "index")),
    total: result.total,
    origin: "index",
    warnings: result.total > 0 ? [] : ["对象索引里还没有对象：先在「索引与物化」整份物化，或发布一版快照。"],
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
): Promise<{ upserted: number; total: number | null; warnings: string[] }> {
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
        sourceRows: entries.length,
        scanned: entries.length,
        // 这条路径只是「补一批」，不整份读源，算不出折叠数（folded 只在整份物化那一次有意义）。
        folded: 0,
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
  /** 源里被主键折叠掉的行数（读过的行 - 去重后的对象数）。只在整份读完之后算得出来。 */
  folded: number;
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
    /**
     * 断点续跑的**游标**（上一轮任务落库的那个）：给了就接着用键集翻页，
     * 不再退回 OFFSET —— 大表中断之后只有这条路能续上。
     */
    startCursor?: MaterializeCursor | null;
    onProgress?: (progress: { scanned: number; rows: number; pages: number; cursor?: MaterializeCursor | null }) => void;
    shouldCancel?: () => boolean;
  } = {},
): Promise<MaterializeTypeResult> {
  const started = Date.now();
  const source = getObjectSource();
  // 页大小：默认 2000。读一页写一页之后，内存只跟页大小成正比，所以页可以开大 —— 往返次数直接降下来。
  let pageSize = clamp(options.pageSize, 1, MAX_MATERIALIZE_PAGE_SIZE, DEFAULT_MATERIALIZE_PAGE_SIZE);
  /**
   * 这一趟的**运行号**（毫秒时间戳，整数）：这一趟写进去的每一行都盖它，收尾时凭它清掉"这次没读到的旧行"。
   * 用整数而不是时间列，是因为时间列的比较要过时区解析 —— 实测 CH 服务器是 Asia/Shanghai、
   * 写入是 UTC，prune 会差 8 小时、一条都删不掉。
   */
  const runId = Date.now();
  // **默认不限制**（2026-10-12 用户口径）：不传 maxRows 就是"读到源读完"。
  // 传了正数才是硬上限（撞上就 truncated=true 且不 prune，如实报数）。
  const maxRows = typeof options.maxRows === "number" && options.maxRows > 0 ? Math.floor(options.maxRows) : Number.POSITIVE_INFINITY;
  // 断点续跑：offset/scanned 从断点开始（第一页就是"接着上次没读完的那一行"）。
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));

  /*
   * 深表翻页走**键集（游标）**：按主键列升序排，下一页只取"排序键 > 上一页最后一个键"的行。
   * 为什么：OFFSET 在深表上又慢（Oracle 要把前面几页读出来再丢掉，还有硬上限），
   * 而游标每页都等价于点查。只有"从头读"才用游标 —— 断点续跑只存了条数（scanned），还原不出游标。
   * 主键列没配全、或某一列没映射到属性时，退回 OFFSET 翻页（此时靠下面的"翻页没前进"兜底）。
   */
  const cursorColumns: string[] = [];
  const cursorProperties: string[] = [];
  const startCursor = options.startCursor && options.startCursor.columns.length ? options.startCursor : null;
  if (startCursor || startOffset === 0) {
    const entityType = context.definition.entityTypes.find((item) => item.name === entityTypeName);
    if (entityType) {
      // 续跑用**落库的那组列**（期间改过主键就别硬套）；从头读用当前主键。
      const columns = startCursor ? startCursor.columns : primaryKeyColumns(entityType);
      const properties = columns.map((column) => propertyForColumn(entityType, column));
      if (columns.length && properties.every(Boolean)) {
        cursorColumns.push(...columns);
        cursorProperties.push(...properties);
      }
    }
  }
  /**
   * 跑一整趟读取。`useCursor=false` 时走 OFFSET，专门给"主键不唯一导致游标漏行"做兜底重读。
   *
   * **读一页、写一页**（2026-10-14）：以前是"整份读完再写"，内存跟行数成正比，千万行必 OOM；
   * 现在内存只跟页大小成正比。代价是中途停下时索引里会短暂出现"本次新读的 + 上一次剩下的"混合
   * （每个对象键仍然只有一行，不会重复也不会丢），所以每行都盖这一趟的版本戳、收尾按版本清旧行，
   * 没跑完就在告警里如实说 —— 半份必须显形，不能让人以为数据就这么多。
   */
  const readPages = async (input: { startOffset: number; useCursor: boolean; reportProgress: boolean }) => {
    const readWarnings: string[] = [];
    /** 这一趟写进索引的条数（兜底重读时以最后一趟为准）。 */
    let written = 0;
    /** 内存护栏只量一次（拿第一页的重量估），量完就不再反复调页大小。 */
    let memoryChecked = false;
    let offset = input.startOffset;
    let pages = 0;
    let scanned = input.startOffset;
    let total: number | null = null;
    let truncated = false;
    let cancelled = false;
    let stalled = false;
    /** 这一趟**读到了源尾**（最后一页没读满 = 源给完了）。续跑跑完也算。 */
    let reachedEnd = false;
    let cursorActive = input.useCursor && cursorColumns.length > 0;
    // 续跑：落库的游标只在"列完全一致"时采用（否则宁可退回 OFFSET，也不拿错列去翻页）。
    let cursorValues: unknown[] | null =
      input.useCursor && startCursor && startCursor.columns.join("\u0001") === cursorColumns.join("\u0001") ? startCursor.values : null;
    /** 上一页的"身份签名"：整整一页跟上一页一模一样 = 源侧分页没前进。 */
    let previousPageKey: string | null = null;

    while (scanned < maxRows) {
      if (options.shouldCancel?.()) { cancelled = true; break; }
      const limit = Number.isFinite(maxRows) ? Math.min(pageSize, maxRows - scanned) : pageSize;
      // 第一页也按同一组列排序（此时还没有 values）：否则第一页无序，游标会从中间插进去 —— 既漏行又重复读。
      const useCursor = cursorActive ? { columns: cursorColumns, ...(cursorValues ? { values: cursorValues } : {}) } : null;
      // 只有第一页问总数：物化不需要每页都 COUNT(*)；游标翻页时 offset 让位给游标（传 0）。
      const result = await source.query(context.definition, entityTypeName, {
        entityType: entityTypeName,
        limit,
        offset: useCursor ? 0 : offset,
        count: pages === 0,
        // 自己在翻页：这一页读满 500 不是"被截断"，别刷假告警。
        paging: true,
        ...(useCursor ? { cursor: useCursor } : {}),
      });
      readWarnings.push(...result.warnings);
      if (total === null && Number.isFinite(result.total)) total = result.total;
      pages += 1;
      scanned += result.rows.length;

      const pageEntries: ObjectIndexEntry[] = [];
      for (const record of result.rows) {
        if (record.objectId) {
          pageEntries.push(buildIndexEntry(context.definition, { id: record.objectId, labels: [entityTypeName], properties: record.properties }));
        }
      }
      // **读一页写一页**：写完这一页就把它放掉，下一轮只留下一页。
      if (pageEntries.length) {
        const pageSynced = await getObjectIndex().syncTargetObjects(context.targetId, pageEntries, {
          versionId: context.versionId,
          origin: "MATERIALIZED",
          runId,
          // 每页都写，别每页再数一遍总数（带 FINAL 的全量 count，每页一次等于白烧时间）。
          skipTotal: true,
          // 逐页写绝不能 prune：这一页之外的行不该在这一页被删掉（收尾统一清，见 pruneStaleObjects）。
          prune: false,
        });
        written += pageSynced.upserted;
      }
      /*
       * 内存护栏：拿第一页量一下"一条多大"。宽表（属性多、检索文本长）一页两万行能吃几百 MB，
       * 宁可多跑几次往返也不能把进程撑爆 —— 超预算就把页大小降到预算之内。
       */
      if (!memoryChecked) {
        memoryChecked = true;
        const bytesPerEntry = averageEntryBytes(pageEntries);
        if (bytesPerEntry > 0 && bytesPerEntry * pageSize > PAGE_MEMORY_BUDGET_BYTES) {
          const next = Math.max(MIN_MATERIALIZE_PAGE_SIZE, Math.floor(PAGE_MEMORY_BUDGET_BYTES / bytesPerEntry));
          readWarnings.push(
            `索引条目平均约 ${Math.round(bytesPerEntry / 1024)} KB，${pageSize} 行一页要约 ${Math.round((bytesPerEntry * pageSize) / 1024 / 1024)} MB：` +
              `已把每页降到 ${next} 行，避免把内存撑爆（大表宁可多几次往返）。`,
          );
          pageSize = Math.min(pageSize, next);
        }
      }
      /*
       * "这一页没读满 = 源读完了"里的"满"，要用**连接器实际给的上限**（result.limit），
       * 而不是我们请求的页大小：请求 20000 而连接器只给 5000 时，拿 20000 判会把
       * "连接器给了 5000" 误判成"源读完了"，然后报一句"只读到 5000 行"（实测踩过）。
       * 顺手把页大小降到连接器认的上限，后面几页就别再白问一次了。
       */
      const effectiveLimit = result.limit > 0 ? result.limit : limit;
      if (pageSize > effectiveLimit) pageSize = effectiveLimit;
      if (result.rows.length < effectiveLimit) {
        reachedEnd = true;
        break;
      }
      /*
       * **翻页没前进就停**（绝不空转）：源侧分页一旦不生效（offset 被丢、或 Oracle 的 ROWNUM
       * 深翻页到了上限），每页都会"读满"，循环就会永远跑下去、scanned 越报越大，而索引里其实
       * 只有第一页那几百条（2026-10-12 真踩过：837 行的表被报成 28000 条 / 56 页）。
       * 判据是"这一页的对象身份跟上一页完全相同" —— 正常数据不会连续两页一模一样。
       */
      const pageKey = JSON.stringify(result.rows.map((record) => record.objectRef || record.objectId || record.title));
      if (pageKey === previousPageKey) { stalled = true; break; }
      previousPageKey = pageKey;
      /*
       * 下一页的游标 = 这一页最后一行的主键值（取**原始列值**，不是规范化后的字符串：
       * 日期之类按原始类型绑回去才比得准）。主键值拿不全就退回 OFFSET 翻页，绝不带半个游标往下走。
       */
      if (cursorActive) {
        const last = result.rows[result.rows.length - 1];
        const next = last ? cursorProperties.map((property) => last.properties[property]) : null;
        if (next && next.every((value) => value !== undefined && value !== null)) {
          cursorValues = next;
        } else {
          cursorActive = false;
          cursorValues = null;
        }
      }
      offset += result.rows.length;
      if (Number.isFinite(maxRows) && scanned >= maxRows) truncated = true;
      /*
       * 进度**在游标推进之后再报**：这样任务表里存的就是"上一页最后一行"的位置，
       * 中断后续跑接着用键集翻页（只存条数是还原不出来的）。
       */
      if (input.reportProgress) {
        options.onProgress?.({
          scanned,
          rows: written,
          pages,
          cursor: cursorActive && cursorValues ? { columns: [...cursorColumns], values: [...cursorValues] } : null,
        });
      }
    }

    if (stalled) {
      readWarnings.push(
        "源侧分页没有前进（每页读到的还是上一批对象），已停止：这个对象类型只物化了第一页。" +
        "请先把数据来源的分页 / 深翻页上限修好，再重新整份物化。",
      );
    }
    return { written, warnings: readWarnings, pages, scanned, total, truncated, cancelled, stalled, reachedEnd };
  };

  // "游标少读 → OFFSET 兜底重读"只对**从头读**那一趟有意义；续跑那趟本来就只读后半段。
  const cursorAttempted = startOffset === 0 && !startCursor && cursorColumns.length > 0;
  // 有落库游标就用键集接着翻（哪怕 startOffset > 0）；没有才退回 OFFSET。
  let read = await readPages({ startOffset, useCursor: cursorColumns.length > 0 && (startOffset === 0 || Boolean(startCursor)), reportProgress: true });

  /*
   * 主键游标的严格 `k > last` 在两个页边界遇到重复主键时，会跳过同一主键的其它行。
   * 这不是"主键折叠"的显示问题，而是真少读：游标读完后拿源侧总数对账，一旦少读就从 0 用 OFFSET 重读。
   * 小表兜底能读全；大表若 OFFSET 也不可用，宁可让任务失败，也绝不把半份写成"物化完成"。
   */
  if (
    startOffset === 0 &&
    !startCursor &&
    !read.truncated &&
    !read.cancelled &&
    !read.stalled &&
    typeof read.total === "number" &&
    read.total > read.scanned
  ) {
    if (!cursorAttempted) {
      throw new Error(
        `源里共 ${read.total} 行，这一趟只读到 ${read.scanned} 行：当前分页方式没有读全。` +
          "请改用取数口径（先去重），或者把主键换成真正唯一的键。",
      );
    }
    const cursorScanned = read.scanned;
    const sourceTotal = read.total;
    const cursorWarnings = [
      ...read.warnings,
      `主键游标分页只读到 ${cursorScanned}/${sourceTotal} 行（重复主键在页边界被跳过），已自动改用 OFFSET 从头重读。`,
    ];
    try {
      read = await readPages({ startOffset: 0, useCursor: false, reportProgress: false });
      read.warnings.unshift(...cursorWarnings);
    } catch (error) {
      throw new Error(
        `主键在源数据里不唯一，主键游标只读到 ${cursorScanned}/${sourceTotal} 行；` +
          `OFFSET 兜底重读失败：${error instanceof Error ? error.message : String(error)}。` +
          "请改用取数口径（先去重），或者把主键换成真正唯一的键。",
      );
    }
    options.onProgress?.({ scanned: read.scanned, rows: read.written, pages: read.pages });
    if (
      !read.truncated &&
      !read.cancelled &&
      !read.stalled &&
      typeof read.total === "number" &&
      read.total > read.scanned
    ) {
      throw new Error(
        `源里共 ${read.total} 行，主键游标和 OFFSET 兜底都只读到 ${read.scanned} 行，不能把半份当完成。` +
          "请改用取数口径（先去重），或者把主键换成真正唯一的键。",
      );
    }
  }

  const { written, warnings, pages, scanned, total, truncated, cancelled, stalled, reachedEnd } = read;

  /*
   * 收尾：把这一趟**没读到**的旧行清掉（源里已经没有了）。判据是版本 —— 每一页写进去的行都盖了
   * 这一趟的版本戳，比它旧的就是上一次留下的。
   *
   * **只有"从头跑到尾、没截断、没取消、没卡住"那一趟才清**：续跑那趟只写了后半段，
   * 按版本清会把前半段一起删掉（2026-10-12 真踩过）。清失败不影响这次写进去的数据，如实报出来。
   */
  let pruned = 0;
  if (!truncated && !cancelled && !stalled && startOffset === 0) {
    try {
      pruned = await getObjectIndex().pruneStaleObjects(context.targetId, entityTypeName, { origin: "MATERIALIZED", runId });
    } catch (error) {
      warnings.push(
        `旧行没清掉（这次写进去的数据不受影响）：${error instanceof Error ? error.message : "未知错误"}。重跑一次会再清一遍。`,
      );
    }
  }
  /*
   * 没读到源尾就得说清楚索引现在是什么状态：流式之后"半份"是真实存在的中间态，
   * 不说的话用户会以为这个类型就这么多对象（每条仍然只有一行，不会重复也不会丢）。
   */
  /*
   * 只有**确实没读到源尾**才说"混合"。续跑跑完（reachedEnd）时数据是完整的，
   * 再补一句"没读到源尾"只会让人以为还差一截 —— 告警说错话比不说更糟。
   */
  if (!reachedEnd) {
    warnings.push(
      "这一趟没读到源尾：索引里现在是「本次新读的 + 上一次剩下的」混合（每个对象键仍然只有一行）。" +
        "从断点继续、或者重跑一次整份物化，旧行就会被清掉。",
    );
  }
  /*
   * **主键重复必须报数**（2026-10-13）：源里读了多少行、实际落下几个对象，差出来的就是被折叠掉的行数。
   * 只有「从头读完、没截断、没取消、没卡住」那一次才算得准 —— prune 之后索引里就是这个类型这一趟的全部对象。
   * 计数走索引（一条 COUNT），**不在内存里攒对象键的 Set**：大表会把内存撑爆。
   * 有了这个数，用户才不会以为「源里就这么多」，也就不会把主键选错当成数据不全。
   */
  let folded = 0;
  if (!truncated && !cancelled && !stalled && startOffset === 0) {
    /*
     * **少读了几行也要说**（2026-10-13）：主键在源数据里不唯一时，主键游标翻页在页边界会跳过同一主键剩下的行
     * —— `k > 上一页最后一个 k` 永远够不到重复值。源侧报过总数、这一趟又是从头读完的，就对一下账。
     * 这条不拦任务，但必须写出来：静默少读就是 bug。
     */
    if (typeof total === "number" && total > scanned) {
      warnings.push(
        `源里共 ${total} 行，这一趟只读到 ${scanned} 行：主键在源数据里不唯一时，主键游标翻页会在页边界跳过同一主键的其它行。` +
          "请改用取数口径（先去重），或者把主键换成真正唯一的键。",
      );
    }
    try {
      const objects = await getObjectIndex().countTypeObjects(context.targetId, entityTypeName, { origin: "MATERIALIZED" });
      folded = Math.max(0, scanned - objects);
    } catch (error) {
      warnings.push(`没能核对主键是否唯一：${error instanceof Error ? error.message : "未知错误"}`);
    }
    if (folded > 0) {
      warnings.push(
        `源里读了 ${scanned} 行，按主键去重后只有 ${scanned - folded} 个对象（折叠掉 ${folded} 行）：` +
          "这个对象类型的主键列在源数据里不唯一，重复的行被并进了同一个对象。" +
          "请改主键（或换成组合键），或者在取数口径里先去重（例如按业务键取最新一行）。",
      );
    }
  }
  await getObjectIndex().saveMaterialization({
    targetId: context.targetId,
    entityType: entityTypeName,
    rows: written,
    sourceRows: total ?? scanned,
    scanned,
    folded,
    truncated: truncated || cancelled || stalled,
    pages,
    completedAt: new Date().toISOString(),
  });
  return {
    entityType: entityTypeName,
    // rows 是"这一次写进去的条数"；断点续跑时它只是后半段。
    rows: written,
    scanned,
    folded,
    truncated: truncated || cancelled || stalled,
    pages,
    total,
    tookMs: Date.now() - started,
    warnings,
  };
}

/**
 * 单页条目的内存预算。超过就把页大小降到预算之内 ——
 * 宽表（属性多、检索文本长）一页两万行也能吃掉几百 MB，宁可多几次往返也不能把进程撑爆。
 */
const PAGE_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * 估一页条目平均占多少字节（字符数按 UTF-8 粗算 1.5 倍）—— 只用来做内存护栏，不求精确。
 * 空页返回 0，调用方按"量不出来"处理。
 */
function averageEntryBytes(entries: readonly ObjectIndexEntry[]): number {
  if (!entries.length) return 0;
  let chars = 0;
  for (const entry of entries) {
    chars += (entry.searchText?.length ?? 0) + (entry.title?.length ?? 0) + (entry.properties ? JSON.stringify(entry.properties).length : 0);
  }
  return Math.ceil((chars / entries.length) * 1.5);
}

/** 行里的列名大小写由库决定（Oracle 折成大写）：按小写找，取**原始值**（游标要用原值绑回去）。 */
function rawColumn(row: Record<string, unknown>, column: string): unknown {
  const target = column.trim().toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/**
 * **按关系类型整份物化**（边）。
 *
 * 和对象侧对称：一个任务 = 一个关系类型，默认读到连接表读完；撞 `maxRows` 才截断且不 prune。
 * 三条与对象侧一致的口径：
 * 1. **游标翻页**（按键映射落到的那些列排序），offset 恒为 0 —— 深表不受 Oracle 的 OFFSET 上限影响；
 *    断点续跑只存了条数、还原不出游标，所以续跑那趟退回 offset。
 * 2. **翻页没前进就停**：相邻两页解出来的边完全相同 = 分页卡住，停下并如实报，绝不空转。
 * 3. **prune 只在这个关系类型里**（`pruneRelationshipType`）——否则物化 A 会删掉 B 的边。
 *
 * 两端对象类型没物化也能先物化边：读的时候端点解析不出来会被如实报数（不静默丢）。
 */
export async function materializeRelationshipType(
  context: ObjectContext,
  relationshipTypeName: string,
  options: {
    pageSize?: number;
    maxRows?: number | null;
    startOffset?: number;
    /** 同对象侧：断点续跑的游标（落库的那个），给了就接着用键集翻页。 */
    startCursor?: MaterializeCursor | null;
    onProgress?: (progress: { scanned: number; rows: number; pages: number; cursor?: MaterializeCursor | null }) => void;
    shouldCancel?: () => boolean;
  } = {},
): Promise<MaterializeTypeResult> {
  const started = Date.now();
  const definition = context.definition as unknown as LinkSourceDefinition;
  const relation = definition.relationshipTypes.find((item) => item.name === relationshipTypeName || item.id === relationshipTypeName);
  if (!relation) throw new Error(`本体里没有关系类型「${relationshipTypeName}」。`);
  const plan = planLinkSource(definition, relation);
  if (!plan.ok) throw new Error(plan.reason);

  // 与对象侧同一套口径：页默认 2000、上限跟连接器对齐（读一页写一页，内存只跟页走）。
  let pageSize = clamp(options.pageSize, 1, MAX_MATERIALIZE_PAGE_SIZE, DEFAULT_MATERIALIZE_PAGE_SIZE);
  /** 这一趟的运行号（整数）：收尾按它清"这次没读到的旧边"。 */
  const runId = Date.now();
  const maxRows = typeof options.maxRows === "number" && options.maxRows > 0 ? Math.floor(options.maxRows) : Number.POSITIVE_INFINITY;
  const startOffset = Math.max(0, Math.floor(options.startOffset ?? 0));
  const columns = linkReadColumns(relation, plan);
  const table = { schema: plan.table.schema, view: plan.table.name };
  // 有落库游标也要拿排序键（续跑接着用键集翻页）；只有"既不是从头、又没有游标"才退回 OFFSET。
  const startCursor = options.startCursor && options.startCursor.columns.length ? options.startCursor : null;
  const orderColumns = startOffset === 0 || startCursor ? linkOrderColumns(plan) : [];
  let cursorActive = orderColumns.length > 0;
  let cursorValues: unknown[] | null =
    startCursor && startCursor.columns.join("\u0001") === orderColumns.join("\u0001") ? startCursor.values : null;
  let offset = startOffset;
  let pages = 0;
  let scanned = startOffset;
  let total: number | null = null;
  let truncated = false;
  let cancelled = false;
  let stalled = false;
  /** 这一趟**读到了源尾**（最后一页没读满 = 源给完了）。 */
  let reachedEnd = false;
  let previousPageKey: string | null = null;
  const warnings: string[] = [];
  /** 这一趟写进索引的边数。 */
  let written = 0;
  const connector = (await connectorFor(plan.dataSourceId)).connector;

  while (scanned < maxRows) {
    if (options.shouldCancel?.()) { cancelled = true; break; }
    const limit = Number.isFinite(maxRows) ? Math.min(pageSize, maxRows - scanned) : pageSize;
    const cursor = cursorActive ? { columns: orderColumns, ...(cursorValues ? { values: cursorValues } : {}) } : null;
    const result = await selectRowsBy(
      plan.dataSourceId,
      table,
      columns,
      [],
      cursor
        ? { limit, offset: 0, orderBy: cursor.columns, after: cursor.values }
        : { limit, offset },
      warnings,
    );
    if (total === null && connector.countRows) {
      try {
        total = await connector.countRows({ view: { schema: plan.table.schema || undefined, name: plan.table.name } });
      } catch { total = null; }
    }
    const decoded = linksFromRows(relation, plan, result.rows);
    /*
     * 边也**读一页写一页**。以前那个 `seen` 是整趟的去重集合，会跟着数据量一起涨（千万条边就是 GB 级）；
     * 现在只按页去重（连接表在同一页里扇出成多条边是最常见的情况），跨页重复的边交给索引自己收敛 ——
     * 边表的唯一键是 (关系类型, 起点键, 终点键)，ReplacingMergeTree 会把同一条边只留一行。
     */
    const pageSeen = new Set<string>();
    const pageLinks: ObjectIndexLink[] = [];
    for (const link of decoded.links) {
      const key = `${link.relationshipTypeId}|${link.source.objectId}|${link.target.objectId}`;
      if (pageSeen.has(key)) continue;
      pageSeen.add(key);
      pageLinks.push({
        relationshipType: link.relationshipType,
        relationshipTypeId: link.relationshipTypeId,
        source: { entityType: link.source.entityType, objectKey: objectKeyOf(link.source.entityType, link.source.primaryKey), objectId: link.source.objectId },
        target: { entityType: link.target.entityType, objectKey: objectKeyOf(link.target.entityType, link.target.primaryKey), objectId: link.target.objectId },
        properties: link.properties,
      });
    }
    if (pageLinks.length) {
      const pageSynced = await getObjectIndex().syncTargetLinks(context.targetId, pageLinks, {
        versionId: context.versionId,
        origin: "MATERIALIZED",
        runId,
        skipTotal: true,
        // 逐页写不 prune：这一页之外的边不该在这一页被删掉（收尾统一清）。
        prune: false,
      });
      written += pageSynced.upserted;
    }
    if (decoded.skipped) {
      warnings.push(`关系类型「${relation.name}」有 ${decoded.skipped} 行的键不全（连接列是空值），这些行没有取成边。`);
    }
    pages += 1;
    scanned += result.rows.length;
    // 同上：用连接器**实际**给的上限判断读没读完（它自己还有一层硬上限，Oracle 那条是 5000）。
    const effectiveLimit = result.rowLimit > 0 ? result.rowLimit : limit;
    if (pageSize > effectiveLimit) pageSize = effectiveLimit;
    if (result.rows.length < effectiveLimit) {
      reachedEnd = true;
      break;
    }
    const pageKey = JSON.stringify(result.rows.map((row) => orderColumns.map((column) => rawColumn(row, column)).join("\u0001")));
    if (pageKey === previousPageKey) { stalled = true; break; }
    previousPageKey = pageKey;
    if (cursorActive) {
      const last = result.rows[result.rows.length - 1];
      const next = last ? orderColumns.map((column) => {
        const value = rawColumn(last, column);
        return typeof value === "string" ? value.trim() : value;
      }) : null;
      if (next && next.every((value) => value !== undefined && value !== null && value !== "")) cursorValues = next;
      else { cursorActive = false; cursorValues = null; }
    }
    offset += result.rows.length;
    if (Number.isFinite(maxRows) && scanned >= maxRows) truncated = true;
    // 与对象侧一致：游标推进之后再报进度，任务表里存的才是"能接着续"的位置。
    options.onProgress?.({
      scanned,
      rows: written,
      pages,
      cursor: cursorActive && cursorValues ? { columns: [...orderColumns], values: [...cursorValues] } : null,
    });
  }

  if (stalled) {
    warnings.push(
      "连接表分页没有前进（每页读到的还是上一批），已停止：这个关系类型只物化了第一页。" +
      "请先把连接表的分页 / 排序键修好，再重新整份物化。",
    );
  }
  /*
   * 收尾：清掉这个关系类型里**版本早于本趟**、也就是这次没读到的旧边。
   * 同样只在"从头跑到尾、没截断没取消"那一趟清（续跑那趟只写了后半段，按版本清会误删前半段）。
   */
  if (!truncated && !cancelled && !stalled && startOffset === 0) {
    try {
      await getObjectIndex().pruneStaleLinks(context.targetId, relation.name, { origin: "MATERIALIZED", runId });
    } catch (error) {
      warnings.push(`旧边没清掉（这次写进去的边不受影响）：${error instanceof Error ? error.message : "未知错误"}。重跑一次会再清一遍。`);
    }
  }
  // 同对象侧：确实没读到源尾才说"混合"（续跑跑完时数据是完整的）。
  if (!reachedEnd) {
    warnings.push(
      "这一趟没读到源尾：索引里现在是「本次新读的 + 上一次剩下的」混合（同一条边仍然只留一行）。" +
        "从断点继续、或者重跑一次整份物化，旧边就会被清掉。",
    );
  }
  await getObjectIndex().saveMaterialization({
    targetId: context.targetId,
    entityType: relation.name,
    rows: written,
    sourceRows: total ?? scanned,
    scanned,
    // 边没有「主键重复折叠」这回事：同一条边的重复行本来就该合成一条。
    folded: 0,
    truncated: truncated || cancelled || stalled,
    pages,
    completedAt: new Date().toISOString(),
  });
  return {
    entityType: relation.name,
    rows: written,
    scanned,
    folded: 0,
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
  const [{ createSnapshotEntity }, { readVersionSnapshot }] = await Promise.all([
    import("@/lib/instance/snapshot-editing"),
    import("@/lib/versioning/snapshot"),
  ]);
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
