import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { getGraphStore } from "@/lib/framework/graph";
import { ensureVersionSnapshot, graphFromSnapshot } from "@/lib/versioning/snapshot";

export async function GET(request: NextRequest) {
  try {
    await requirePermission("instance.read");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
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
    const graph = await getGraphStore(target).readGraph({
      label: request.nextUrl.searchParams.get("label"),
      labels: request.nextUrl.searchParams.getAll("graphLabel"),
      relationshipTypes: request.nextUrl.searchParams.getAll("relationshipType"),
      search: request.nextUrl.searchParams.get("search"),
      nodeLimit: Number(request.nextUrl.searchParams.get("nodeLimit") ?? 300),
    });
    return NextResponse.json(graph);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取图谱。") }, { status: apiErrorStatus(error) });
  }
}
