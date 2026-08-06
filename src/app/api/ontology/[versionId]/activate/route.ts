import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { publishVersionSnapshot } from "@/lib/version-publication";

export async function POST(_: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const result = await publishVersionSnapshot(versionId, user, ["ARCHIVED", "PUBLISHED"]);
    if (!result.published) return NextResponse.json({ error: "版本快照未通过校验。", violations: result.violations }, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "激活历史版本失败。";
    const status = message.includes("不存在") ? 404 : message.includes("不允许") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
