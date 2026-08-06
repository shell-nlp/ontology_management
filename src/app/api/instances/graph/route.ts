import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getTarget } from "@/lib/targets";
import { readGraph } from "@/lib/instances";
import { ensureVersionSnapshot, graphFromSnapshot } from "@/lib/version-snapshot";

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
      const labels = [...request.nextUrl.searchParams.getAll("graphLabel")];
      const label = request.nextUrl.searchParams.get("label");
      if (label) labels.push(label);
      return NextResponse.json(graphFromSnapshot(snapshot, {
        labels,
        relationshipTypes: request.nextUrl.searchParams.getAll("relationshipType"),
        search: request.nextUrl.searchParams.get("search"),
        nodeLimit: Number(request.nextUrl.searchParams.get("nodeLimit") ?? 300),
      }));
    }
    const graph = await readGraph(target, {
      label: request.nextUrl.searchParams.get("label"),
      labels: request.nextUrl.searchParams.getAll("graphLabel"),
      relationshipTypes: request.nextUrl.searchParams.getAll("relationshipType"),
      search: request.nextUrl.searchParams.get("search"),
      nodeLimit: Number(request.nextUrl.searchParams.get("nodeLimit") ?? 300),
    });
    return NextResponse.json(graph);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取图谱。" }, { status: 400 });
  }
}
