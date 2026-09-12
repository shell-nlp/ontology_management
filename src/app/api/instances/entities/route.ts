import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";
import { getPublishedOntology } from "@/lib/published-ontology";
import { writeAuditEntry } from "@/lib/platform-db";
import { createSnapshotEntity, ensureVersionSnapshot, listSnapshotEntities } from "@/lib/version-snapshot";

const inputSchema = z.object({
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

/** 读取已发布本体的展示属性，供搜索排序使用；未发布时按任意属性搜索。 */
async function displayPropertiesOf(targetId: string) {
  const displayProps: Record<string, string> = {};
  try {
    const ontology = await getPublishedOntology(targetId);
    for (const item of ontology.entityTypes) if (item.displayProperty) displayProps[item.name] = item.displayProperty;
  } catch {
    // 未发布本体时退回按任意属性搜索
  }
  return displayProps;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const label = request.nextUrl.searchParams.get("label");
    const search = request.nextUrl.searchParams.get("search");
    const versionId = request.nextUrl.searchParams.get("versionId");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      return NextResponse.json({ rows: listSnapshotEntities(snapshot, { label, search, limit }) });
    }
    const rows = await getGraphStore(target).listEntities({
      label,
      search,
      limit,
      displayProperties: await displayPropertiesOf(target.id),
    });
    return NextResponse.json({ rows });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取对象。" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const entity = await createSnapshotEntity(input.versionId, input.entityType, input.properties);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_ENTITY_CREATED", details: { versionId: input.versionId, entityId: entity.id, labels: entity.labels } });
    return NextResponse.json(entity, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建对象。" }, { status: 400 });
  }
}
