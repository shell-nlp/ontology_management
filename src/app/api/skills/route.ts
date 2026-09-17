import { NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { listSkills } from "@/lib/skills";

/**
 * 本体技能清单。
 *
 * 技能是**平台自带的一套建模方法**（仓库根的 `skills/` 目录），这里只列清单：有哪些、多大、有哪些文件。
 * 这里**不下发正文** —— 「本体技能」页只给清单，技能全文由 `…/:id/file` 与 `…/:id/archive` 下载，
 * 不必一进页面就传几百 KB。
 */
export async function GET() {
  try {
    await requireRole("VIEWER");
    const skills = await listSkills();
    return NextResponse.json({
      skills: skills.map((skill) => ({
        id: skill.id,
        stage: skill.stage,
        title: skill.title,
        scenario: skill.scenario,
        outputs: skill.outputs,
        icon: skill.icon,
        description: skill.description,
        files: skill.files,
      })),
      /** 技能目录缺失时给出可操作的原因，而不是一个空列表。 */
      hint: skills.length === 0 ? "没有找到 skills 目录：本机开发时它的位置是仓库根的 skills/，容器里由镜像拷进去。" : null,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取技能清单。") }, { status: apiErrorStatus(error, 401) });
  }
}