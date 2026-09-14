import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { getOntologyByTargetId } from "@/lib/ontologies";
import { listConversations } from "@/lib/reasoning/conversations";

/**
 * 对话历史列表。按落点查，服务端自己翻出它属于哪个本体 ——
 * 界面只需要知道自己当前在哪个本体上，不必再维护一份本体 id。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim() ?? "";
    if (!targetId) return NextResponse.json({ error: "缺少 targetId。" }, { status: 400 });
    const ontology = await getOntologyByTargetId(targetId);
    const conversations = await listConversations({ ontologyId: ontology?.id ?? null, targetId }, user.id);
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取对话历史。") }, { status: apiErrorStatus(error, 401) });
  }
}
