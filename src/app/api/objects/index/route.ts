import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { parsePrimaryKeyInput } from "@/lib/object-identity";
import { resolveObjectContext, syncObjectsToIndex } from "@/lib/object-service";
import { writeAuditEntry } from "@/lib/platform-db";

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
export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
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
}
