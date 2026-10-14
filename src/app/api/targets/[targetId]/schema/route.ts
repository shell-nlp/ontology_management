import { NextResponse } from "next/server";
import { apiErrorMessage } from "@/lib/platform/auth";
import { getGraphStore } from "@/lib/framework/graph";
import { getTarget } from "@/lib/platform/targets";
import { withPermission } from "@/lib/platform/route-guard";

export const GET = withPermission("target.read", async (_: Request, context: { params: Promise<{ targetId: string }> }) => {
  try {
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const result = await getGraphStore(target).readSchemaGraph();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取运行时 Schema。") }, { status: 500 });
  }
});
