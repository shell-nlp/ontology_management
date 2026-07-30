import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getPublishedOntology, quoteCypherIdentifier, validatePropertyValues } from "@/lib/published-ontology";
import { getTarget } from "@/lib/targets";

const inputSchema = z.object({ targetId: z.string().uuid(), relationshipType: z.string().min(1), sourceId: z.string().min(1), targetIdValue: z.string().min(1), properties: z.record(z.string(), z.unknown()).default({}) });

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(target, "MATCH (source)-[r]->(target) RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, properties(r) AS properties LIMIT 100");
    return NextResponse.json({ rows: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取关系。" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const ontology = await getPublishedOntology(input.targetId);
    const relation = ontology.relationshipTypes.find((item) => item.name === input.relationshipType);
    if (!relation) return NextResponse.json({ error: "关系类型未发布。" }, { status: 422 });
    const sourceType = ontology.entityTypes.find((item) => item.id === relation.sourceEntityTypeId);
    const targetType = ontology.entityTypes.find((item) => item.id === relation.targetEntityTypeId);
    if (!sourceType || !targetType) return NextResponse.json({ error: "关系类型契约无效。" }, { status: 422 });
    validatePropertyValues(relation.properties, input.properties);
    const result = await executeCypher(target, `MATCH (source), (target) WHERE elementId(source) = $sourceId AND elementId(target) = $targetId WITH source, target WHERE source:${quoteCypherIdentifier(sourceType.name)} AND target:${quoteCypherIdentifier(targetType.name)} CREATE (source)-[r:${quoteCypherIdentifier(relation.name)}]->(target) SET r += $properties RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, properties(r) AS properties`, { sourceId: input.sourceId, targetId: input.targetIdValue, properties: input.properties });
    if (!result.records[0]) return NextResponse.json({ error: "关系端点不存在或不符合已发布契约。" }, { status: 422 });
    return NextResponse.json(result.records[0], { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建关系。" }, { status: 400 });
  }
}
