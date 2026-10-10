import { NextRequest } from "next/server";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { getReasoningRun, reasoningRunOwner } from "@/lib/reasoning/run-registry";
import { runEventStream } from "@/lib/reasoning/run-stream";

/**
 * 接上一轮推理：SSE。
 *
 * 和以前那条 `/api/reasoning/stream` 的关键差别是**运行不归这条连接所有** —— 断开只是
 * "这个人不看了"，服务端照常跑完并落库。这正是"切页面 / 新开一轮，后台继续跑"的实现方式。
 */

export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  let userId: string;
  try {
    const user = await requirePermission("reasoning.use");
    userId = user.id;
  } catch (error) {
    return Response.json({ error: apiErrorMessage(error, "无法读取这次推理。") }, { status: apiErrorStatus(error, 401) });
  }

  const { runId } = await context.params;
  // 别人的运行一律当作不存在：不靠界面客气地不给链接来兜底。
  if (reasoningRunOwner(runId) !== userId) return Response.json({ error: "这次推理不存在，可能已经结束很久了。" }, { status: 404 });
  const after = Number(request.nextUrl.searchParams.get("after") ?? "0");
  return runEventStream(getReasoningRun(runId), runId, after, request.signal);
}
