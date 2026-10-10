import {
  getReasoningRun,
  readReasoningRunEvents,
  subscribeReasoningRun,
  type ReasoningRunSummary,
} from "@/lib/reasoning/run-registry";

/**
 * 把一轮运行变成 SSE 响应：先按游标补看不看过的部分，再接上后续增量。
 *
 * 两个端点（`/api/reasoning/runs/[runId]/events` 与 `/api/reasoning/stream`）共用这一份 ——
 * 协议只有一处实现，不会出现"这条路补得回、那条路补不回"的漂移。
 *
 * 每帧是 `{ i: 下标, e: 事件 }`：带下标界面才能把**被合并改写过的同一条**
 * （连续的文字增量并进上一条）就地替换，而不是再拼一遍。
 *
 * `after` **含端点**：游标那一条也重发一次 —— 它可能刚被并进更多文字。
 */
export function runEventStream(run: ReasoningRunSummary | null, runId: string, cursor: number, signal: AbortSignal): Response {
  if (!run) {
    return Response.json({ error: "这次推理不存在，可能已经结束很久了。" }, { status: 404 });
  }
  const from = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (index: number, event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ i: index, e: event })}\n\n`));
        } catch {
          closed = true;
        }
      };
      /*
       * **先订阅、再补看**：反过来的话，正好在这两步之间结束的那一轮会把最后的 done / saved 漏掉
       * （界面就一直停在"进行中"）。两边的帧都带下标，先来的后到不影响结果。
       */
      const unsubscribe = subscribeReasoningRun(runId, (payload) => send(payload.index, payload.event));
      for (const item of readReasoningRunEvents(runId, from)) send(item.index, item.event);

      const stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (timer) clearInterval(timer);
        signal.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // 已经关了。
        }
      };
      // 跑完就收尾。轮询一次状态，比让服务端为每个订阅者记一小份状态简单。
      const timer: ReturnType<typeof setInterval> = setInterval(() => {
        if (getReasoningRun(runId)?.status !== "running") stop();
      }, 1_000);
      signal.addEventListener("abort", stop);
      if (getReasoningRun(runId)?.status !== "running") stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
