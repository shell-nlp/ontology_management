import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/auth";
import { cancelReasoningRun, getReasoningRun, reasoningRunOwner } from "@/lib/reasoning/run-registry";

/**
 * 用户点「停止」：掐断这一轮。
 *
 * 只有显式的这个请求会停 —— 关页面 / 切走都只是"不看了"，运行照常在后台跑完并落进历史。
 * 停的是"继续往下查"，已经跑出来的思考、步骤与半截结论照常收尾。
 */
export async function POST(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const user = await requirePermission("reasoning.use");
    const { runId } = await context.params;
    const run = getReasoningRun(runId);
    if (!run || reasoningRunOwner(runId) !== user.id) return NextResponse.json({ error: "这次推理不存在，可能已经结束了。" }, { status: 404 });
    const cancelled = cancelReasoningRun(runId);
    return NextResponse.json({ cancelled });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法停止这次推理。") }, { status: apiErrorStatus(error, 400) });
  }
}
