import { isSkillId, listSkills, parseSkillFrontMatter, readSkillFile, SKILL_CATALOG, type SkillDetail } from "@/lib/skills";

/**
 * 本体技能的 MCP 服务端（协议面 + 执行逻辑，路由见 `@/app/api/skills/mcp/route.ts`）。
 *
 * 为什么要有它：技能原来只有"下载 zip → 手工放进 Agent 技能目录"一条路。现在多一条**直连**的路 ——
 * 外部 Agent 在 MCP 配置里填一个地址，就能自己列出技能、取技能全文，不用先下载再配置。
 * 两条路**都保留**（2026-09-18 用户口径："就是 skill 和 mcp 都支持的那种"），
 * 下载那条走 `/api/skills/archive`，别把那个口子关掉。
 *
 * 两条不变量，改这块时别破：
 *
 * 1. **免令牌**：技能是一组建模方法（Markdown），不含凭据、不含本体数据、不碰数据库，
 *    所以这个端点不鉴权（2026-09-18 用户明确要求"这个 mcp 不需要 token 就可以访问"）。
 *    它与 `/api/mcp`（查本体、要 `MCP_API_TOKEN`）是**两个独立的服务端**，别把两边的鉴权混起来。
 * 2. **正文只读盘**：工具与提示词里的技能内容一律走 `@/lib/skills`，这里只写协议面的文案，
 *    免得技能改了这里还留着旧的一份（`skills.test.ts` 会盯住工具能取到真内容）。
 *
 * 对外两个能力：
 *   - tools：`list_skills` / `get_skill` / `get_skill_file`
 *   - prompts：一套技能一个提示词（客户端里就是一个斜杠命令），内容就是它的 SKILL.md
 */

export const SKILLS_MCP_SERVER_NAME = "ontology-skills";
export const SKILLS_MCP_SERVER_VERSION = "0.1.0";

export const SKILLS_MCP_INSTRUCTIONS = [
  "这是本体平台的「本体技能」MCP 服务：把三套本体构建方法（需求澄清 / 本体设计 / 出包交付）直接发布给外部 Agent，免令牌。",
  "做本体相关任务前先调 list_skills 看有哪些技能，再用 get_skill 取技能全文（SKILL.md），照着它执行；正文里点到的 references/… 与 scripts/… 用 get_skill_file 取。",
  "三套技能最终产出一份可直接导入平台的本体包 JSON（format: ontology.bundle）。本服务只提供方法说明，不读也不写平台里的任何本体数据。",
].join("\n");

export type SkillMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SKILL_ID_PROPERTY = {
  type: "string",
  description: "技能 id（就是技能目录名）。先调 list_skills 拿。",
  enum: SKILL_CATALOG.map((entry) => entry.id),
};

export const SKILL_MCP_TOOLS: readonly SkillMcpTool[] = [
  {
    name: "list_skills",
    title: "技能清单",
    description: "列出平台自带的三套本体构建技能：id、编号、名称、适用场景、主要产物与文件表。做本体相关任务前先调它，再按需用 get_skill 取技能全文。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_skill",
    title: "技能全文",
    description: "取一套技能的入口正文（SKILL.md，含 front-matter 的 name / description）与它的文件表。正文就是这套技能的完整说明，照它执行；正文里点到的 references/… 用 get_skill_file 取。",
    inputSchema: {
      type: "object",
      properties: { skill_id: SKILL_ID_PROPERTY },
      required: ["skill_id"],
    },
  },
  {
    name: "get_skill_file",
    title: "技能参考文件",
    description: "取技能目录里的一个文件：格式说明、示例包、建模细则、编译脚本等。路径相对技能目录，例如 references/bundle-format.md、scripts/build-bundle.mjs。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: SKILL_ID_PROPERTY,
        path: { type: "string", description: "相对技能目录的路径，用 / 分隔，例如 references/bundle-format.md。" },
      },
      required: ["skill_id", "path"],
    },
  },
];

export function findSkillMcpTool(name: string) {
  return SKILL_MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** 技能清单里给模型看的形状：**不含正文**，正文单独用 get_skill 取。 */
function skillSummary(skill: SkillDetail) {
  return {
    id: skill.id,
    stage: skill.stage,
    title: skill.title,
    description: skill.description,
    scenario: skill.scenario,
    outputs: skill.outputs,
    files: skill.files.map((file) => file.path),
  };
}

function unknownSkillMessage(skillId: string) {
  return `没有叫「${skillId}」的技能。可选：${SKILL_CATALOG.map((entry) => entry.id).join("、")}。`;
}

async function listSkillsPayload() {
  const skills = await listSkills();
  return {
    skills: skills.map(skillSummary),
    note: "取技能全文用 get_skill(skill_id)；正文里点到的参考文件用 get_skill_file(skill_id, path)。",
  };
}

async function getSkillPayload(skillId: string) {
  if (!isSkillId(skillId)) throw new Error(unknownSkillMessage(skillId));
  const skill = (await listSkills()).find((item) => item.id === skillId);
  if (!skill) throw new Error(`技能「${skillId}」在部署里没有内容（skills 目录缺失，或没被拷进镜像）。`);
  const markdown = await readSkillFile(skillId, "SKILL.md");
  if (!markdown) throw new Error(`技能「${skillId}」缺 SKILL.md。`);
  return {
    ...skillSummary(skill),
    skill_md: markdown.content,
    note: "这就是这套技能的完整说明，照它执行；正文里 `references/…` 与 `scripts/…` 的文件用 get_skill_file 取。",
  };
}

async function getSkillFilePayload(skillId: string, relative: string) {
  if (!isSkillId(skillId)) throw new Error(unknownSkillMessage(skillId));
  const read = await readSkillFile(skillId, relative);
  if (!read) {
    const files = (await listSkills()).find((item) => item.id === skillId)?.files.map((file) => file.path) ?? [];
    throw new Error(`技能「${skillId}」里取不到「${relative}」（不存在，或文件超过大小上限）。可选：${files.join("、") || "（技能目录里没有内容）"}`);
  }
  return {
    skill_id: skillId,
    path: read.path,
    content: read.content,
    note: "这是技能自带的参考文件。可执行脚本（scripts/*.mjs）请先落盘再用 Node 运行。",
  };
}

/**
 * 执行一个工具。**失败一律抛 Error**，由路由按 MCP 约定放进 `result.isError`
 * （模型看到原因能自己改对，比 JSON-RPC error 更有用）。
 */
export async function callSkillMcpTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!findSkillMcpTool(name)) throw new Error(`没有叫「${name}」的工具。先调 tools/list。`);
  if (name === "list_skills") return listSkillsPayload();

  const skillId = typeof args.skill_id === "string" ? args.skill_id.trim() : "";
  if (!skillId) throw new Error("缺少 skill_id。先调 list_skills 拿一个。");
  if (name === "get_skill") return getSkillPayload(skillId);

  const relative = typeof args.path === "string" ? args.path.trim() : "";
  if (!relative) throw new Error("缺少 path。例如 references/bundle-format.md。");
  return getSkillFilePayload(skillId, relative);
}

/** `prompts/list` 的清单：一套技能一条，客户端里就是一个斜杠命令。 */
export async function listSkillPrompts() {
  return (await listSkills()).map((skill) => ({
    name: skill.id,
    title: `${skill.stage}. ${skill.title}`,
    description: skill.description,
  }));
}

/**
 * `prompts/get`：提示词正文就是技能的 SKILL.md。
 *
 * 放在 **user 消息**里是有意的 —— 斜杠命令的语义就是"把这段说明当成我这一轮的输入"，
 * 而不是替模型说话。
 */
export async function readSkillPrompt(name: string) {
  if (!isSkillId(name)) return null;
  const markdown = await readSkillFile(name, "SKILL.md");
  if (!markdown) return null;
  return {
    description: parseSkillFrontMatter(markdown.content).description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: markdown.content } }],
  };
}
