import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";
import { getRelationshipDefinitions } from "@/lib/instances";
import { quoteCypherIdentifier } from "@/lib/published-ontology";
import { parsePropertyValues } from "@/lib/instance-property-editor";
import { writeAuditEntry } from "@/lib/platform-db";

const inputSchema = z.object({
  targetId: z.string().uuid(),
  relationshipType: z.string().min(1),
  sourceId: z.string().min(1),
  targetIdValue: z.string().min(1),
  properties: z.record(z.string(), z.unknown()).default({}),
});

function safeText(expr: string) {
  return `CASE WHEN ${expr} IS NULL THEN '' ELSE reduce(s = '', item IN ${expr} | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') END`;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const type = request.nextUrl.searchParams.get("type");
    const search = request.nextUrl.searchParams.get("search");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const relMatch = `any(k IN keys(r) WHERE toLower(${safeText("r[k]")}) CONTAINS toLower($search))`;
    const nodeMatch = `any(k IN keys(source) WHERE toLower(${safeText("source[k]")}) CONTAINS toLower($search)) OR any(k IN keys(target) WHERE toLower(${safeText("target[k]")}) CONTAINS toLower($search))`;
    const result = await executeCypher(
      target,
      `MATCH (source)-[r]->(target)
       WHERE ($type IS NULL OR type(r) = $type)
         AND ($search IS NULL OR ${relMatch} OR ${nodeMatch})
       RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, labels(source) AS sourceLabels, properties(source) AS sourceProperties, labels(target) AS targetLabels, properties(target) AS targetProperties, properties(r) AS properties
       ORDER BY id LIMIT 200`,
      { type: type || null, search: search || null },
    );
    return NextResponse.json({ rows: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取关系。" }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const definitions = await getRelationshipDefinitions(target, input.relationshipType);
    const properties = definitions
      ? parsePropertyValues(definitions, input.properties)
      : parsePropertyValues([], input.properties, { allowArbitrary: true });
    const result = await executeCypher(
      target,
      `MATCH (source), (target) WHERE elementId(source) = $sourceId AND elementId(target) = $targetId
       CREATE (source)-[r:${quoteCypherIdentifier(input.relationshipType)}]->(target) SET r += $properties
       RETURN elementId(r) AS id, type(r) AS type, elementId(source) AS sourceId, elementId(target) AS targetId, labels(source) AS sourceLabels, properties(source) AS sourceProperties, labels(target) AS targetLabels, properties(target) AS targetProperties, properties(r) AS properties`,
      { sourceId: input.sourceId, targetId: input.targetIdValue, properties },
    );
    if (!result.records[0]) return NextResponse.json({ error: "关系端点不存在。" }, { status: 422 });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "RELATIONSHIP_CREATED", details: { relationshipType: input.relationshipType, sourceId: input.sourceId, targetId: input.targetIdValue, properties } });
    return NextResponse.json(result.records[0], { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建关系。" }, { status: 400 });
  }
}
