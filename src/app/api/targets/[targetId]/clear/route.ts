import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import type { GraphTargetKind } from "@/lib/graph/types";
import { getObjectIndex } from "@/lib/object-index";
import { writeAuditEntry } from "@/lib/platform-db";
import { describeTargetError, getTarget } from "@/lib/targets";

const clearInput = z.object({ confirm: z.string().min(1) });

/** 清空前的预览：这个图库里现在有多少对象和关系。统计失败不影响清空本身。 */
export async function GET(_: NextRequest, context: { params: Promise<{ targetId: string }> }) {
  let kind: GraphTargetKind = "NEO4J";
  try {
    await requireRole("VIEWER");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    kind = target.kind;
    const types = await getGraphStore(target).readRuntimeTypes();
    return NextResponse.json({ nodes: types.entityCount, relationships: types.relationshipCount });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json({ error: unauthorized ? "未授权。" : describeTargetError(kind, error) }, { status: unauthorized ? 401 : 400 });
  }
}

/**
 * 清空图数据：删掉这个本体存储里全部节点与关系。
 * 要键入本体存储名称才执行；只动图库，平台的版本记录与快照保留，重新发布一次即可写回。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ targetId: string }> }) {
  let kind: GraphTargetKind = "NEO4J";
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    kind = target.kind;
    const input = clearInput.parse(await request.json());
    if (input.confirm.trim() !== target.name) {
      return NextResponse.json({ error: "确认文字与本体存储名称不一致，已取消清空。" }, { status: 400 });
    }
    await getGraphStore(target).clearGraph();
    try {
      await getObjectIndex().deleteTargetObjects(targetId);
    } catch (error) {
      const message = apiErrorMessage(error, "未知错误");
      await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_INDEX_CLEAR_FAILED", details: { name: target.name, error: message } });
      return NextResponse.json(
        { error: `图数据已清空，但检索索引清理失败：${message}。请重新执行清空以恢复一致。` },
        { status: 400 },
      );
    }
    await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_GRAPH_CLEARED", details: { name: target.name, kind: target.kind } });
    return NextResponse.json({ cleared: true });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json({ error: unauthorized ? "未授权。" : describeTargetError(kind, error) }, { status: unauthorized ? 401 : 400 });
  }
}
