import { NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/platform/auth";
import { BUILTIN_EMBEDDED_TARGET_ID } from "@/lib/framework/graph/types";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getTarget } from "@/lib/platform/targets";
import { deleteTargetVersions } from "@/lib/versioning/snapshot";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requirePermission("ontology.publish");
    const { targetId } = await context.params;
    if (targetId === BUILTIN_EMBEDDED_TARGET_ID) return NextResponse.json({ error: "内置类型图是存储入口，不能重置版本；请先选择具体本体。" }, { status: 409 });
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
    return NextResponse.json({ error: apiErrorMessage(error, "初始化失败。") }, { status: apiErrorStatus(error) });
  }
}
