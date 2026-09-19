import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { fromBknKnowledgeNetwork, isBknKnowledgeNetwork } from "@/lib/bkn-import";
import { listDataSources } from "@/lib/data-sources";
import { readDataSourceCatalogCache, type DataSourceCatalogCache } from "@/lib/platform-db";
import { createOntology, deleteOntology } from "@/lib/ontologies";
import { planBundleImport, readOntologyBundle } from "@/lib/ontology-bundle";
import { writeAuditEntry } from "@/lib/platform-db";
import { applySourceBindings, planSourceBindings, type SourceHint } from "@/lib/source-binding";
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
});

/**
 * 本机数据资源的匹配依据：登记信息 + 已知的表清单（结构缓存里的目录与看过的视图）。
 * 没读过结构的资源只有模式名可用 —— 那就只会参与弱匹配。
 */
async function sourceHints(): Promise<SourceHint[]> {
  const sources = await listDataSources();
  return Promise.all(sources.filter((source) => source.enabled).map(async (source) => {
    const cache: DataSourceCatalogCache = await readDataSourceCatalogCache(source.id).catch(() => ({} as DataSourceCatalogCache));
    const objects = [
      ...Object.values(cache.catalog ?? {}).flatMap((bucket) => (bucket.objects ?? []) as { schema?: string; name?: string }[]),
      // 看过的视图以 `模式.表@行数` 为键 —— 它同样证明"这张表在这个资源里"。
      ...Object.keys(cache.views ?? {}).map((key) => {
        const [qualified] = key.split("@");
        const index = qualified.lastIndexOf(".");
        return index > 0 ? { schema: qualified.slice(0, index), name: qualified.slice(index + 1) } : { schema: "", name: qualified };
      }),
    ].map((object) => ({ schema: String(object.schema ?? ""), name: String(object.name ?? "") })).filter((object) => object.name);
    return { id: source.id, name: source.name, kind: source.kind, schema: source.schema_name, objects };
  }));
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = importInput.parse(await request.json());
    const raw = typeof input.bundle === "string" ? (JSON.parse(input.bundle) as unknown) : input.bundle;
    const converted = isBknKnowledgeNetwork(raw) ? fromBknKnowledgeNetwork(raw) : null;
    const bundle = converted ? converted.bundle : readOntologyBundle(raw);

    const storage = await getTarget(input.storageTargetId);
    if (!storage) return NextResponse.json({ error: "存储资源不存在。" }, { status: 404 });

    const plan = planBundleImport(bundle, await listDataSources());
    // 转换阶段丢的内容排在前面：那些是"文件里有、平台装不下"，比资源匹配更要紧。
    const warnings = [...(converted?.warnings ?? []), ...plan.warnings];
    /*
     * 资源绑定补齐：本体包里没带资源坐标（bkn 导入就是这样）时，按「模式.表」在本机资源里找。
     * 唯一命中就自动绑；不确定的留空交给界面选（导入响应里带 pendingSources）。
     */
    const hints = await sourceHints();
    const bindingPlan = planSourceBindings(plan.definition, hints);
    const explicit = new Map<string, string>(Object.entries(input.bindings ?? {}));
    const resolved = applySourceBindings(plan.definition, new Map([...bindingPlan.bindings, ...explicit]));
    const nameOfSource = new Map(hints.map((hint) => [hint.id, hint.name]));
    const pendingSources = bindingPlan.pending.map((item) => ({
      entityTypeId: item.unbound.entityTypeId,
      entityTypeName: item.unbound.entityTypeName,
      sourceId: item.unbound.sourceId,
      label: item.unbound.label,
      candidates: [...item.exact, ...item.schemaOnly].map((id) => ({ id, name: nameOfSource.get(id) ?? id, exact: item.exact.includes(id) })),
    }));
    if (bindingPlan.bindings.size) {
      warnings.push(`已按表名自动绑定 ${bindingPlan.bindings.size} 个数据来源。`);
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

    return NextResponse.json({ ontology, versionId, entityCount, relationshipCount, warnings, pendingSources }, { status: 201 });
  } catch (error) {
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "无法导入本体。");
    return NextResponse.json({ error: message }, { status: apiErrorStatus(error, 400) });
  }
}
