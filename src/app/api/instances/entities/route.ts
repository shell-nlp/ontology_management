import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";
import { getEntityDefinitions } from "@/lib/instances";
import { parsePropertyValues } from "@/lib/instance-property-editor";
import { writeAuditEntry } from "@/lib/platform-db";

const inputSchema = z.object({
  targetId: z.string().uuid(),
  entityType: z.string().min(1),
  labels: z.array(z.string().min(1)).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
});

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const label = request.nextUrl.searchParams.get("label");
    const search = request.nextUrl.searchParams.get("search");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(
      target,
      `MATCH (n)
       WHERE ($label IS NULL OR $label IN labels(n))
         AND ($search IS NULL OR any(k IN keys(n) WHERE toString(n[k]) CONTAINS $search))
       RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties
       ORDER BY id LIMIT 200`,
      { label: label || null, search: search || null },
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
    const labels = input.labels.length > 0 ? input.labels : [input.entityType];
    const definitions = await getEntityDefinitions(target, labels);
    const properties = definitions
      ? parsePropertyValues(definitions, input.properties)
      : parsePropertyValues([], input.properties, { allowArbitrary: true });
    const labelPart = labels.map((label) => `:\`${label.replaceAll("`", "``")}\``).join("");
    const result = await executeCypher(
      target,
      `CREATE (n${labelPart}) SET n += $properties RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties`,
      { properties },
    );
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "ENTITY_CREATED", details: { labels, properties } });
    return NextResponse.json(result.records[0], { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建实体。" }, { status: 400 });
  }
}
