import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { getGraphStore } from "@/lib/platform/graph-store";
import { ensureVersionSnapshot, runtimeTypesFromSnapshot } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";

export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const versionId = request.nextUrl.searchParams.get("versionId");
    if (versionId) return NextResponse.json(runtimeTypesFromSnapshot(await ensureVersionSnapshot(versionId, target)));
    const types = await getGraphStore(target).readRuntimeTypes();
    return NextResponse.json(types);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取运行时类型。") }, { status: apiErrorStatus(error) });
  }
});
