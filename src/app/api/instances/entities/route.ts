import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { createSnapshotEntity } from "@/lib/instance/snapshot-editing";
import { ensureVersionSnapshot, getVersionRecord, listSnapshotEntities } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";
import { queryAllObjects, resolveObjectContext } from "@/lib/instance/object-service";

const entityCreateInput = z.object({
  targetId: z.string().uuid(),
  versionId: z.string().uuid(),
  entityType: z.string().min(1),
  labels: z.array(z.string().min(1)).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
});

function parseLimit(value: string | null, fallback = 200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(10000, Math.floor(parsed));
}

export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const targetId = request.nextUrl.searchParams.get("targetId");
    const label = request.nextUrl.searchParams.get("label");
    const search = request.nextUrl.searchParams.get("search");
    const versionId = request.nextUrl.searchParams.get("versionId");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    if (versionId) {
      const version = await getVersionRecord(versionId);
      if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
      if (version.status === "DRAFT") {
        const snapshot = await ensureVersionSnapshot(versionId, target);
        return NextResponse.json({ rows: listSnapshotEntities(snapshot, { label, search, limit }) });
      }
    }
    const context = await resolveObjectContext(target.id, versionId ?? undefined);
    const page = await queryAllObjects(context, {
      labels: label ? [label] : [],
      text: search?.trim() || undefined,
      limit,
      count: false,
      signal: request.signal,
    });
    return NextResponse.json({
      rows: page.rows.map((row) => ({ id: row.objectId, labels: [row.entityType], properties: row.properties })),
      warnings: page.warnings,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取对象。") }, { status: apiErrorStatus(error) });
  }
});

export const POST = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const input = entityCreateInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const entity = await createSnapshotEntity(input.versionId, input.entityType, input.properties);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_ENTITY_CREATED", details: { versionId: input.versionId, entityId: entity.id, labels: entity.labels } });
    return NextResponse.json(entity, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建对象。") }, { status: apiErrorStatus(error) });
  }
});
