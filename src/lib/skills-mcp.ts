import { isSkillId, listSkills, parseSkillFrontMatter, readSkillFile, SKILL_CATALOG, type SkillDetail } from "@/lib/skills";

/**
 * 本体技能的 MCP 服务端（协议面 + 执行逻辑，路由见 `@/app/api/skills/mcp/route.ts`）。
 *
 * 为什么要有它：技能原来只有"下载 zip → 手工放进 Agent 技能目录"一条路。现在多一条**直连**的路 ——
 * 外部 Agent 在 MCP 配置里填一个地址，就能自己列出技能、取技能全文，不用先下载再配置。
 * 两条路**都保留**（2026-09-18 用户口径："就是 skill 和 mcp 都支持的那种"），
 * 下载那条走 `/api/skills/archive`，别把那个口子关掉。
 *
 * 三条不变量，改这块时别破：
 *
 * 1. **免令牌**：技能是一组建模方法（Markdown），不含凭据、不含本体数据、不碰数据库，
 *    所以这个端点不鉴权（2026-09-18 用户明确要求"这个 mcp 不需要 token 就可以访问"）。
 *    它与 `/api/mcp`（查本体、要 `MCP_API_TOKEN`）是**两个独立的服务端**，别把两边的鉴权混起来。
 * 2. **正文只读盘**：工具与提示词里的技能内容一律走 `@/lib/skills`，这里只写协议面的文案，
 *    免得技能改了这里还留着旧的一份（`skills.test.ts` 会盯住工具能取到真内容）。
 * 3. **名字要自己说得清**（2026-09-18 用户报的：「这些 mcp tools 的名字不太好，agent 不知道它们的
 *    干什么的，别人配置了都不知道是干什么的」+「mcp 和 skills 要有区别」）：
 *    客户端会把**所有** MCP 服务端的工具摊在同一张表里，所以
 *      - 工具名必须带 `ontology_build_skill` 这一串 —— 既说清"这是本体**构建技能**"，
 *        又与查本体数据的那个 MCP（`list_ontologies` / `get_object_type` / `search_schema`…）**一眼分得开**；
 *      - `description` 按 **用途 / 怎么用 / 输入 / 产出** 四段写，让模型不点开 schema 也知道怎么用。
 *    别退回成 `list_skills` / `get_skill` 这种光看名字不知道是谁家的短名。
 *
 * 对外两个能力：
 *   - tools：`list_ontology_build_skills` / `get_ontology_build_skill` / `get_ontology_build_skill_file`
 *   - prompts：一套技能一个提示词（客户端里就是一个斜杠命令），内容就是它的 SKILL.md
 */

export const SKILLS_MCP_SERVER_NAME = "ontology-skills";
export const SKILLS_MCP_SERVER_VERSION = "0.1.0";

export const SKILLS_MCP_INSTRUCTIONS = [
  "这是本体平台的「本体技能」MCP 服务：把平台自带的三套**本体构建技能**（需求澄清 / 本体设计 / 出包交付）直接发布给外部 Agent，免令牌。",
  "用途：把业务材料一步一步建成一份能导入平台的本体（format: ontology.bundle）。怎么用：先调 list_ontology_build_skills 看该用哪套技能，再调 get_ontology_build_skill 取那套技能的完整说明并照着执行；说明里点到的 references/… 与 scripts/… 用 get_ontology_build_skill_file 取。",
  "注意区分两个 MCP 服务端：**本服务只给建模方法与格式说明**（读 `skills/` 目录里的 Markdown，不碰平台数据）；要查平台里已有的本体数据（对象类型 / 关系类型 / 动作 / 数据资源），连的是另一个 MCP 服务 `/api/mcp`，那个要令牌。",
].join("\n");

export type SkillMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SKILL_ID_PROPERTY = {
  type: "string",
  description: "本体构建技能的 id，必须来自 list_ontology_build_skills 的结果（例如 ontology-builder）。",
  enum: SKILL_CATALOG.map((entry) => entry.id),
};

export const SKILL_MCP_TOOLS: readonly SkillMcpTool[] = [
  {
    name: "list_ontology_build_skills",
    title: "本体技能清单",
    description: "用途：看这个平台自带哪几套「把业务材料建成本体」的技能，判断该从哪套开始。输入：无参数。产出：三套技能（需求澄清 / 本体设计 / 出包交付）的 id、编号、名称、适用场景、主要产物与文件表。怎么用：拿到 id 后调 get_ontology_build_skill 取那套技能的完整说明。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_ontology_build_skill",
    title: "取本体技能全文",
    description: "用途：拿到一套本体构建技能「怎么做」的全部指令 —— 什么时候用它、按什么步骤做、每一步要产出什么、交付前的质量门禁。输入：skill_id（来自 list_ontology_build_skills）。产出：该技能的正文全文（SKILL.md）+ 它的文件表。怎么用：正文就是指令本身，照着执行；正文里点到的 references/… 与 scripts/… 用 get_ontology_build_skill_file 取。",
    inputSchema: {
      type: "object",
      properties: { skill_id: SKILL_ID_PROPERTY },
      required: ["skill_id"],
    },
  },
  {
    name: "get_ontology_build_skill_file",
    title: "取本体技能参考文件",
    description: "用途：读技能自带的格式规范、照抄示例，或取出包用的编译脚本。输入：skill_id（来自 list_ontology_build_skills）与 path（相对技能目录的路径，取自 get_ontology_build_skill 返回的文件表，例如 references/bundle-format.md、scripts/build-bundle.mjs）。产出：该文件的文本内容（Markdown / JSON / Node 脚本）。",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: SKILL_ID_PROPERTY,
        path: { type: "string", description: "相对技能目录的路径，用 / 分隔；取值来自 get_ontology_build_skill 返回的文件表。" },
      },
      required: ["skill_id", "path"],
    },
  },
];

export function findSkillMcpTool(name: string) {
  return SKILL_MCP_TOOLS.find((tool) => tool.name === name) ?? null;
}

/** 技能清单里给模型看的形状：**不含正文**，正文单独用 get_ontology_build_skill 取。 */
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
  return `没有叫「${skillId}」的本体构建技能。可选：${SKILL_CATALOG.map((entry) => entry.id).join("、")}。`;
}

async function listSkillsPayload() {
  const skills = await listSkills();
  return {
    skills: skills.map(skillSummary),
    note: "取某套技能的完整说明用 get_ontology_build_skill(skill_id)；说明里点到的参考文件用 get_ontology_build_skill_file(skill_id, path)。",
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
    note: "这就是这套技能的完整说明，照它执行；说明里 `references/…` 与 `scripts/…` 的文件用 get_ontology_build_skill_file 取。",
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
  if (name === "list_ontology_build_skills") return listSkillsPayload();

  const skillId = typeof args.skill_id === "string" ? args.skill_id.trim() : "";
  if (!skillId) throw new Error("缺少 skill_id。先调 list_ontology_build_skills 拿一个。");
  if (name === "get_ontology_build_skill") return getSkillPayload(skillId);

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
