import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { writeAuditEntry } from "@/lib/platform-db";
import { getPublishedOntology } from "@/lib/published-ontology";
import { runReasoning, type AgentEvent } from "@/lib/reasoning/agent";
import { getTarget } from "@/lib/targets";

/**
 * 流式推理：SSE。事件体是 `data: {"type":"...", ...}`，前端按 type 分发。
 *
 * - thinking / answer：文字增量，边收边渲染
 * - answerReset：这一轮其实是去调工具的过渡语，界面要把已显示的文字清掉
 * - step：某一步工具执行完成
 * - done / error：收尾
 *
 * 校验与权限必须在**开流之前**做完：一旦开始返回 SSE，就没法再改 HTTP 状态码了。
 */

const inputSchema = z.object({
  targetId: z.string().uuid(),
  question: z.string().trim().min(1).max(500),
  maxSteps: z.number().int().min(1).max(16).optional(),
  thinking: z.boolean().optional(),
});

function frame(event: AgentEvent | { type: "error"; message: string }) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: NextRequest) {
  let input: z.infer<typeof inputSchema>;
  let actorId: string;
  try {
    const user = await requireRole("VIEWER");
    actorId = user.id;
    input = inputSchema.parse(await request.json());
  } catch (error) {
    const status = apiErrorStatus(error, 400);
    return Response.json({ error: apiErrorMessage(error, "请求不合法。") }, { status });
  }

  const target = await getTarget(input.targetId);
  if (!target) return Response.json({ error: "本体存储不存在。" }, { status: 404 });

  let definition;
  try {
    definition = await getPublishedOntology(target.id);
  } catch {
    return Response.json({ error: "该本体还没有发布版本，先在「本体草稿」里发布后再提问。" }, { status: 409 });
  }

  const store = getGraphStore(target);
  const runtimeTypes = await store.readRuntimeTypes().catch(() => null);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentEvent | { type: "error"; message: string }) => {
        controller.enqueue(encoder.encode(frame(event)));
      };
      try {
        const run = await runReasoning({
          question: input.question,
          context: { store, definition, runtimeTypes },
          maxSteps: input.maxSteps,
          thinking: input.thinking,
          onEvent: send,
        });
        await writeAuditEntry({
          actorId,
          targetId: target.id,
          action: "REASONING_RUN",
          details: { question: input.question, steps: run.steps.length, model: run.model, truncated: run.truncated, elapsedMs: run.elapsedMs, thinking: input.thinking !== false, streamed: true },
        });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : "推理失败。" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // 关掉反向代理的缓冲，否则流会被攒成一坨再吐出来。
      "X-Accel-Buffering": "no",
    },
  });
}
