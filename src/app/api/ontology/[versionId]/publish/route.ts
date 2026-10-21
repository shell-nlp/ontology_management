import { NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { publishVersionSnapshot } from "@/lib/instance/version-publication";
import { withPermission } from "@/lib/platform/route-guard";
import { OdsPublishBlockedError } from "@/lib/instance/ods/publish-readiness";

export const POST = withPermission("ontology.publish", async (_: Request, context: { params: Promise<{ versionId: string }> }, user) => {
  try {
    const { versionId } = await context.params;
    const result = await publishVersionSnapshot(versionId, user, ["DRAFT"]);
    if (!result.published) return NextResponse.json({ error: "版本快照未通过校验。", violations: result.violations }, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof OdsPublishBlockedError) {
      return NextResponse.json({
        error: error.message,
        blockers: error.blockers,
        hint: "先到「数据资源」完成对应表的 ODS 配置和全量同步，再重新发布。",
      }, { status: 409 });
    }
    return NextResponse.json({ error: apiErrorMessage(error, "本体发布失败。") }, { status: apiErrorStatus(error) });
  }
});
