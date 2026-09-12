import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getObjectIndex } from "@/lib/object-index";
import { buildIndexEntries } from "@/lib/object-index/entries";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, listVersionRecords } from "@/lib/version-snapshot";

const reindexInput = z.object({
  targetId: z.string().uuid(),
  /** 不传就用当前 PUBLISHED 的那个版本。 */
  versionId: z.string().uuid().optional(),
});

/**
 * 从版本快照重建检索索引。
 *
 * 索引是派生数据，所以「重建」永远是安全操作：它不碰图库，也不碰版本记录。
 * 已有存量本体存储（发布时代码还没有索引时）靠这个接口补索引。
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = reindexInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const records = await listVersionRecords(target.id);
    const record = input.versionId ? records.find((item) => item.id === input.versionId) : records.find((item) => item.status === "PUBLISHED");
    if (!record) {
      return NextResponse.json(
        { error: input.versionId ? "该版本不存在。" : "该本体存储还没有已发布的版本，无法建立检索索引。" },
        { status: 400 },
      );
    }
    const snapshot = await ensureVersionSnapshot(record.id, target);
    const started = Date.now();
    const { indexed } = await getObjectIndex().replaceTargetObjects(
      target.id,
      buildIndexEntries(snapshot.definition, snapshot.nodes),
      { versionId: record.id },
    );
    const tookMs = Date.now() - started;
    await writeAuditEntry({
      actorId: user.id,
      targetId: target.id,
      action: "OBJECT_INDEX_REBUILT",
      details: { versionId: record.id, indexed, entityCount: snapshot.nodes.length, tookMs },
    });
    return NextResponse.json({ indexed, versionId: record.id, entityCount: snapshot.nodes.length, tookMs });
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : error instanceof Error ? error.message : "重建检索索引失败。";
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
}
