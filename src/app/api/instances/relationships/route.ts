import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";
import { writeAuditEntry } from "@/lib/platform-db";
import { createSnapshotRelationship, ensureVersionSnapshot, listSnapshotRelationships } from "@/lib/version-snapshot";

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

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const type = request.nextUrl.searchParams.get("type");
    const search = request.nextUrl.searchParams.get("search");
    const versionId = request.nextUrl.searchParams.get("versionId");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      return NextResponse.json({ rows: listSnapshotRelationships(snapshot, { type, search, limit }) });
    }
    const rows = await getGraphStore(target).listRelationships({ type: type || null, search: search || null, limit });
    return NextResponse.json({ rows });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取关系。") }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = relationshipCreateInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const relationship = await createSnapshotRelationship(input.versionId, input.relationshipType, input.sourceId, input.targetIdValue, input.properties);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_RELATIONSHIP_CREATED", details: { versionId: input.versionId, relationshipId: relationship.id, relationshipType: relationship.type } });
    return NextResponse.json(relationship, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建关系。") }, { status: 400 });
  }
}
