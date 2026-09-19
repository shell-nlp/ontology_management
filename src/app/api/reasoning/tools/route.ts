import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, currentUser, requireRole } from "@/lib/auth";
import { writeAuditEntry } from "@/lib/platform-db";
import { loadToolPolicy, saveToolPolicy, togglableToolNames } from "@/lib/reasoning/tool-policy";

/**
 * 工具开关：`GET` 读当前状态，`PUT` 保存（只有 ADMIN 能改）。
 *
 * 关掉的工具会同时从**平台内智能问答**与**外部 MCP 客户端**的工具清单里消失 ——
 * 只关界面不关服务端等于没关。
 */
const reasoningToolsInput = z.object({ disabledTools: z.array(z.string().trim().min(1).max(80)).max(50) });

export async function GET() {
  try {
    await requireRole("VIEWER");
    const policy = await loadToolPolicy();
    return NextResponse.json({ ...policy, togglable: togglableToolNames() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取工具开关。") }, { status: 400 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const user = await currentUser();
    await requireRole("ADMIN");
    const input = reasoningToolsInput.parse(await request.json());
    const policy = await saveToolPolicy({ disabledTools: input.disabledTools }, user?.id ?? undefined);
    await writeAuditEntry({ actorId: user?.id, action: "REASONING_TOOL_POLICY_UPDATED", details: { disabledTools: policy.disabledTools } });
    return NextResponse.json({ ...policy, togglable: togglableToolNames() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存工具开关失败。") }, { status: 400 });
  }
}
