import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp-protocol";
import { publicOrigin } from "@/lib/public-origin";
import { listSkills } from "@/lib/skills";
import { SKILLS_MCP_SERVER_NAME, SKILL_MCP_TOOLS } from "@/lib/skills-mcp";

/**
 * 本体技能清单 + 它的 MCP 接入信息。
 *
 * 技能是**平台自带的一套建模方法**（仓库根的 `skills/` 目录）。取用有两条路，这里都要交代：
 *
 *   1. **MCP 直连（免令牌）**：把 `mcp.absoluteUrl` 填进 Agent 的 MCP 配置，它自己就能取技能。
 *   2. **整包下载**：`GET /api/skills/archive` 拿 zip，解压进 Agent 的技能目录离线用。
 *
 * 正文一律不下发 —— 「本体技能」页只给清单，不必一进页面就传几百 KB。
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const skills = await listSkills();
    const origin = publicOrigin(request);
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
      /**
       * MCP 接入信息：地址按**你当前访问平台的地址**拼（`publicOrigin`，看 Host / x-forwarded-*，
       * 不用 `nextUrl.origin` —— 那个在 dev 与容器里会落回 localhost，复制出去换台机器就废了）。
       * 令牌那一项恒为 false：这个端点不鉴权。
       */
      mcp: {
        serverName: SKILLS_MCP_SERVER_NAME,
        endpoint: "/api/skills/mcp",
        absoluteUrl: `${origin}/api/skills/mcp`,
        protocolVersion: MCP_PROTOCOL_VERSION,
        transport: "Streamable HTTP（JSON 响应）",
        tokenRequired: false,
        tools: SKILL_MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
      },
      /** 技能目录缺失时给出可操作的原因，而不是一个空列表。 */
      hint: skills.length === 0 ? "没有找到 skills 目录：本机开发时它的位置是仓库根的 skills/，容器里由镜像拷进去。" : null,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取技能清单。") }, { status: apiErrorStatus(error, 401) });
  }
}
