import { NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { readSkillFile } from "@/lib/skills";

/** 单个文件原样下载（Markdown / JSON 都是文本）。 */
export async function GET(request: Request, context: { params: Promise<{ skillId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { skillId } = await context.params;
    const relative = new URL(request.url).searchParams.get("path") ?? "";
    const file = await readSkillFile(skillId, relative);
    if (!file) return NextResponse.json({ error: "这个文件不在技能目录里。" }, { status: 404 });
    const name = file.path.split("/").pop() ?? "skill.md";
    return new NextResponse(file.content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法下载这个文件。") }, { status: apiErrorStatus(error, 401) });
  }
}