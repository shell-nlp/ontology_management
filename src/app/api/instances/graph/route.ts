import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { resolveObjectContext } from "@/lib/instance/object-service";
import { readInstanceGraph } from "@/lib/instance/object-service/instance-graph";
import { withPermission } from "@/lib/platform/route-guard";

/**
 * 实例图谱统一按当前或指定版本读取有界虚拟对象与关系，不读对象索引或图库副本。
 */
export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const params = request.nextUrl.searchParams;
    const versionId = params.get("versionId");
    const labels = [...params.getAll("graphLabel")];
    const label = params.get("label");
    if (label) labels.push(label);
    const relationshipTypes = params.getAll("relationshipType");
    const search = params.get("search");
    const nodeLimit = Number(params.get("nodeLimit") ?? 300);
    const context = await resolveObjectContext(targetId, versionId);
    const graph = await readInstanceGraph(context, { labels, relationshipTypes, search, nodeLimit, signal: request.signal });
    return NextResponse.json(graph);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取图谱。") }, { status: apiErrorStatus(error) });
  }
});
