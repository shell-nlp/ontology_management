import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { removeTargetSnapshotDirectory } from "@/lib/version-snapshot";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });

    const deleted = await platformQuery(
      "DELETE FROM ontology_platform.ontology_versions WHERE target_id = $1 RETURNING id",
      [targetId],
    );
    await removeTargetSnapshotDirectory(targetId);
    await writeAuditEntry({
      actorId: user.id,
      targetId,
      action: "VERSIONS_RESET",
      details: { deletedVersions: deleted.rows.length, name: target.name },
    });
    return NextResponse.json({ reset: true, deletedVersions: deleted.rows.length });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "初始化失败。" }, { status });
  }
}
