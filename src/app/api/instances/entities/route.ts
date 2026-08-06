import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
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

function safeText(expr: string) {
  return `CASE WHEN ${expr} IS NULL THEN '' ELSE reduce(s = '', item IN ${expr} | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') END`;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const label = request.nextUrl.searchParams.get("label");
    const search = request.nextUrl.searchParams.get("search");
    const versionId = request.nextUrl.searchParams.get("versionId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      return NextResponse.json({ rows: listSnapshotEntities(snapshot, { label, search }) });
    }
    let displayProps: Record<string, string> = {};
    try {
      const ontology = await getPublishedOntology(target.id);
      for (const item of ontology.entityTypes) if (item.displayProperty) displayProps[item.name] = item.displayProperty;
    } catch {
      // 未发布本体时退回按任意属性搜索
    }
    const hasDisplayProperty = "any(label IN labels(n) WHERE label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL)";
    const displayMatch = `any(label IN labels(n) WHERE label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL AND toLower(${safeText("n[$displayProps[label]]")}) CONTAINS toLower($search))`;
    const genericMatch = `any(k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($search))`;
    const result = await executeCypher(
      target,
      `MATCH (n)
       WHERE ($label IS NULL OR $label IN labels(n))
         AND ($search IS NULL OR ${displayMatch} OR (NOT ${hasDisplayProperty} AND ${genericMatch}))
       RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties
       ORDER BY id LIMIT 200`,
      { label: label || null, search: search || null, displayProps },
    );
    return NextResponse.json({ rows: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取实体。" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const entity = await createSnapshotEntity(input.versionId, input.entityType, input.properties);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_ENTITY_CREATED", details: { versionId: input.versionId, entityId: entity.id, labels: entity.labels } });
    return NextResponse.json(entity, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建实体。" }, { status: 400 });
  }
}
