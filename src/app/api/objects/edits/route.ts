import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withPermission } from "@/lib/platform/route-guard";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { resetSnapshotObjectEdit } from "@/lib/instance/snapshot-editing";
import { writeAuditEntry } from "@/lib/platform/platform-db";
export const DELETE = withPermission("instance.write", async (request: NextRequest, _context, user) => {
  try {
    const body = z.object({ versionId: z.string().uuid(), objectId: z.string().uuid() }).parse(await request.json());
    await resetSnapshotObjectEdit(body.versionId, body.objectId);
    await writeAuditEntry({ actorId: user.id, action: "OBJECT_EDIT_RESET", details: body });
    return NextResponse.json({ reset: true });
  } catch (error) { return NextResponse.json({ error: apiErrorMessage(error, "恢复源对象失败。") }, { status: apiErrorStatus(error) }); }
});
