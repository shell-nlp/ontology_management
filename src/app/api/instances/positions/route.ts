import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getTarget } from "@/lib/targets";
import { writeAuditEntry } from "@/lib/platform-db";
import { ensureVersionSnapshot, updateSnapshotPositions } from "@/lib/version-snapshot";

const inputSchema = z.object({
  targetId: z.string().uuid(),
  versionId: z.string().uuid(),
  items: z.array(z.object({ elementId: z.string().min(1), x: z.number(), y: z.number() })).max(500),
});

export async function PUT(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await ensureVersionSnapshot(input.versionId, target);
    const updated = await updateSnapshotPositions(input.versionId, input.items);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "DRAFT_POSITIONS_UPDATED", details: { versionId: input.versionId, count: updated } });
    return NextResponse.json({ updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法保存节点位置。" }, { status: 400 });
  }
}
