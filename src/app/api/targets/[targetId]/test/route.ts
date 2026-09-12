import { NextResponse } from "next/server";
import { isUnauthorized, requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import type { GraphTargetKind } from "@/lib/graph/types";
import { describeTargetError, getTarget } from "@/lib/targets";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  // 出错时也要按这个存储的引擎给提示，所以 kind 提到 try 外面。
  let kind: GraphTargetKind = "NEO4J";
  try {
    await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    kind = target.kind;
    const info = await getGraphStore(target).testConnection();
    return NextResponse.json(info);
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    return NextResponse.json({ error: unauthorized ? "未授权。" : describeTargetError(kind, error) }, { status: unauthorized ? 401 : 400 });
  }
}