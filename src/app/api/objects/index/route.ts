import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized } from "@/lib/platform/auth";
import { parsePrimaryKeyInput } from "@/lib/instance/object-identity";
import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { objectKeyOf } from "@/lib/instance/object-identity";
import { resolveObjectContext, syncObjectsToIndex } from "@/lib/instance/object-service";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { withPermission } from "@/lib/platform/route-guard";

const syncInput = z.object({
  targetId: z.string().uuid(),
  entityType: z.string().trim().min(1).max(200),
  versionId: z.string().uuid().optional(),
  /** 只同步这些主键（每个是 `列=值&列=值`）；不传就按 limit 从数据资源拉一批。 */
  keys: z.array(z.string().max(500)).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/**
 * 把业务数据写进检索索引（S3 的"改一行同步一行"）。
 *
 * 发布走的是整体同步（按快照 prune），这里走**增量**：给几个主键就只同步这几条，
 * 适合"某一行数据改了，让检索立刻跟上"的场景。
 */
export const POST = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const input = syncInput.parse(await request.json());
    const context = await resolveObjectContext(input.targetId, input.versionId);
    const result = await syncObjectsToIndex(context, input.entityType, {
      keys: input.keys?.map(parsePrimaryKeyInput),
      limit: input.limit,
    });
    await writeAuditEntry({
      actorId: user.id,
      targetId: input.targetId,
      action: "OBJECT_INDEX_SYNCED",
      details: { entityType: input.entityType, upserted: result.upserted, keys: input.keys?.length ?? 0, total: result.total },
    });
    return NextResponse.json(result);
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "同步索引失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
});

/**
 * 把指定对象从**索引里移除**（对象页对"来自索引"的对象给这个入口）。
 *
 * 只删检索副本，不动快照、不动业务库：下一次发布或整份物化会按各自来源把它重新写回来。
 * 删除按对象键（对象类型 + 主键），与写入用的是同一套身份口径。
 */
export const DELETE = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const input = syncInput.parse(await request.json());
    const context = await resolveObjectContext(input.targetId, input.versionId);
    const keys = (input.keys ?? []).map((key) => objectKeyOf(input.entityType, parsePrimaryKeyInput(key)));
    if (!keys.length) return NextResponse.json({ error: "要移除哪些对象？给 keys（`列=值&列=值`）。" }, { status: 400 });
    const deleted = await getObjectIndex().deleteObjects(context.targetId, keys);
    await writeAuditEntry({
      actorId: user.id,
      targetId: input.targetId,
      action: "OBJECT_INDEX_REMOVED",
      details: { entityType: input.entityType, deleted, keys: keys.length },
    });
    return NextResponse.json({ deleted });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "从索引移除对象失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
});
