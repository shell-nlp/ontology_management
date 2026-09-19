import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, getVersionRecord, readVersionSnapshot, runSnapshotAction, visibleSnapshotActions } from "@/lib/version-snapshot";
import { parsePrimaryKeyInput } from "@/lib/object-identity";
import { ensureObjectInDraft, resolveObjectContext } from "@/lib/object-service";

const actionRunInput = z.object({
  actionId: z.string().uuid(),
  /** 动作作用在哪个对象上；动作配了作用的类时必填。 */
  subjectEntityId: z.string().uuid().optional(),
  /**
   * 对象引用（`对象类型/主键串`），数据源里的对象走这个。
   * 给了它而对象又不在草稿快照里时，先按主键把它取进草稿再执行 —— 否则动作引擎会找不到主对象。
   */
  subjectRef: z.string().trim().max(500).optional(),
  dryRun: z.boolean().default(true),
  inputs: z.array(z.object({
    code: z.string().min(1),
    entityId: z.string().optional(),
    /** 入参对象的引用（`对象类型/主键串`）：数据源里的对象靠它先取进草稿。 */
    entityRef: z.string().trim().max(500).optional(),
    value: z.string().optional(),
  })).default([]),
});

/** 这个草稿快照里有没有这个对象（判断"要不要先把数据源对象取进来"）。 */
async function snapshotHasEntity(versionId: string, entityId: string) {
  const snapshot = await readVersionSnapshot(versionId).catch(() => null);
  return Boolean(snapshot?.nodes.some((node) => node.id === entityId));
}

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
    // 主对象可能来自数据源（本体里没有副本）：先取进草稿，动作才有作用对象。
    let subjectEntityId = input.subjectEntityId;
    let materialized = false;
    const objectContext = await resolveObjectContext(version.target_id, versionId);
    if (input.subjectRef && (!subjectEntityId || !(await snapshotHasEntity(versionId, subjectEntityId)))) {
      const slash = input.subjectRef.indexOf("/");
      if (slash <= 0) return NextResponse.json({ error: "对象引用应该形如「对象类型/主键串」。" }, { status: 400 });
      const entityType = input.subjectRef.slice(0, slash);
      const ensured = await ensureObjectInDraft(objectContext, versionId, entityType, parsePrimaryKeyInput(input.subjectRef.slice(slash + 1)));
      subjectEntityId = ensured.record.objectId;
      materialized = ensured.created;
    }
    // 入参里的对象同理：只存在于数据源时先取进草稿。
    const inputs = [];
    for (const item of input.inputs) {
      if (!item.entityRef || (item.entityId && await snapshotHasEntity(versionId, item.entityId))) { inputs.push({ code: item.code, entityId: item.entityId, value: item.value }); continue; }
      const slash = item.entityRef.indexOf("/");
      if (slash <= 0) { inputs.push({ code: item.code, entityId: item.entityId, value: item.value }); continue; }
      const ensured = await ensureObjectInDraft(objectContext, versionId, item.entityRef.slice(0, slash), parsePrimaryKeyInput(item.entityRef.slice(slash + 1)));
      inputs.push({ code: item.code, entityId: ensured.record.objectId, value: item.value });
      materialized = materialized || ensured.created;
    }
    const { outcome, applied } = await runSnapshotAction(versionId, input.actionId, inputs, { dryRun: input.dryRun, subjectEntityId });
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: outcome.verdict === "BLOCKED" ? "ACTION_BLOCKED" : input.dryRun ? "ACTION_DRY_RUN" : "ACTION_EXECUTED",
      details: {
        versionId,
        actionId: outcome.actionId,
        actionCode: outcome.actionCode,
        actionName: outcome.actionName,
        materializedSubject: materialized,
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
