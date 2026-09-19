import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, getVersionRecord, runSnapshotAction, visibleSnapshotActions } from "@/lib/version-snapshot";

const actionRunInput = z.object({
  actionId: z.string().uuid(),
  /** 动作作用在哪个对象上；动作配了作用的类时必填。 */
  subjectEntityId: z.string().uuid().optional(),
  dryRun: z.boolean().default(true),
  inputs: z.array(z.object({
    code: z.string().min(1),
    entityId: z.string().optional(),
    value: z.string().optional(),
  })).default([]),
});

/**
 * 某个对象上应该出现哪些动作。
 * 对象详情页据此过滤掉被「隐藏」规则挡掉的入口，读的是快照，不改任何东西。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { versionId } = await context.params;
    const subjectEntityId = request.nextUrl.searchParams.get("subjectEntityId");
    if (!subjectEntityId) return NextResponse.json({ error: "subjectEntityId 不能为空。" }, { status: 400 });
    const version = await getVersionRecord(versionId);
    if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
    const target = await getTarget(version.target_id);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(versionId, target);
    return NextResponse.json({ actions: await visibleSnapshotActions(versionId, subjectEntityId) });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取动作可见性。") }, { status: 400 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const input = actionRunInput.parse(await request.json());
    const version = await getVersionRecord(versionId);
    if (!version) return NextResponse.json({ error: "本体草稿不存在。" }, { status: 404 });
    const target = await getTarget(version.target_id);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await ensureVersionSnapshot(versionId, target);
    const { outcome, applied } = await runSnapshotAction(versionId, input.actionId, input.inputs, { dryRun: input.dryRun, subjectEntityId: input.subjectEntityId });
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: outcome.verdict === "BLOCKED" ? "ACTION_BLOCKED" : input.dryRun ? "ACTION_DRY_RUN" : "ACTION_EXECUTED",
      details: {
        versionId,
        actionId: outcome.actionId,
        actionCode: outcome.actionCode,
        actionName: outcome.actionName,
        subject: outcome.subject,
        dryRun: input.dryRun,
        verdict: outcome.verdict,
        blockers: outcome.blockers,
        warnings: outcome.warnings,
        hidden: outcome.hidden,
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
      hidden: outcome.hidden,
      steps: outcome.steps,
      createdEntities: outcome.createdEntities,
      subject: outcome.subject,
      dryRun: input.dryRun,
      applied,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "动作执行失败。") }, { status: 400 });
  }
}
