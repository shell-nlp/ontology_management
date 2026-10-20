import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized } from "@/lib/platform/auth";
import { getObjectIndex } from "@/lib/infrastructure/object-index";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getTarget } from "@/lib/platform/targets";
import { ensureVersionSnapshot, listVersionRecords } from "@/lib/versioning/snapshot";
import { enqueueMaterializeJob } from "@/lib/instance/object-service/materialize-jobs";
import { withPermission } from "@/lib/platform/route-guard";

const reindexInput = z.object({
  targetId: z.string().uuid(),
  /** 不传就用当前 PUBLISHED 的那个版本。 */
  versionId: z.string().uuid().optional(),
  /**
   * 整库重建：先把**物化那一份**清掉（连同物化清单），重建快照索引后，把可物化的类型重新排队。
   * 不传 = 只重建快照那一份（原来的行为，不动物化数据）。
   */
  rebuildMaterialized: z.boolean().optional(),
});

/**
 * 从版本快照重建检索索引。
 *
 * 索引是派生数据，所以「重建」永远是安全操作：它不碰图库，也不碰版本记录。
 * 已有存量本体存储（发布时代码还没有索引时）靠这个接口补索引。
 */
export const POST = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
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
    let clearedMaterialized = 0;
    if (input.rebuildMaterialized) {
      // 整库重来：先把物化那一份与它的清单清掉（快照对象在下一步按快照重建）。
      clearedMaterialized = await getObjectIndex().deleteOriginObjects(target.id, "MATERIALIZED");
      const manifests = await getObjectIndex().listMaterializations(target.id);
      for (const item of manifests) await getObjectIndex().deleteMaterialization(target.id, item.entityType);
    }
    const { indexed } = await getObjectIndex().replaceTargetObjects(
      target.id,
      [], // Version edits are read from PostgreSQL and never copied over source materializations.
      // 重建索引只重建"快照那一份"：整份物化进来的业务对象不在这次替换范围内。
      { versionId: record.id, origin: "SNAPSHOT" },
    );
    let requeued = 0;
    if (input.rebuildMaterialized) {
      // 重建完再把"可物化"的类型重新排队：FEDERATED 按策略不进索引，没绑来源的读不出数据。
      for (const type of snapshot.definition.entityTypes) {
        const policy = type.indexPolicy ?? "AUTO";
        if (policy === "FEDERATED") continue;
        if (!type.sources?.[0]?.view) continue;
        enqueueMaterializeJob({ targetId: target.id, entityType: type.name, versionId: record.id });
        requeued += 1;
      }
    }
    const tookMs = Date.now() - started;
    await writeAuditEntry({
      actorId: user.id,
      targetId: target.id,
      action: "OBJECT_INDEX_REBUILT",
      details: { versionId: record.id, indexed, entityCount: snapshot.nodes.length, tookMs, clearedMaterialized, requeued },
    });
    return NextResponse.json({ indexed, versionId: record.id, entityCount: snapshot.nodes.length, tookMs, clearedMaterialized, requeued });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "重建检索索引失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
});
