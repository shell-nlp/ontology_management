import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, getVersionRecord, updateSnapshotDefinition } from "@/lib/version-snapshot";

export async function PATCH(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存草稿失败。" }, { status: 400 });
  }
}
