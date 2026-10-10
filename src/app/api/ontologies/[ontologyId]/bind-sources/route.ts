import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { listDataSources } from "@/lib/datasource/sources";
import { getOntology } from "@/lib/platform/ontologies";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { applySourceBindings } from "@/lib/datasource/source-binding";
import { planSourceBindingsFor } from "@/lib/datasource/source-hints";
import { getVersionRecord, listVersionRecords, updateSnapshotDefinition } from "@/lib/versioning/snapshot";

const bindInput = z.object({
  versionId: z.string().uuid(),
  /** `对象类型id/sourceId` -> 数据资源 id。 */
  bindings: z.record(z.string(), z.string().uuid()),
});

/**
 * 导入之后补数据资源绑定。
 *
 * 导入时能按表名唯一命中的已经自动绑好了；剩下的（命中多个或都没命中）在导入弹窗里让人选一次，
 * 选完打到这里写进草稿 —— 不重新导入一遍，也不碰已发布的版本。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    await requirePermission("ontology.read");
    const { ontologyId } = await context.params;
    const ontology = await getOntology(ontologyId);
    if (!ontology) return NextResponse.json({ error: "本体不存在。" }, { status: 404 });
    // 不传版本就挑"当前该改的那个"：有草稿改草稿，否则看已发布版本还差什么。
    const versions = await listVersionRecords(ontology.target_id);
    const requested = request.nextUrl.searchParams.get("versionId");
    const version = requested
      ? versions.find((item) => item.id === requested) ?? null
      : versions.find((item) => item.status === "DRAFT") ?? versions.find((item) => item.status === "PUBLISHED") ?? null;
    if (!version) return NextResponse.json({ error: "这个本体还没有版本，先创建草稿。" }, { status: 404 });
    if (requested && version.status !== "DRAFT") return NextResponse.json({ error: "只有草稿版本可以改绑定。" }, { status: 409 });
    const sources = await listDataSources();
    const { pendingSources } = await planSourceBindingsFor(version.definition, sources.map((source) => source.id));
    return NextResponse.json({
      versionId: version.id,
      versionStatus: version.status,
      pendingSources,
      dataSources: sources.filter((source) => source.enabled).map((source) => ({ id: source.id, name: source.name, kind: source.kind })),
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取待补绑定的数据来源。") }, { status: apiErrorStatus(error) });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    const user = await requirePermission("ontology.write");
    const { ontologyId } = await context.params;
    const input = bindInput.parse(await request.json());
    const ontology = await getOntology(ontologyId);
    if (!ontology) return NextResponse.json({ error: "本体不存在。" }, { status: 404 });
    const version = await getVersionRecord(input.versionId);
    if (!version || version.target_id !== ontology.target_id) {
      return NextResponse.json({ error: "草稿不存在或不属于这个本体。" }, { status: 404 });
    }
    if (version.status !== "DRAFT") return NextResponse.json({ error: "只有草稿版本可以改绑定。" }, { status: 409 });
    const saved = await updateSnapshotDefinition(version.id, applySourceBindings(version.definition, new Map(Object.entries(input.bindings))));
    await writeAuditEntry({
      actorId: user.id,
      targetId: ontology.target_id,
      action: "ONTOLOGY_SOURCES_BOUND",
      details: { ontologyId, versionId: version.id, bindings: input.bindings },
    });
    return NextResponse.json({ saved: true, definition: saved });
  } catch (error) {
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "保存数据来源绑定失败。");
    return NextResponse.json({ error: message }, { status: apiErrorStatus(error) });
  }
}
