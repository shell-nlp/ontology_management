import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/auth";
import { fromBknKnowledgeNetwork, isBknKnowledgeNetwork } from "@/lib/bkn-import";
import { listDataSources } from "@/lib/data-sources";
import { createOntology, deleteOntology } from "@/lib/ontologies";
import { planBundleImport, readOntologyBundle } from "@/lib/ontology-bundle";
import { writeAuditEntry } from "@/lib/platform-db";
import { applySourceBindings, planSourceBindings } from "@/lib/source-binding";
import { collectSourceHints, toPendingSources } from "@/lib/source-hints";
import { getTarget } from "@/lib/targets";
import { createVersionRecord, initializeVersionSnapshot } from "@/lib/version-snapshot";

/**
 * 导入本体包：把单文件里的结构还原成这个平台上的一个新本体。
 *
 * 刻意停在**草稿**：导入不直接发布，也不碰图库。用户先看一眼校验结果，
 * 再决定要不要发布 —— 和平台既有流程一致，别人的文件不该绕过版本边界。
 *
 * 三件事按顺序做：解析校验 → 换 id 并接回本机数据资源 → 建本体 + 写草稿。
 *
 * 接受两种输入：平台自己的 `ontology.bundle`，以及 bkn-foundry 导出的知识网络
 * （`module_type: knowledge_network`）。后者先转成标准本体包，转换时丢掉的东西会逐条进 warnings。
 */
const importInput = z.object({
  /** 允许直接传解析好的对象，也允许传文件原文，前端两种都能用。 */
  bundle: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  storageTargetId: z.string().uuid(),
  /** 改名用；不传就用包里的名字。 */
  name: z.string().trim().min(1).max(100).optional(),
  /** 手动绑定：`对象类型id/sourceId` -> 数据资源 id（导入弹窗里选了之后回传）。 */
  bindings: z.record(z.string(), z.string().uuid()).optional(),
  /**
   * 只算不写（命令行脚本用）：解析、转换、绑定、校验全跑一遍，返回清单与警告，但**不建本体、不写草稿**。
   * 为什么要有它：一个几百 KB 的 bkn 文件导一次要建几十个类型，先 dry-run 一遍能确认"这个文件里到底有什么、
   * 会丢什么"，而不用先落一个本体再删。
   */
  dryRun: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission("ontology.write");
    const input = importInput.parse(await request.json());
    // 各阶段耗时随响应带出去：导入慢的时候能一眼看出是解析、绑定还是建快照慢。
    const startedAt = Date.now();
    const timings: Record<string, number> = {};
    let step = startedAt;
    const mark = (key: string) => { timings[key] = Date.now() - step; step = Date.now(); };
    const raw = typeof input.bundle === "string" ? (JSON.parse(input.bundle) as unknown) : input.bundle;
    const converted = isBknKnowledgeNetwork(raw) ? fromBknKnowledgeNetwork(raw) : null;
    const bundle = converted ? converted.bundle : readOntologyBundle(raw);
    mark("parse_ms");

    const storage = await getTarget(input.storageTargetId);
    if (!storage) return NextResponse.json({ error: "存储资源不存在。" }, { status: 404 });

    const plan = planBundleImport(bundle, await listDataSources());
    mark("plan_ms");
    // 转换阶段丢的内容排在前面：那些是"文件里有、平台装不下"，比资源匹配更要紧。
    const warnings = [...(converted?.warnings ?? []), ...plan.warnings];
    /*
     * 资源绑定补齐：本体包里没带资源坐标（bkn 导入就是这样）时，按「模式.表」在本机资源里找。
     * 唯一命中就自动绑；不确定的留空交给界面选（导入响应里带 pendingSources）。
     */
    const hints = await collectSourceHints();
    const bindingPlan = planSourceBindings(plan.definition, hints);
    const explicit = new Map<string, string>(Object.entries(input.bindings ?? {}));
    const resolved = applySourceBindings(plan.definition, new Map([...bindingPlan.bindings, ...explicit]));
    const pendingSources = toPendingSources(bindingPlan.pending, hints);
    if (bindingPlan.bindings.size) {
      warnings.push(`已按表名自动绑定 ${bindingPlan.bindings.size} 个数据来源。`);
    }
    mark("bind_ms");

    if (input.dryRun) {
      return NextResponse.json({
        dryRun: true,
        sourceFormat: converted ? "bkn-knowledge-network" : "ontology.bundle",
        ontology: {
          name: input.name?.trim() || bundle.ontology.name,
          identifier: bundle.ontology.identifier,
          description: bundle.ontology.description,
          tags: bundle.ontology.tags,
        },
        counts: {
          groups: resolved.groups.length,
          interfaces: resolved.interfaces.length,
          metrics: resolved.metrics.length,
          objectTypes: resolved.entityTypes.length,
          properties: resolved.entityTypes.reduce((total, entity) => total + entity.properties.length, 0),
          relationTypes: resolved.relationshipTypes.length,
          actionTypes: resolved.actionTypes.length,
          rules: resolved.rules.length,
        },
        warnings,
        pendingSources,
        timings: { ...timings, total_ms: Date.now() - startedAt },
      });
    }

    const ontology = await createOntology(
      {
        name: input.name?.trim() || bundle.ontology.name,
        description: bundle.ontology.description,
        color: bundle.ontology.color,
        tags: bundle.ontology.tags,
        storageTargetId: input.storageTargetId,
        identifier: bundle.ontology.identifier,
      },
      user.id,
    );

    let versionId: string;
    let entityCount: number;
    let relationshipCount: number;
    try {
      const target = await getTarget(ontology.target_id);
      if (!target) throw new Error("本体已建好，但它的存储记录没找到。");
      const record = await createVersionRecord({ targetId: ontology.target_id, versionNumber: 1, createdBy: user.id, definition: resolved });
      const manifest = await initializeVersionSnapshot(record.id, target, null);
      versionId = record.id;
      entityCount = manifest.entityCount;
      relationshipCount = manifest.relationshipCount;
    } catch (error) {
      // 草稿没建起来就别留一个空壳本体，否则用户会看到"有一个什么都没有的本体"。
      await deleteOntology(ontology.id).catch(() => {});
      throw error;
    }
    mark("create_ms");

    await writeAuditEntry({
      actorId: user.id,
      targetId: ontology.target_id,
      action: "ONTOLOGY_IMPORTED",
      details: {
        ontologyId: ontology.id,
        name: ontology.name,
        from: bundle.ontology.identifier || bundle.ontology.name,
        exportedAt: bundle.exportedAt,
        formatVersion: bundle.formatVersion,
        sourceFormat: converted ? "bkn-knowledge-network" : "ontology.bundle",
        versionId,
        objectTypes: resolved.entityTypes.length,
        relationTypes: resolved.relationshipTypes.length,
        boundSources: bindingPlan.bindings.size + explicit.size,
        warnings,
      },
    });

    return NextResponse.json(
      { ontology, versionId, entityCount, relationshipCount, warnings, pendingSources, timings: { ...timings, total_ms: Date.now() - startedAt } },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "无法导入本体。");
    return NextResponse.json({ error: message }, { status: apiErrorStatus(error, 400) });
  }
}
