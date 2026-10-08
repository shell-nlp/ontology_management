import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, currentUser, requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { clearToolPolicyOverride, loadResolvedToolPolicy, saveToolPolicy, togglableToolNames } from "@/lib/reasoning/tool-policy";

/**
 * 工具开关：`GET` 读当前状态，`PUT` 保存（只有 ADMIN 能改）。
 *
 * 关掉的工具会同时从**平台内智能问答**与**外部 MCP 客户端**的工具清单里消失 ——
 * 只关界面不关服务端等于没关。
 *
 * **按本体分（2026-10-08 用户要求）**：带 `ontologyId` 就是"这个本体单独配置"，
 * 不带就是改**全局默认**。读的时候覆盖优先、没有覆盖就跟着全局 ——
 * 所以响应里把 `source` / `globalDisabledTools` / `overrideDisabledTools` 一起给出去，
 * 界面才能如实显示「跟随全局」还是「当前本体单独配置」。
 */
const reasoningToolsInput = z.object({
  disabledTools: z.array(z.string().trim().min(1).max(80)).max(50),
  /** 改哪个本体的开关；不传 = 改全局默认。 */
  ontologyId: z.string().uuid().optional(),
  /** true = 撤销这个本体的覆盖，回到跟随全局（此时忽略 disabledTools）。 */
  reset: z.boolean().optional(),
});

/** 响应形状统一：生效值 + 来源 + 两层原值 + 可开关清单。 */
async function readState(ontologyId: string | null) {
  const resolved = await loadResolvedToolPolicy(ontologyId);
  return {
    ontologyId: resolved.ontologyId,
    disabledTools: resolved.policy.disabledTools,
    // 字段名与 `/api/mcp/info` 保持一致（界面两个响应共用一份类型，别一个叫 source 一个叫 toolPolicySource）。
    toolPolicySource: resolved.source,
    globalDisabledTools: resolved.global.disabledTools,
    overrideDisabledTools: resolved.override?.disabledTools ?? null,
    togglable: togglableToolNames(),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const ontologyId = request.nextUrl.searchParams.get("ontologyId")?.trim() || null;
    return NextResponse.json(await readState(ontologyId));
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取工具开关。") }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await currentUser();
    await requireRole("ADMIN");
    const input = reasoningToolsInput.parse(await request.json());
    if (input.reset) {
      if (!input.ontologyId) return NextResponse.json({ error: "撤销覆盖要带 ontologyId。" }, { status: 400 });
      await clearToolPolicyOverride(input.ontologyId);
      await writeAuditEntry({
        action: "REASONING_TOOL_POLICY_UPDATED",
        actorId: user?.id,
        details: { scope: "ONTOLOGY", ontologyId: input.ontologyId, reset: true, note: "撤销本体覆盖，回到跟随全局默认。" },
      });
      return NextResponse.json(await readState(input.ontologyId));
    }
    const policy = await saveToolPolicy({ disabledTools: input.disabledTools }, user?.id ?? undefined, input.ontologyId ?? null);
    await writeAuditEntry({
      action: "REASONING_TOOL_POLICY_UPDATED",
      actorId: user?.id,
      details: { scope: input.ontologyId ? "ONTOLOGY" : "GLOBAL", ...(input.ontologyId ? { ontologyId: input.ontologyId } : {}), disabledTools: policy.disabledTools },
    });
    return NextResponse.json(await readState(input.ontologyId ?? null));
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存工具开关失败。") }, { status: 400 });
  }
}
