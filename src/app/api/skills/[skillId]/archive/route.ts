import { NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { readSkillArchive } from "@/lib/skills";
import { createZip } from "@/lib/zip";

/**
 * 整套技能打成 zip：解压出来就是一个可以直接放进 Agent 技能目录的文件夹。
 *
 * 之所以自己打 zip（见 @/lib/zip）：只是为了"一次下载、解压即用"，
 * 为这一个用途引一个打包库不划算。
 */
export async function GET(_: Request, context: { params: Promise<{ skillId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { skillId } = await context.params;
    const files = await readSkillArchive(skillId);
    if (!files || files.length === 0) return NextResponse.json({ error: `没有叫「${skillId}」的技能。` }, { status: 404 });
    const zip = createZip(files);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${skillId}.zip"; filename*=UTF-8''${encodeURIComponent(`${skillId}.zip`)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法打包这套技能。") }, { status: apiErrorStatus(error, 401) });
  }
}