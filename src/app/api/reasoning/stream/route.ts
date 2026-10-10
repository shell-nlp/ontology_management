import { NextRequest } from "next/server";
import { apiErrorMessage, apiErrorStatus, requirePermission } from "@/lib/platform/auth";
import { getReasoningRun, reasoningRunInput, startReasoningRun } from "@/lib/reasoning/run-registry";
import { runEventStream } from "@/lib/reasoning/run-stream";

/**
 * 「起一轮 + 就地看完」：一条请求里把推理跑起来并流式看完。
 *
 * **运行本身不归这条连接所有**（2026-10-10 起）：断开只是"不看了"，服务端照常跑完、照常落库。
 * 界面走的是先起再按游标接的两个端点（`/api/reasoning/runs` + `.../events`），
 * 这里保留给「一次调用拿到完整过程」的用法（脚本 / 外部客户端），语义与老版本一致，
 * 只是实现改成复用同一套运行登记处，不再自己编排一遍。
 */

export async function POST(request: NextRequest) {
  let actorId: string;
  let input;
  try {
    const user = await requirePermission("reasoning.use");
    actorId = user.id;
    input = reasoningRunInput.parse(await request.json());
  } catch (error) {
    return Response.json({ error: apiErrorMessage(error, "请求不合法。") }, { status: apiErrorStatus(error, 400) });
  }

  let runId: string;
  try {
    const run = await startReasoningRun({ userId: actorId, actorId, input });
    runId = run.runId;
  } catch (error) {
    return Response.json({ error: apiErrorMessage(error, "无法开始这次推理。") }, { status: apiErrorStatus(error, 409) });
  }

  return runEventStream(getReasoningRun(runId), runId, 0, request.signal);
}
