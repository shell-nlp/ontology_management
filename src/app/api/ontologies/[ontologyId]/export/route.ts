import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { listDataSources } from "@/lib/data-sources";
import { getOntology } from "@/lib/ontologies";
import { buildOntologyBundle, bundleFileName } from "@/lib/ontology-bundle";
import { getTarget } from "@/lib/targets";
import { listVersionRecords } from "@/lib/version-snapshot";

/**
 * 导出本体包：一个 JSON 文件带走这份本体的**结构**。
 *
 * 取哪一版的定义：优先已发布版本，没有就取草稿 —— 和本体列表页统计口径一致
 * （用户看到卡片上写着"对象类型 3"，导出的就该是这 3 个）。
 * 实例数据不导出，只把数量写进 statistics，让接收方能一眼看出这份包有没有配套数据。
 */
export async function GET(_: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { ontologyId } = await context.params;
    const ontology = await getOntology(ontologyId);
    if (!ontology) return NextResponse.json({ error: "本体不存在。" }, { status: 404 });
    const target = await getTarget(ontology.target_id);
    if (!target) return NextResponse.json({ error: "这个本体的存储已不存在。" }, { status: 409 });

    const records = await listVersionRecords(ontology.target_id).catch(() => []);
    const published = records.find((record) => record.status === "PUBLISHED");
    const draft = records.find((record) => record.status === "DRAFT");
    const source = published ?? draft;
    if (!source) return NextResponse.json({ error: "这个本体还没有草稿或已发布版本，没有可以导出的结构。" }, { status: 409 });

    const bundle = buildOntologyBundle({
      ontology: { identifier: ontology.identifier, name: ontology.name, description: ontology.description, color: ontology.color, tags: ontology.tags },
      definition: source.definition,
      dataSources: await listDataSources(),
      instances: { objects: source.entity_count, relationships: source.relationship_count },
    });

    const file = bundleFileName(ontology);
    return new NextResponse(`${JSON.stringify(bundle, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // 中文文件名走 RFC 5987，同时给一个 ASCII 兜底，老浏览器也能存下来。
        "Content-Disposition": `attachment; filename="${file.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法导出本体。") }, { status: apiErrorStatus(error, 401) });
  }
}