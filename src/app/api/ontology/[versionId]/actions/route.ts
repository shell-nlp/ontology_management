import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, getVersionRecord, runSnapshotAction } from "@/lib/version-snapshot";

const inputSchema = z.object({
  actionId: z.string().uuid(),
  dryRun: z.boolean().default(true),
  inputs: z.array(z.object({
    code: z.string().min(1),
    entityId: z.string().optional(),
    value: z.string().optional(),
  })).default([]),
});

export async function POST(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const input = inputSchema.parse(await request.json());
    const version = await getVersionRecord(versionId);
    if (!version) return NextResponse.json({ error: "本体草稿不存在。" }, { status: 404 });
    const target = await getTarget(version.target_id);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await ensureVersionSnapshot(versionId, target);
    const { outcome, applied } = await runSnapshotAction(versionId, input.actionId, input.inputs, { dryRun: input.dryRun });
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: outcome.verdict === "BLOCKED" ? "ACTION_BLOCKED" : input.dryRun ? "ACTION_DRY_RUN" : "ACTION_EXECUTED",
      details: {
        versionId,
        actionId: outcome.actionId,
        actionCode: outcome.actionCode,
        actionName: outcome.actionName,
        dryRun: input.dryRun,
        verdict: outcome.verdict,
        blockers: outcome.blockers,
        warnings: outcome.warnings,
        steps: outcome.steps,
        createdEntities: outcome.createdEntities,
      },
    });
    return NextResponse.json({
      actionId: outcome.actionId,
      actionName: outcome.actionName,
      actionCode: outcome.actionCode,
      verdict: outcome.verdict,
      blockers: outcome.blockers,
      warnings: outcome.warnings,
      steps: outcome.steps,
      createdEntities: outcome.createdEntities,
      dryRun: input.dryRun,
      applied,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "动作执行失败。" }, { status: 400 });
  }
}
