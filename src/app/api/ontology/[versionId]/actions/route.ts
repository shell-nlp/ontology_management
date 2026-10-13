import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getTarget } from "@/lib/platform/targets";
import { ensureVersionSnapshot, getVersionRecord, readVersionSnapshot, runSnapshotAction, visibleSnapshotActions } from "@/lib/versioning/snapshot";
import { parsePrimaryKeyInput } from "@/lib/instance/object-identity";
import { ensureObjectInDraft, resolveObjectContext } from "@/lib/instance/object-service";
import { applyWritebackPlan, type WritebackExecution } from "@/lib/instance/object-service/writeback";
import { getDataSource } from "@/lib/datasource/sources";
import { actionWritebackDiffs, describeWritebackPlan, planActionWriteback, type WritebackPlan } from "@/lib/ontology/action-writeback";

/**
 * 给界面看的写回计划：连接器要的字段（schema / view / sourceId）不出这一层，
 * 界面只关心"写哪张表、按什么键、改哪几列"，以及一句能直接念出来的说明。
 */
function writebackPlanView(plan: WritebackPlan) {
  return {
    entityType: plan.entityType,
    table: plan.table,
    dataSourceName: plan.dataSourceName,
    description: describeWritebackPlan(plan),
    keys: plan.keys,
    assignments: plan.assignments.map((item) => ({ column: item.column, property: item.property, value: item.value })),
  };
}
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
  /** 真执行时是否把改动写回业务库（表 / 视图式来源才写得回，口径来源会被拒绝）。干跑只出计划、不写库。 */
  writeback: z.boolean().default(false),
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
    await requirePermission("ontology.read");
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
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取动作可见性。") }, { status: apiErrorStatus(error) });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requirePermission("instance.write");
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
    /*
     * 写回（可选）：把"这次动作真正改到了哪些属性"翻译成"改哪张表的哪几列"。
     *
     * 计划是**纯函数**算出来的、不碰库，所以干跑也能拿它给用户看："点执行会写这张表的这一行"。
     * 真写的时候一定在动作落草稿**之前** —— 权威在业务库、草稿只是副本；库没改成功就不该落草稿。
     */
    const before = await readVersionSnapshot(versionId);
    const preview = await runSnapshotAction(versionId, input.actionId, inputs, { dryRun: true, subjectEntityId });
    const sourceNames = new Map<string, string>();
    const nameOfSource = async (id: string) => {
      if (!sourceNames.has(id)) sourceNames.set(id, (await getDataSource(id))?.name ?? "");
      return sourceNames.get(id) ?? "";
    };
    const writebackPlans: WritebackPlan[] = [];
    const writebackRefusals: { nodeId: string; entityType: string; reason: string; hint?: string }[] = [];
    const writebackSkipped: { nodeId: string; entityType: string; reason: string }[] = [];
    for (const diff of actionWritebackDiffs(before.definition, before, preview.outcome.graph)) {
      if (diff.created) {
        writebackSkipped.push({ nodeId: diff.nodeId, entityType: diff.entityType, reason: `动作新建的${diff.entityType}还没有源行，写回只支持改已有行。` });
        continue;
      }
      const node = before.nodes.find((item) => item.id === diff.nodeId);
      const planned = planActionWriteback(before.definition, diff.entityType, node?.properties ?? {}, diff.changes);
      if (!planned.ok) {
        writebackRefusals.push({ nodeId: diff.nodeId, entityType: diff.entityType, ...planned.refusal });
        continue;
      }
      planned.plan.dataSourceName = await nameOfSource(planned.plan.dataSourceId);
      writebackPlans.push(planned.plan);
    }
    /*
     * 有一处写不回去就**整批不执行**：只写一半业务库是最难收拾的状态（界面上看到的和库里的对不上，
     * 也没法自动回滚）。拒绝时把"哪一处、为什么、去哪儿改"一起返回，去掉那一处再执行。
     */
    if (input.writeback && !input.dryRun && writebackRefusals.length) {
      return NextResponse.json({
        error: `这次动作里有 ${writebackRefusals.length} 处写不回业务库，整批都没有执行（草稿与业务库都没动）。`,
        writeback: { requested: true, mode: "REFUSED", plans: [], refusals: writebackRefusals, skipped: writebackSkipped, executions: [] },
      }, { status: 409 });
    }
    const executions: WritebackExecution[] = [];
    if (input.writeback && !input.dryRun && preview.outcome.verdict === "PASSED") {
      // 一条一条串行写：同一动作改多个对象时一起压业务库没有好处，还会让"写到第几条失败"说不清。
      for (const plan of writebackPlans) executions.push(await applyWritebackPlan(plan));
    }
    let ran: Awaited<ReturnType<typeof runSnapshotAction>>;
    try {
      ran = await runSnapshotAction(versionId, input.actionId, inputs, { dryRun: input.dryRun, subjectEntityId });
    } catch (error) {
      // 业务库已经改了、草稿没落上：这是最需要说清楚的一种状态，别吞掉。
      if (executions.length) {
        return NextResponse.json({
          error: `${apiErrorMessage(error, "动作执行失败。")}（业务库已经写进去 ${executions.length} 处，草稿没有更新 —— 请重新运行一次让两边对齐）`,
          applied: false,
          writeback: { requested: true, mode: "APPLIED", plans: writebackPlans.map(writebackPlanView), refusals: [], skipped: writebackSkipped, executions },
        }, { status: 500 });
      }
      throw error;
    }
    const { outcome, applied } = ran;
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
        writeback: { requested: input.writeback, plans: writebackPlans.map((plan) => describeWritebackPlan(plan)), refusals: writebackRefusals, skipped: writebackSkipped, executions },
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
      writeback: {
        requested: input.writeback,
        mode: executions.length ? "APPLIED" : input.writeback ? "PREVIEW" : "OFF",
        plans: writebackPlans.map(writebackPlanView),
        refusals: writebackRefusals,
        skipped: writebackSkipped,
        executions,
      },
      applied,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "动作执行失败。") }, { status: apiErrorStatus(error) });
  }
}
