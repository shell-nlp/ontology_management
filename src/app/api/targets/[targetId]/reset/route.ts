import { NextResponse } from "next/server";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { BUILTIN_EMBEDDED_TARGET_ID } from "@/lib/graph/types";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { deleteTargetVersions } from "@/lib/version-snapshot";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
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
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "初始化失败。") }, { status });
  }
}
