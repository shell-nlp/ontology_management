import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const info = await getGraphStore(target).testConnection();
    return NextResponse.json(info);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法连接图数据库目标。" }, { status: 400 });
  }
}
