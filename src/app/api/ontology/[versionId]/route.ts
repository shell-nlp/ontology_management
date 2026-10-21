import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getTarget } from "@/lib/platform/targets";
import { deleteVersionRecord, ensureVersionSnapshot, getVersionRecord, updateSnapshotDefinition, withTargetLock } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";
import { getOdsStore } from "@/lib/infrastructure/ods";

export const PATCH = withPermission("ontology.write", async (request: NextRequest, context: { params: Promise<{ versionId: string }> }, user) => {
  try {
    const { versionId } = await context.params;
    const definition = ontologyDefinitionSchema.parse((await request.json()).definition);
    const version = await getVersionRecord(versionId);
    if (!version) return NextResponse.json({ error: "本体草稿不存在。" }, { status: 404 });
    if (version.status !== "DRAFT") return NextResponse.json({ error: "已发布版本不可直接修改，请创建新草稿。" }, { status: 409 });
    const target = await getTarget(version.target_id);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(versionId, target);
    const savedDefinition = await updateSnapshotDefinition(versionId, definition);
    await writeAuditEntry({ actorId: user.id, targetId: version.target_id, action: "VERSION_DEFINITION_UPDATED", details: { versionId } });
    return NextResponse.json({ saved: true, definition: savedDefinition });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存草稿失败。") }, { status: apiErrorStatus(error) });
  }
});

export const DELETE = withPermission("ontology.version.delete", async (_request: NextRequest, context: { params: Promise<{ versionId: string }> }, user) => {
  try {
    const { versionId } = await context.params;
    const initial = await getVersionRecord(versionId);
    if (!initial) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });

    return await withTargetLock(initial.target_id, async () => {
      const version = await getVersionRecord(versionId);
      if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
      if (version.status === "PUBLISHED") {
        return NextResponse.json(
          { error: "当前生效版本不能删除，请先激活其他完整的历史版本，再删除不再需要的版本。" },
          { status: 409 },
        );
      }

      await getOdsStore().deleteVersionChanges(versionId);
      await deleteVersionRecord(versionId);
      await writeAuditEntry({
        actorId: user.id,
        targetId: version.target_id,
        action: "VERSION_DELETED",
        details: { versionId, versionNumber: version.version_number, status: version.status },
      });
      return NextResponse.json({ deleted: true, versionNumber: version.version_number, status: version.status });
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "删除版本失败。") }, { status: apiErrorStatus(error) });
  }
});
