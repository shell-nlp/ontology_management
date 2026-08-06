import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getTarget } from "@/lib/targets";
import { executeCypher } from "@/lib/neo4j";
import { updateEntityProperties, deleteEntity } from "@/lib/instances";
import { writeAuditEntry } from "@/lib/platform-db";

const patchSchema = z.object({ properties: z.record(z.string(), z.unknown()).default({}) });

function targetIdOf(request: NextRequest) {
  return request.nextUrl.searchParams.get("targetId") ?? "";
}

export async function GET(request: NextRequest, context: { params: Promise<{ elementId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { elementId } = await context.params;
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(
      target,
      `MATCH (n) WHERE elementId(n) = $elementId RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties`,
      { elementId },
    );
    if (!result.records[0]) return NextResponse.json({ error: "实体不存在。" }, { status: 404 });
    return NextResponse.json(result.records[0]);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取实体。" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ elementId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { elementId } = await context.params;
    const input = patchSchema.parse(await request.json());
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const updated = await updateEntityProperties(target, elementId, input.properties);
    if (!updated) return NextResponse.json({ error: "实体不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "ENTITY_UPDATED", details: { elementId, properties: input.properties } });
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法更新实体。";
    return NextResponse.json({ error: message }, { status: message === "UNAUTHORIZED" ? 403 : 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ elementId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { elementId } = await context.params;
    const target = await getTarget(targetIdOf(request));
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await deleteEntity(target, elementId);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "ENTITY_DELETED", details: { elementId } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法删除实体。" }, { status: 400 });
  }
}
