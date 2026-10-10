import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { getOntologyByTargetId } from "@/lib/ontology/ontologies";
import { listReasoningRuns, reasoningRunInput, startReasoningRun } from "@/lib/reasoning/run-registry";

/**
 * 起一轮推理 / 看当前本体上还在跑的那些。
 *
 * 分开成两个动作是有意的：**跑**不该等 HTTP 请求活着，**看**不该重新触发一次推理。
 * 界面切走再回来、刷新页面，都走 GET 接回原来的运行（见 `[runId]/events`）。
 */

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission("reasoning.use");
    const input = reasoningRunInput.parse(await request.json());
    const run = await startReasoningRun({ userId: user.id, actorId: user.id, input });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法开始这次推理。") }, { status: apiErrorStatus(error, 400) });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await requirePermission("reasoning.use");
    const targetId = request.nextUrl.searchParams.get("targetId")?.trim() ?? "";
    if (!targetId) return NextResponse.json({ error: "缺少 targetId。" }, { status: 400 });
    const ontology = await getOntologyByTargetId(targetId);
    const runs = listReasoningRuns(user.id, { ontologyId: ontology?.id ?? null, targetId });
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取正在运行的推理。") }, { status: apiErrorStatus(error, 401) });
  }
}
