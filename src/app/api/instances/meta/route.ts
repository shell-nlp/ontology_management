import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const [labelsResult, relationshipsResult, keysResult] = await Promise.all([
      executeCypher(target, "CALL db.labels() YIELD label RETURN label ORDER BY label"),
      executeCypher(target, "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType"),
      executeCypher(target, "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey"),
    ]);
    return NextResponse.json({
      labels: labelsResult.records.map((row) => String(row.label)),
      relationshipTypes: relationshipsResult.records.map((row) => String(row.relationshipType)),
      propertyKeys: keysResult.records.map((row) => String(row.propertyKey)),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 Schema 元数据。" }, { status: 400 });
  }
}
