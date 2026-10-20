import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized } from "@/lib/platform/auth";
import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { cancelMaterializeJob, enqueueMaterializeJob, jobResumePoint, listMaterializeJobs } from "@/lib/instance/object-service/materialize-jobs";
import { DEFAULT_MATERIALIZE_PAGE_SIZE, MAX_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";
import type { MaterializeCursor } from "@/lib/instance/object-service/types";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { withPermission } from "@/lib/platform/route-guard";
import { isMaterializationCurrent } from "@/lib/ontology/materialization-stamp";
import { resolveObjectContext } from "@/lib/instance/object-service";

const materializeInput = z.object({
  targetId: z.string().uuid(),
  /** 物化什么：默认对象类型（节点）；RELATIONSHIP_TYPE = 关系类型（边）。 */
  kind: z.enum(["OBJECT_TYPE", "RELATIONSHIP_TYPE"]).optional(),
  /** 对象类型名或关系类型名（由 `kind` 决定怎么解释）。 */
  entityType: z.string().trim().min(1).max(200),
  versionId: z.string().uuid().optional(),
  /**
   * 每页读多少行（源侧分页大小）。上限由 `materialize-limits` 统一给 ——
   * 读一页写一页之后页可以开大（大页 = 少几次往返、更快），但单次查询在业务库那侧也越重。
   */
  pageSize: z.number().int().min(1).max(MAX_MATERIALIZE_PAGE_SIZE).optional(),
  /** 这次最多读多少行；撞到它就停下并如实回 truncated=true。 */
  maxRows: z.number().int().min(1).max(200000).optional(),
  /** 断点续跑：传上一轮任务的 id，从它已读到的位置接着读（取它的 scanned 当起点）。 */
  resumeFromJobId: z.string().uuid().optional(),
});

/**
 * **整份物化一个类型**（S4 第一刀）：`kind` 决定是对象类型（节点）还是关系类型（边），
 * 两者都是"一个任务 = 一个类型"，进度 / 取消 / 断点续跑 / 清单完全对等。
 *
 * 口径（2026-10-12 用户要求）：物化的粒度是**对象类型**，不是"一部分行" —— 半份物化会让 `auto`
 * 读法静默截断（索引里 total > 0 就不再回源，页面显示成"这个类型只有 N 个对象"）。所以这里
 * 分页读到源读完；撞上限就停下并回 `truncated=true`，此时**不 prune**。
 *
 * **放进后台任务队列**（默认不限制行数，读到源读完为止）：一次请求读完上百万行会把连接与请求都拖死，
 * 所以这里立刻返回任务快照，进度用 `GET ?targetId=` 拉（响应里带 jobs）。
 *
 * 只写 `MATERIALIZED` 这一来源：发布与「重建索引」只替换 `SNAPSHOT`，互不覆盖。
 */
export const POST = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const input = materializeInput.parse(await request.json());
    let startOffset = 0;
    let startCursor: MaterializeCursor | null = null;
    if (input.resumeFromJobId) {
      const resume = await jobResumePoint(input.resumeFromJobId);
      if (resume === null) {
        return NextResponse.json({ error: "要续跑的那个任务找不到（内存与库里都没有）。" }, { status: 404 });
      }
      startOffset = resume.scanned;
      startCursor = resume.cursor;
    }
    const job = enqueueMaterializeJob({
      targetId: input.targetId,
      kind: input.kind,
      entityType: input.entityType,
      versionId: input.versionId,
      pageSize: input.pageSize,
      maxRows: input.maxRows ?? null,
      startOffset,
      startCursor,
    });
    await writeAuditEntry({
      actorId: user.id,
      targetId: input.targetId,
      action: "OBJECT_TYPE_MATERIALIZE_QUEUED",
      details: {
        kind: job.kind,
        entityType: input.entityType,
        jobId: job.id,
        pageSize: input.pageSize ?? DEFAULT_MATERIALIZE_PAGE_SIZE,
        maxRows: input.maxRows ?? null,
        resumedFrom: input.resumeFromJobId ?? null,
        startOffset,
        // 续跑是靠游标接着翻页还是退回 OFFSET，审计里也要看得见（排查"续跑没续上"时全靠它）。
        resumeMode: startCursor ? "CURSOR" : "OFFSET",
      },
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "整份物化失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
});

/**
 * 读某个本体存储下各对象类型的**物化清单**：最近一次整份物化的条数 / 扫描数 / 是否截断 / 时间。
 * 界面用它显示"哪些类型已经整份物化、哪些只补过一批、哪些还没物化"。
 */
export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim();
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const [materializations, capabilities, stats, jobs] = await Promise.all([
      getObjectIndex().listMaterializations(targetId),
      getObjectIndex().capabilities(),
      getObjectIndex().stats(targetId),
      listMaterializeJobs(targetId),
    ]);
    const context = await resolveObjectContext(targetId, request.nextUrl.searchParams.get("versionId"));
    return NextResponse.json({ materializations: materializations.map((item) => ({ ...item, stale: !isMaterializationCurrent(context.definition, item.entityType, item) && !item.truncated })), capabilities, stats, jobs });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json(
      { error: unauthorized ? "未授权。" : apiErrorMessage(error, "读取物化清单失败。") },
      { status: unauthorized ? 401 : 400 },
    );
  }
});

/**
 * 物化任务操作（2026-10-12）：
 * - `?jobId=` 取消一个还没跑完的任务（排队中立刻取消；运行中先标「取消中…」，等页边界再转 CANCELLED）；
 * - `?entityType=&targetId=` 清除某个**对象类型**的物化数据（保留快照对象）；
 * - `?relationshipType=&targetId=` 清除某个**关系类型**的物化边。
 */
export const DELETE = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const url = request.nextUrl;
    const entityType = url.searchParams.get("entityType")?.trim();
    if (entityType) {
      /*
       * 清除某个对象类型的**物化数据**（保留快照里的手工/动作对象）：
       * 行按 `origin = MATERIALIZED` 删，物化清单一起删（否则面板会留着一条"已物化 N 条"的假状态）。
       */
      const targetId = url.searchParams.get("targetId")?.trim();
      if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
      const deleted = await getObjectIndex().deleteTypeObjects(targetId, entityType, { origin: "MATERIALIZED" });
      await getObjectIndex().deleteMaterialization(targetId, entityType);
      await writeAuditEntry({
        actorId: user.id,
        targetId,
        action: "OBJECT_TYPE_MATERIALIZATION_CLEARED",
        details: { entityType, deleted },
      });
      return NextResponse.json({ cleared: deleted, entityType });
    }
    /*
     * 清除某个**关系类型**的物化边：只删边表里 `origin = MATERIALIZED` 的那些行，清单一起删。
     * 关系类型是双向的，所以不区分方向、一条边只删一次。
     */
    const relationshipType = url.searchParams.get("relationshipType")?.trim();
    if (relationshipType) {
      const targetId = url.searchParams.get("targetId")?.trim();
      if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
      const deleted = await getObjectIndex().deleteRelationshipLinks(targetId, relationshipType, { origin: "MATERIALIZED" });
      await getObjectIndex().deleteMaterialization(targetId, relationshipType);
      await writeAuditEntry({
        actorId: user.id,
        targetId,
        action: "RELATIONSHIP_TYPE_MATERIALIZATION_CLEARED",
        details: { relationshipType, deleted },
      });
      return NextResponse.json({ cleared: deleted, relationshipType });
    }
    const jobId = url.searchParams.get("jobId")?.trim();
    if (!jobId) return NextResponse.json({ error: "jobId、entityType 或 relationshipType 至少给一个。" }, { status: 400 });
    const job = cancelMaterializeJob(jobId);
    if (!job) return NextResponse.json({ error: "任务不存在（进程重启会丢掉内存里的任务）。" }, { status: 404 });
    return NextResponse.json({ job });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json(
      { error: unauthorized ? "未授权。" : apiErrorMessage(error, "取消物化任务失败。") },
      { status: unauthorized ? 401 : 400 },
    );
  }
});
