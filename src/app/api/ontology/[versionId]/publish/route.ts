import { NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { publishVersionSnapshot } from "@/lib/version-publication";

export async function POST(_: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const result = await publishVersionSnapshot(versionId, user, ["DRAFT"]);
    if (!result.published) return NextResponse.json({ error: "版本快照未通过校验。", violations: result.violations }, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "本体发布失败。") }, { status: 400 });
  }
}
