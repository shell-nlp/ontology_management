import { NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { publishVersionSnapshot } from "@/lib/instance/version-publication";
import { withPermission } from "@/lib/platform/route-guard";

export const POST = withPermission("ontology.publish", async (_: Request, context: { params: Promise<{ versionId: string }> }, user) => {
  try {
    const { versionId } = await context.params;
    const result = await publishVersionSnapshot(versionId, user, ["DRAFT"]);
    if (!result.published) return NextResponse.json({ error: "版本快照未通过校验。", violations: result.violations }, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "本体发布失败。") }, { status: apiErrorStatus(error) });
  }
});
