import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { listDataSources } from "@/lib/data-sources";
import { getGraphStore } from "@/lib/graph";
import { writeAuditEntry } from "@/lib/platform-db";
import { getPublishedOntology } from "@/lib/published-ontology";
import { runReasoning } from "@/lib/reasoning/agent";
import { getTarget } from "@/lib/targets";

const inputSchema = z.object({
  targetId: z.string().uuid(),
  question: z.string().trim().min(1).max(500),
  maxSteps: z.number().int().min(1).max(100).optional(),
  /** 「问答配置」里的两个数。不传就是"不限制"，服务端只保留防跑穿的兜底。 */
  toolResultLimit: z.number().int().min(500).max(200_000).optional(),
  sqlRowLimit: z.number().int().min(1).max(5000).optional(),
});

/**
 * 跑一次推理：模型编排本体工具，多步查询后给出结论 + 证据。
 *
 * 刻意只在**已发布版本**上推理 —— 只有发布过的定义与图库里的实际数据是同一份，
 * 拿草稿去推理会得到"定义说有、图里没有"的矛盾结论。
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("VIEWER");
    const input = inputSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });

    let definition;
    try {
      definition = await getPublishedOntology(target.id);
    } catch {
      return NextResponse.json({ error: "该本体还没有发布版本，先在「本体草稿」里发布后再推理。" }, { status: 409 });
    }

    const store = getGraphStore(target);
    const runtimeTypes = await store.readRuntimeTypes().catch(() => null);
    // 对象类型绑了哪些表，模型自己看不到（绑定里只有资源 id），这里一并交给工具集翻译成可读文本。
    const dataSources = await listDataSources().catch(() => []);
    const run = await runReasoning({
      question: input.question,
      context: { store, definition, runtimeTypes, dataSources, toolResultLimit: input.toolResultLimit, sqlRowLimit: input.sqlRowLimit },
      maxSteps: input.maxSteps,
    });

    await writeAuditEntry({
      actorId: user.id,
      targetId: target.id,
      action: "REASONING_RUN",
      details: { question: input.question, steps: run.steps.length, stepCount: run.stepCount, maxSteps: run.maxSteps, model: run.model, truncated: run.truncated, elapsedMs: run.elapsedMs },
    });

    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "推理失败。") }, { status: 400 });
  }
}
