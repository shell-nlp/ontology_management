import { NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { isLlmConfigured, llmConfig } from "@/lib/reasoning/llm";

/** 推理页启动时问一次：模型配好了没。没配就明确提示，别让用户对着按钮发呆。 */
export async function GET() {
  try {
    await requireRole("VIEWER");
    const config = llmConfig();
    return NextResponse.json({ configured: isLlmConfigured(), model: config?.model ?? null, endpoint: config?.baseUrl ?? null });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取模型配置。") }, { status: 400 });
  }
}
