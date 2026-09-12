import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { listAuditEntries } from "@/lib/platform-db";
import { getVersionRecord } from "@/lib/version-snapshot";

const DECISION_ACTIONS = ["ACTION_DRY_RUN", "ACTION_EXECUTED", "ACTION_BLOCKED"];

/** 当前草稿的决策记录：每次干跑 / 执行 / 被拦截都会留一条。 */
export async function GET(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { versionId } = await context.params;
    const requested = Number(request.nextUrl.searchParams.get("limit") ?? "30");
    const version = await getVersionRecord(versionId);
    if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
    const entries = await listAuditEntries({
      targetId: version.target_id,
      actions: DECISION_ACTIONS,
      versionId,
      limit: Number.isFinite(requested) ? requested : 30,
    });
    return NextResponse.json({ entries });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取决策记录。") }, { status: 400 });
  }
}
