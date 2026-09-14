import { NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { isLlmConfigured, llmSettings } from "@/lib/reasoning/provider";

/** 推理页启动时问一次：模型配好了没。没配就明确提示，别让用户对着按钮发呆。 */
export async function GET() {
  try {
    await requireRole("VIEWER");
    const config = llmSettings();
    return NextResponse.json({ configured: isLlmConfigured(), model: config?.modelId ?? null, endpoint: config?.baseUrl ?? null });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取模型配置。") }, { status: 400 });
  }
}
