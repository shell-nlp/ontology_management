import { connectorFor, selectRowsBy } from "@/lib/instance/object-service/data-source";
import { clamp, PAGE_MEMORY_BUDGET_BYTES, rawColumn, type MaterializeTypeResult } from "@/lib/instance/object-service/common";
import { linkOrderColumns, linkReadColumns, linksFromRows } from "@/lib/instance/object-service/links";
import type { MaterializeCursor, ObjectContext } from "@/lib/instance/object-service/types";
import type { ObjectIndexLink } from "@/lib/infrastructure/object-index/types";
import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { DEFAULT_MATERIALIZE_PAGE_SIZE, MAX_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";
import { planLinkSource, type LinkSourceDefinition } from "@/lib/ontology/link-source";
import { objectKeyOf } from "@/lib/ontology/object-identity";
import { materializationStamp } from "@/lib/ontology/materialization-stamp";

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
    ...materializationStamp(context.definition, relation.name, context.versionId),
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


