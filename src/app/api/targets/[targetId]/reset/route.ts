import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { deleteTargetVersions } from "@/lib/version-snapshot";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });

    const deletedVersions = await deleteTargetVersions(targetId);
    await writeAuditEntry({
      actorId: user.id,
      targetId,
      action: "VERSIONS_RESET",
      details: { deletedVersions, name: target.name },
    });
    return NextResponse.json({ reset: true, deletedVersions });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "初始化失败。" }, { status });
  }
}
