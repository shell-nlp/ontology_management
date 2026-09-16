import { NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { getSkill, readSkillFile } from "@/lib/skills";

/** 一套技能的全文：SKILL.md 与 references 下的参考文件一起给，界面左右切换着看。 */
export async function GET(_: Request, context: { params: Promise<{ skillId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { skillId } = await context.params;
    const skill = await getSkill(skillId);
    if (!skill) return NextResponse.json({ error: `没有叫「${skillId}」的技能。` }, { status: 404 });
    const files = [];
    for (const file of skill.files) {
      const read = await readSkillFile(skillId, file.path);
      if (read) files.push({ path: read.path, content: read.content, bytes: file.bytes, entry: file.entry });
    }
    return NextResponse.json({ skill: { ...skill, files }, });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取技能内容。") }, { status: apiErrorStatus(error, 401) });
  }
}