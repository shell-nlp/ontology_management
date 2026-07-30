import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getPublishedOntology, quoteCypherIdentifier, validatePropertyValues } from "@/lib/published-ontology";
import { getTarget } from "@/lib/targets";

const inputSchema = z.object({ targetId: z.string().uuid(), entityType: z.string().min(1), properties: z.record(z.string(), z.unknown()).default({}) });

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(target, "MATCH (n) RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties LIMIT 100");
    return NextResponse.json({ rows: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取实体。" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const ontology = await getPublishedOntology(input.targetId);
    const entityType = ontology.entityTypes.find((item) => item.name === input.entityType);
    if (!entityType) return NextResponse.json({ error: "实体类型未发布。" }, { status: 422 });
    validatePropertyValues(entityType.properties, input.properties);
    const result = await executeCypher(target, `CREATE (n:${quoteCypherIdentifier(entityType.name)}) SET n += $properties RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties`, { properties: input.properties });
    return NextResponse.json(result.records[0], { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建实体。" }, { status: 400 });
  }
}
