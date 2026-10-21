import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { createSnapshotRelationship } from "@/lib/instance/snapshot-editing";
import { ensureVersionSnapshot, getVersionRecord, listSnapshotRelationships } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";
import { resolveObjectContext } from "@/lib/instance/object-service";
import { queryLinks } from "@/lib/instance/object-service/links";

const relationshipCreateInput = z.object({
  targetId: z.string().uuid(),
  versionId: z.string().uuid(),
  relationshipType: z.string().min(1),
  sourceId: z.string().min(1),
  targetIdValue: z.string().min(1),
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
    const type = request.nextUrl.searchParams.get("type");
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
        return NextResponse.json({ rows: listSnapshotRelationships(snapshot, { type, search, limit }) });
      }
    }
    const context = await resolveObjectContext(target.id, versionId ?? undefined);
    const result = await queryLinks(context, { relationshipType: type || undefined, limit });
    const needle = search?.trim().toLowerCase() ?? "";
    const rows = result.links
      .filter((link) => !needle || [link.relationshipType, link.source.objectRef, link.target.objectRef, ...Object.values(link.properties).map(String)].some((value) => value.toLowerCase().includes(needle)))
      .map((link) => ({
        id: link.linkRef,
        type: link.relationshipType,
        sourceId: link.source.objectId,
        targetId: link.target.objectId,
        properties: link.properties,
        sourceLabels: [link.source.entityType],
        targetLabels: [link.target.entityType],
      }));
    return NextResponse.json({ rows, warnings: result.warnings, truncated: result.truncated });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取关系。") }, { status: apiErrorStatus(error) });
  }
});

export const POST = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const input = relationshipCreateInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const relationship = await createSnapshotRelationship(input.versionId, input.relationshipType, input.sourceId, input.targetIdValue, input.properties);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_RELATIONSHIP_CREATED", details: { versionId: input.versionId, relationshipId: relationship.id, relationshipType: relationship.type } });
    return NextResponse.json(relationship, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建关系。") }, { status: apiErrorStatus(error) });
  }
});
