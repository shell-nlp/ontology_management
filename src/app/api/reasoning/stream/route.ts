import { NextRequest } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { listDataSources } from "@/lib/data-sources";
import { getGraphStore } from "@/lib/graph";
import { getOntologyByTargetId } from "@/lib/ontologies";
import { writeAuditEntry } from "@/lib/platform-db";
import { getPublishedOntology } from "@/lib/published-ontology";
import { runReasoning, type AgentEvent } from "@/lib/reasoning/agent";
import { saveTurn } from "@/lib/reasoning/conversations";
import { getTarget } from "@/lib/targets";

/**
 * 流式推理：SSE。事件体是 `data: {"type":"...", ...}`，前端按 type 分发。
 *
 * - thinking / answer：文字增量，边收边渲染
 * - answerReset：这一轮其实是去调工具的过渡语，界面要把已显示的文字清掉
 * - step：某一步工具执行完成
 * - saved：这一轮已经记进对话历史（`conversationId` 为 null 表示没记上）
 * - done / error：收尾
 *
 * 校验与权限必须在**开流之前**做完：一旦开始返回 SSE，就没法再改 HTTP 状态码了。
 */

const inputSchema = z.object({
  targetId: z.string().uuid(),
  question: z.string().trim().min(1).max(500),
  // 上限与服务端 agent.ts 的 MAX_STEPS_CEILING 对齐：那是防跑穿的兜底，不是给用户设的门槛。
  maxSteps: z.number().int().min(1).max(100).optional(),
  thinking: z.boolean().optional(),
  /** 有就追加到这段对话后面，没有就新开一段。 */
  conversationId: z.string().uuid().optional(),
  /** 「问答配置」里的两个数。不传就是"不限制"，服务端只保留防跑穿的兜底。 */
  toolResultLimit: z.number().int().min(500).max(200_000).optional(),
  sqlRowLimit: z.number().int().min(1).max(5000).optional(),
});

/** 除了编排层的事件，这个接口自己还会补两条：error 与 saved。 */
type RouteEvent =
  | AgentEvent
  | { type: "error"; message: string }
  | { type: "saved"; conversationId: string | null; warning?: string };

function frame(event: RouteEvent) {
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
  // 对象类型绑了哪些表，模型自己看不到（绑定里只有资源 id），这里一并交给工具集翻译成可读文本。
  const dataSources = await listDataSources().catch(() => []);
  // 历史归属在开流之前定下来：这两件事出错时还能回一个正常的 HTTP 错误码。
  const ontology = await getOntologyByTargetId(target.id);
  const scope = { ontologyId: ontology?.id ?? null, targetId: target.id };
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: RouteEvent) => {
        controller.enqueue(encoder.encode(frame(event)));
      };
      try {
        const run = await runReasoning({
          question: input.question,
          context: { store, definition, runtimeTypes, dataSources, toolResultLimit: input.toolResultLimit, sqlRowLimit: input.sqlRowLimit },
          maxSteps: input.maxSteps,
          thinking: input.thinking,
          onEvent: send,
        });
        await writeAuditEntry({
          actorId,
          targetId: target.id,
          action: "REASONING_RUN",
          details: { question: input.question, steps: run.steps.length, stepCount: run.stepCount, maxSteps: run.maxSteps, toolResultLimit: input.toolResultLimit ?? null, sqlRowLimit: input.sqlRowLimit ?? null, model: run.model, truncated: run.truncated, elapsedMs: run.elapsedMs, thinking: input.thinking !== false, streamed: true },
        });
        // 记进对话历史放在最后：跑挂了的一轮不留记录，历史里不会出现"点进去只有半句话"的条目。
        try {
          const conversationId = await saveTurn({
            scope,
            userId: actorId,
            conversationId: input.conversationId ?? null,
            question: input.question,
            answer: run.answer,
            thinking: run.reasoning,
            thinkingOn: input.thinking !== false,
            run,
            error: null,
          });
          send({ type: "saved", conversationId });
        } catch {
          // 落库失败不该吞掉已经跑出来的结论：界面照常显示，只是这条不进历史。
          send({ type: "saved", conversationId: null, warning: "结论已生成，但这次没能记进对话历史。" });
        }
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
