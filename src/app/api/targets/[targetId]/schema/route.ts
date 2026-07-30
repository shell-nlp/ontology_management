import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";

export async function GET(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(target, "CALL db.schema.visualization()");
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "UNAUTHORIZED" ? "未授权。" : "无法读取运行时 Schema。" }, { status: 500 });
  }
}
