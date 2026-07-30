import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";

export async function PATCH(request: NextRequest, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const definition = ontologyDefinitionSchema.parse((await request.json()).definition);
    const result = await platformQuery<{ target_id: string; status: string }>(
      "SELECT target_id, status FROM ontology_platform.ontology_versions WHERE id = $1", [versionId],
    );
    const version = result.rows[0];
    if (!version) return NextResponse.json({ error: "本体草稿不存在。" }, { status: 404 });
    if (version.status !== "DRAFT") return NextResponse.json({ error: "已发布版本不可直接修改，请创建新草稿。" }, { status: 409 });
    await platformQuery("UPDATE ontology_platform.ontology_versions SET definition = $1 WHERE id = $2", [JSON.stringify(definition), versionId]);
    await writeAuditEntry({ actorId: user.id, targetId: version.target_id, action: "ONTOLOGY_DRAFT_UPDATED", details: { versionId } });
    return NextResponse.json({ saved: true, definition });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "保存草稿失败。" }, { status: 400 });
  }
}
