import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withPermission } from "@/lib/platform/route-guard";
import { apiErrorMessage, apiErrorStatus } from "@/lib/platform/auth";
import { captureInstanceHistory, listInstanceHistory, readInstanceHistory, deleteOrCancelInstanceHistory } from "@/lib/instance/history";

const input = z.object({ targetId: z.string().uuid(), versionId: z.string().uuid().optional(), entityTypes: z.array(z.string().min(1)).min(1).max(200) });
export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const p = request.nextUrl.searchParams;
    const targetId = z.string().uuid().parse(p.get("targetId"));
    const id = p.get("snapshotId");
    return NextResponse.json(id ? await readInstanceHistory(id, targetId, { entityType: p.get("entityType") ?? undefined, offset: z.coerce.number().int().min(0).parse(p.get("offset") ?? 0), limit: z.coerce.number().int().min(1).max(200).parse(p.get("limit") ?? 20), warm: p.get("warm") === "1" }) : { snapshots: await listInstanceHistory(targetId) });
  } catch (error) { return NextResponse.json({ error: apiErrorMessage(error, "历史快照读取失败。") }, { status: apiErrorStatus(error) }); }
});
export const POST = withPermission("instance.write", async (request: NextRequest) => {
  try { const body = input.parse(await request.json()); return NextResponse.json({ snapshot: await captureInstanceHistory(body.targetId, body.versionId, body.entityTypes) }, { status: 202 }); }
  catch (error) { return NextResponse.json({ error: apiErrorMessage(error, "历史采集启动失败。") }, { status: apiErrorStatus(error) }); }
});
export const DELETE = withPermission("instance.write", async (request: NextRequest) => {
  try { const p = request.nextUrl.searchParams; return NextResponse.json(await deleteOrCancelInstanceHistory(z.string().uuid().parse(p.get("snapshotId")), z.string().uuid().parse(p.get("targetId")))); }
  catch (error) { return NextResponse.json({ error: apiErrorMessage(error, "历史删除失败。") }, { status: apiErrorStatus(error) }); }
});
