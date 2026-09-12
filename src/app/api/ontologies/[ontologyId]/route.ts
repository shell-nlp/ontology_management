import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { deleteOntology, getOntology, updateOntology } from "@/lib/ontologies";
import { writeAuditEntry } from "@/lib/platform-db";

const updateInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  color: z.string().max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
});

export async function GET(_: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { ontologyId } = await context.params;
    const ontology = await getOntology(ontologyId);
    if (!ontology) return NextResponse.json({ error: "本体不存在。" }, { status: 404 });
    return NextResponse.json(ontology);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取本体。") }, { status: apiErrorStatus(error, 401) });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { ontologyId } = await context.params;
    const input = updateInput.parse(await request.json());
    if (Object.keys(input).length === 0) return NextResponse.json({ error: "没有需要更新的字段。" }, { status: 400 });
    const ontology = await updateOntology(ontologyId, input);
    await writeAuditEntry({ actorId: user.id, targetId: ontology.target_id, action: "ONTOLOGY_UPDATED", details: { ontologyId, ...input } });
    return NextResponse.json(ontology);
  } catch (error) {
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "无法更新本体。");
    return NextResponse.json({ error: message }, { status: apiErrorStatus(error, 400) });
  }
}

export async function DELETE(_: NextRequest, context: { params: Promise<{ ontologyId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { ontologyId } = await context.params;
    const ontology = await getOntology(ontologyId);
    if (!ontology) return NextResponse.json({ error: "本体不存在。" }, { status: 404 });
    const { removedTargetId } = await deleteOntology(ontologyId);
    // 本体已经没了，审计只能挂空 targetId，把两个 id 都写进 details。
    await writeAuditEntry({
      actorId: user.id,
      action: "ONTOLOGY_DELETED",
      details: { ontologyId, name: ontology.name, targetId: ontology.target_id, removedTargetId },
    });
    return NextResponse.json({ deleted: true, removedTargetId });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法删除本体。") }, { status: apiErrorStatus(error, 400) });
  }
}
