import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { getGraphStore } from "@/lib/framework/graph";
import { ensureVersionSnapshot, graphFromSnapshot } from "@/lib/versioning/snapshot";
import { resolveObjectContext } from "@/lib/instance/object-service";
import { readInstanceGraph } from "@/lib/instance/object-service/instance-graph";
import { withPermission } from "@/lib/platform/route-guard";

/**
 * 实例图谱：**已发布视图走对象服务（对象索引 + 边索引），不再读图库**。
 *
 * 为什么：图库扛不住大实例量，平台把它定位成**只做类型层推理**；实例层的对象与关系一律走对象服务
 * （对象索引为主，物化过什么就画什么）。
 * 草稿视图（带 `versionId`）仍然读**这一版草稿快照** —— 草稿还没发布，索引里当然没有。
 * 索引里一条数据都没有时（老库 / 还没发布过 / 还没物化过）退回图库，并如实说明。
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
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      return NextResponse.json(graphFromSnapshot(snapshot, { labels, relationshipTypes, search, nodeLimit }));
    }
    const context = await resolveObjectContext(targetId, null);
    const graph = await readInstanceGraph(context, { labels, relationshipTypes, search, nodeLimit });
    if (graph.nodes.length || graph.relationships.length) return NextResponse.json(graph);
    /*
     * 索引里空空如也：退回图库，别让人看到一个莫名奇妙的空图。
     * 这里只兜底，不改变"图谱走对象服务"的方向 —— 发布一次快照 / 整份物化之后就走索引了。
     */
    const fallback = await getGraphStore(target).readGraph({ label, labels, relationshipTypes, search, nodeLimit });
    return NextResponse.json({
      ...fallback,
      warnings: [...graph.warnings, "对象索引里还没有数据，这一次图谱读的是图库；发布一次快照或整份物化之后就改走索引。"],
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取图谱。") }, { status: apiErrorStatus(error) });
  }
});
