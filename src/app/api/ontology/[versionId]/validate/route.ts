import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { validateVersionSnapshot, ensureVersionSnapshot, getVersionRecord } from "@/lib/version-snapshot";
import { getTarget } from "@/lib/targets";

export async function POST(_: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRole("ADMIN");
    const { versionId } = await context.params;
    const row = await getVersionRecord(versionId);
    if (!row) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
    const target = await getTarget(row.target_id);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const snapshot = await ensureVersionSnapshot(row.id, target);
    const violations = validateVersionSnapshot(snapshot);
    const blockers = violations.filter((violation) => violation.severity !== "WARN");
    const warnings = violations.filter((violation) => violation.severity === "WARN");
    return NextResponse.json({ valid: blockers.length === 0, violations: blockers, warnings });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "本体校验失败。" }, { status: 400 });
  }
}
