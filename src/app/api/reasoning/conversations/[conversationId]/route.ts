import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { getOntologyByTargetId } from "@/lib/ontologies";
import { deleteConversation, getConversation, type ConversationScope } from "@/lib/reasoning/conversations";

/**
 * 一段对话的读取与删除。
 *
 * 两件事都先按「落点 + 当前用户」把范围定死：别人的记录、别的本体的记录
 * 一律当作不存在（404），不靠界面客气地不显示链接来兜底。
 */
async function scopeOf(targetId: string): Promise<ConversationScope> {
  const ontology = await getOntologyByTargetId(targetId);
  return { ontologyId: ontology?.id ?? null, targetId };
}

export async function GET(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const user = await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim() ?? "";
    if (!targetId) return NextResponse.json({ error: "缺少 targetId。" }, { status: 400 });
    const { conversationId } = await context.params;
    const conversation = await getConversation(await scopeOf(targetId), user.id, conversationId);
    if (!conversation) return NextResponse.json({ error: "这段对话不存在。" }, { status: 404 });
    return NextResponse.json(conversation);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取这段对话。") }, { status: apiErrorStatus(error, 401) });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const user = await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim() ?? "";
    if (!targetId) return NextResponse.json({ error: "缺少 targetId。" }, { status: 400 });
    const { conversationId } = await context.params;
    const removed = await deleteConversation(await scopeOf(targetId), user.id, conversationId);
    if (!removed) return NextResponse.json({ error: "这段对话不存在。" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法删除这段对话。") }, { status: apiErrorStatus(error, 400) });
  }
}
