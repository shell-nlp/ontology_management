import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";

/** 一度邻居扩展，对不同图后端使用各自的查询实现。 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const nodeId = request.nextUrl.searchParams.get("nodeId");
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "200");
    if (!targetId || !nodeId) return NextResponse.json({ error: "targetId 与 nodeId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const limit = Number.isFinite(limitRaw) ? limitRaw : 200;
    return NextResponse.json(await getGraphStore(target).readNeighborhood(nodeId, limit));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法扩展邻居。" }, { status: 400 });
  }
}
