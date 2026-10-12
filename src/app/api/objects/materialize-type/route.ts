import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requirePermission } from "@/lib/platform/auth";
import { getObjectIndex } from "@/lib/framework/object-index";
import { materializeObjectType, resolveObjectContext } from "@/lib/instance/object-service";
import { cancelMaterializeJob, enqueueMaterializeJob, jobCursor, listMaterializeJobs } from "@/lib/instance/object-service/materialize-jobs";
import { writeAuditEntry } from "@/lib/platform/platform-db";

const materializeInput = z.object({
  targetId: z.string().uuid(),
  entityType: z.string().trim().min(1).max(200),
  versionId: z.string().uuid().optional(),
  /** 每页读多少行（源侧分页大小）。 */
  pageSize: z.number().int().min(1).max(500).optional(),
  /** 这次最多读多少行；撞到它就停下并如实回 truncated=true。 */
  maxRows: z.number().int().min(1).max(200000).optional(),
  /** 断点续跑：传上一轮任务的 id，从它已读到的位置接着读（取它的 scanned 当起点）。 */
  resumeFromJobId: z.string().uuid().optional(),
});

/**
 * **整份物化一个对象类型**（S4 第一刀）。
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
export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission("instance.write");
    const input = materializeInput.parse(await request.json());
    let startOffset = 0;
    if (input.resumeFromJobId) {
      const cursor = await jobCursor(input.resumeFromJobId);
      if (cursor === null) {
        return NextResponse.json({ error: "要续跑的那个任务找不到（内存与库里都没有）。" }, { status: 404 });
      }
      startOffset = cursor;
    }
    const job = enqueueMaterializeJob({
      targetId: input.targetId,
      entityType: input.entityType,
      versionId: input.versionId,
      pageSize: input.pageSize,
      maxRows: input.maxRows ?? null,
      startOffset,
    });
    await writeAuditEntry({
      actorId: user.id,
      targetId: input.targetId,
      action: "OBJECT_TYPE_MATERIALIZE_QUEUED",
      details: {
        entityType: input.entityType,
        jobId: job.id,
        pageSize: input.pageSize ?? 500,
        maxRows: input.maxRows ?? null,
        resumedFrom: input.resumeFromJobId ?? null,
        startOffset,
      },
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "整份物化失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
}

/**
 * 读某个本体存储下各对象类型的**物化清单**：最近一次整份物化的条数 / 扫描数 / 是否截断 / 时间。
 * 界面用它显示"哪些类型已经整份物化、哪些只补过一批、哪些还没物化"。
 */
export async function GET(request: NextRequest) {
  try {
    await requirePermission("instance.read");
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim();
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const [materializations, capabilities, stats, jobs] = await Promise.all([
      getObjectIndex().listMaterializations(targetId),
      getObjectIndex().capabilities(),
      getObjectIndex().stats(targetId),
      listMaterializeJobs(targetId),
    ]);
    return NextResponse.json({ materializations, capabilities, stats, jobs });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json(
      { error: unauthorized ? "未授权。" : apiErrorMessage(error, "读取物化清单失败。") },
      { status: unauthorized ? 401 : 400 },
    );
  }
}

/** 取消一个还没跑完的物化任务（跑完的取消无效）。 */
export async function DELETE(request: NextRequest) {
  try {
    await requirePermission("instance.write");
    const jobId = request.nextUrl.searchParams.get("jobId")?.trim();
    if (!jobId) return NextResponse.json({ error: "jobId 不能为空。" }, { status: 400 });
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
}
