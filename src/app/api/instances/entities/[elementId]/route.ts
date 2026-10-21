import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage, isUnauthorized } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { getGraphStore } from "@/lib/platform/graph-store";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { deleteSnapshotEntity, updateSnapshotEntity } from "@/lib/instance/snapshot-editing";
import { ensureVersionSnapshot, entityFromSnapshot, getVersionRecord } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";
import { getObject, resolveObjectContext } from "@/lib/instance/object-service";
import { readEditSnapshot } from "@/lib/instance/object-service/edit-overlay";

const entityPatchInput = z.object({ properties: z.record(z.string(), z.unknown()).default({}), displayedBase: z.record(z.string(), z.unknown()).optional() });

function targetIdOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("targetId") ?? "";
}

function versionIdOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("versionId") ?? "";
}

export const GET = withPermission("instance.read", async (request: NextRequest, context: { params: Promise<{ elementId: string }> }) => {
  try {
    const { elementId } = await context.params;
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = versionIdOf(request);
    if (versionId) {
      const version = await getVersionRecord(versionId);
      if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
      if (version.status === "DRAFT") {
        const snapshot = await ensureVersionSnapshot(versionId, target);
        const entity = snapshot.nodes.find((node) => node.id === elementId);
        if (!entity) return NextResponse.json({ error: "对象不存在。" }, { status: 404 });
        return NextResponse.json(entityFromSnapshot(entity));
      }
    }
    const objectContext = await resolveObjectContext(target.id, versionId || undefined);
    const overlay = await readEditSnapshot(objectContext);
    const changed = overlay?.nodes.find((node) => node.id === elementId);
    const edit = overlay?.objectEdits?.[elementId];
    if (changed && edit) {
      const record = await getObject(objectContext, changed.labels[0] ?? "", edit.primaryKey);
      if (!record) return NextResponse.json({ error: "对象不存在。" }, { status: 404 });
      return NextResponse.json({ id: record.objectId, labels: [record.entityType], properties: record.properties });
    }
    const entity = await getGraphStore(target).readEntity(elementId);
    if (!entity) return NextResponse.json({ error: "对象不存在。" }, { status: 404 });
    return NextResponse.json(entity);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取对象。") }, { status: apiErrorStatus(error) });
  }
});

export const PATCH = withPermission("instance.write", async (request: NextRequest, context: { params: Promise<{ elementId: string }> }, user) => {
  try {
    const { elementId } = await context.params;
    const input = entityPatchInput.parse(await request.json());
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = versionIdOf(request);
    if (!versionId) return NextResponse.json({ error: "修改对象必须指定草稿 versionId。" }, { status: 400 });
    await ensureVersionSnapshot(versionId, target);
    const updated = await updateSnapshotEntity(versionId, elementId, input.properties, input.displayedBase);
    if (!updated) return NextResponse.json({ error: "对象不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_ENTITY_UPDATED", details: { versionId, entityId: elementId } });
    return NextResponse.json(updated);
  } catch (error) {
    const message = apiErrorMessage(error, "无法更新对象。");
    return NextResponse.json({ error: message }, { status: isUnauthorized(error) ? 401 : 400 });
  }
});

export const DELETE = withPermission("instance.write", async (request: NextRequest, context: { params: Promise<{ elementId: string }> }, user) => {
  try {
    const { elementId } = await context.params;
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = versionIdOf(request);
    if (!versionId) return NextResponse.json({ error: "删除对象必须指定草稿 versionId。" }, { status: 400 });
    await ensureVersionSnapshot(versionId, target);
    const deleted = await deleteSnapshotEntity(versionId, elementId);
    if (!deleted) return NextResponse.json({ error: "对象不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_ENTITY_DELETED", details: { versionId, entityId: elementId } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法删除对象。") }, { status: apiErrorStatus(error) });
  }
});
