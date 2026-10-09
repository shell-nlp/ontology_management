import { NextResponse } from "next/server";
import { apiErrorMessage, requirePermission } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";

export async function GET(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    await requirePermission("target.read");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const result = await getGraphStore(target).readSchemaGraph();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取运行时 Schema。") }, { status: 500 });
  }
}
