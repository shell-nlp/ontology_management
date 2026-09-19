import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { listDataSources } from "@/lib/data-sources";
import { getGraphStore } from "@/lib/graph";
import { writeAuditEntry } from "@/lib/platform-db";
import { getPublishedOntology } from "@/lib/published-ontology";
import { loadToolPolicy } from "@/lib/reasoning/tool-policy";
import { runReasoning } from "@/lib/reasoning/agent";
import { attachmentsSchema } from "@/lib/reasoning/attachment-schema";
import { effectiveQuestion } from "@/lib/reasoning/attachments";
import { getTarget } from "@/lib/targets";

const reasoningRunInput = z.object({
  targetId: z.string().uuid(),
  // 问题可以为空：只带图片提问时由 effectiveQuestion 补一句默认的（见 attachments.ts）。
  question: z.string().trim().max(500),
  /** 和问题一起发过去的图片；张数 / 体积 / 类型上限见 attachments.ts。 */
  attachments: attachmentsSchema,
  maxSteps: z.number().int().min(1).max(100).optional(),
  /** 「问答配置」里的两个数。不传就是"不限制"，服务端只保留防跑穿的兜底。 */
  toolResultLimit: z.number().int().min(500).max(200_000).optional(),
  sqlRowLimit: z.number().int().min(1).max(5000).optional(),
  /** 「问答配置」里改过的系统提示词。不传（或空白）就用默认那段。 */
  systemPrompt: z.string().trim().max(20_000).optional(),
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
    const input = reasoningRunInput.parse(await request.json());
    const question = effectiveQuestion(input.question, input.attachments ?? []);
    if (!question) return NextResponse.json({ error: "问题不能为空。" }, { status: 400 });
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
    // 工具开关跟着平台库走：MCP 那边关掉的工具，这里也同样不发给模型。
    const policy = await loadToolPolicy();
    const run = await runReasoning({
      question,
      attachments: input.attachments,
      context: { store, definition, runtimeTypes, dataSources, toolResultLimit: input.toolResultLimit, sqlRowLimit: input.sqlRowLimit },
      maxSteps: input.maxSteps,
      disabledTools: policy.disabledTools,
      systemPrompt: input.systemPrompt,
    });

    await writeAuditEntry({
      actorId: user.id,
      targetId: target.id,
      action: "REASONING_RUN",
      details: { question, attachments: input.attachments?.length ?? 0, steps: run.steps.length, stepCount: run.stepCount, maxSteps: run.maxSteps, model: run.model, truncated: run.truncated, elapsedMs: run.elapsedMs },
    });

    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "推理失败。") }, { status: 400 });
  }
}
