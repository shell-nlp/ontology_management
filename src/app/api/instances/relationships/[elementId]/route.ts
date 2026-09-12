import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getTarget } from "@/lib/targets";
import { writeAuditEntry } from "@/lib/platform-db";
import { deleteSnapshotRelationship, ensureVersionSnapshot, updateSnapshotRelationship } from "@/lib/version-snapshot";

const patchSchema = z.object({ properties: z.record(z.string(), z.unknown()).default({}) });

function targetIdOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("targetId") ?? "";
}

function versionIdOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("versionId") ?? "";
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ elementId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { elementId } = await context.params;
    const input = patchSchema.parse(await request.json());
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = versionIdOf(request);
    if (!versionId) return NextResponse.json({ error: "修改关系必须指定草稿 versionId。" }, { status: 400 });
    await ensureVersionSnapshot(versionId, target);
    const updated = await updateSnapshotRelationship(versionId, elementId, input.properties);
    if (!updated) return NextResponse.json({ error: "关系不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_RELATIONSHIP_UPDATED", details: { versionId, relationshipId: elementId } });
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法更新关系。";
    return NextResponse.json({ error: message }, { status: message === "UNAUTHORIZED" ? 403 : 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ elementId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { elementId } = await context.params;
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = versionIdOf(request);
    if (!versionId) return NextResponse.json({ error: "删除关系必须指定草稿 versionId。" }, { status: 400 });
    await ensureVersionSnapshot(versionId, target);
    const deleted = await deleteSnapshotRelationship(versionId, elementId);
    if (!deleted) return NextResponse.json({ error: "关系不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_RELATIONSHIP_DELETED", details: { versionId, relationshipId: elementId } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法删除关系。" }, { status: 400 });
  }
}
