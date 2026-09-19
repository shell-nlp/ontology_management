import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { getOntology } from "@/lib/ontologies";
import { writeAuditEntry } from "@/lib/platform-db";
import { applySourceBindings } from "@/lib/source-binding";
import { getVersionRecord, updateSnapshotDefinition } from "@/lib/version-snapshot";

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
export async function POST(request: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
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
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "保存数据来源绑定失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
}
