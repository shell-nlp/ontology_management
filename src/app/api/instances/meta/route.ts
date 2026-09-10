import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot } from "@/lib/version-snapshot";

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const versionId = request.nextUrl.searchParams.get("versionId");
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      return NextResponse.json({
        labels: [...new Set(snapshot.nodes.flatMap((node) => node.labels))].sort(),
        relationshipTypes: [...new Set(snapshot.relationships.map((relationship) => relationship.type))].sort(),
        propertyKeys: [...new Set([...snapshot.nodes.flatMap((node) => Object.keys(node.properties)), ...snapshot.relationships.flatMap((relationship) => Object.keys(relationship.properties))])].sort(),
      });
    }
    return NextResponse.json(await getGraphStore(target).readMeta());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 Schema 元数据。" }, { status: 400 });
  }
}
