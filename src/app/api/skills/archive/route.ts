import { NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { readSkillsArchive } from "@/lib/skills";
import { createZip } from "@/lib/zip";

/**
 * 把**全部技能**打成一个 zip。
 *
 * 只有这一个下载口（2026-09-17 用户要求"不要支持一个一个下载，要只支持整体下载"）：
 * 解压出来是 `ontology-requirement/` `ontology-builder/` `ontology-bundle/` 三个目录，
 * 整个放进 Agent 的技能目录即可；示例本体包在 `ontology-bundle/references/` 里随包下发。
 *
 * 自己打 zip 的理由见 `@/lib/zip`：只为"一次下载、解压即用"，不值得引一个打包库。
 */
export async function GET(_: Request) {
  try {
    await requireRole("VIEWER");
    const files = await readSkillsArchive();
    if (files.length === 0) return NextResponse.json({ error: "技能目录里没有内容。" }, { status: 404 });
    const zip = createZip(files);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"ontology-skills.zip\"; filename*=UTF-8''ontology-skills.zip",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法打包技能。") }, { status: apiErrorStatus(error, 401) });
  }
}