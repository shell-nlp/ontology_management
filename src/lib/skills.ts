import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseFrontMatter } from "@/lib/markdown";

/**
 * 本体构建技能：**平台里带着的一套建模方法**（Markdown），不是代码。
 *
 * 它是「本体技能」页与 `/api/skills*` 的唯一数据来源：技能文件放在仓库根的 `skills/`
 * （见该目录的 README），服务端按需读盘。这样做的好处是技能可以用编辑器/评审流程改，
 * 不需要重新构建前端；代价是运行时要有这个目录 —— 容器里由 Dockerfile 显式拷进去。
 *
 * 目录结构（每个技能一个目录）：
 *   skills/<技能名>/SKILL.md              技能入口，带 front-matter（name / description）
 *   skills/<技能名>/references/…          参考文件（格式说明、示例包、建模细则）
 */

/** 技能的展示信息（界面文案）。技能正文一律来自磁盘，不在这里重复维护。 */
export type SkillCatalogEntry = {
  id: string;
  /** 编号（界面上的 1 / 2 / 3），也是建议的使用顺序。 */
  stage: number;
  /** 中文名，界面上跟英文技能名并列显示。 */
  title: string;
  /** 什么时候用（一句话）。 */
  scenario: string;
  /** 主要产物（一句话）。 */
  outputs: string;
  /** 图标键，前端映射到 lucide 图标。 */
  icon: "requirement" | "builder" | "bundle";
};

export const SKILL_CATALOG: readonly SkillCatalogEntry[] = [
  {
    id: "ontology-requirement",
    stage: 1,
    title: "需求澄清",
    scenario: "访谈纪要、PRD、流程说明或初步想法还没整理，需要先明确业务目标、范围、对象与关系的候选，以及每个候选的数据落地线索。",
    outputs: "01-需求澄清.md：对象类型 / 关系类型 / 接口 / 动作 / 规则的候选清单 + 待确认问题。",
    icon: "requirement",
  },
  {
    id: "ontology-builder",
    stage: 2,
    title: "本体设计",
    scenario: "已有建模清单或业务材料，需要把粒度、命名、主键、属性类型、关系方向与约束定下来，形成可评审的建模方案。",
    outputs: "02-建模方案.md + *.ontology.json 初稿：对象类型、关系类型、接口、动作、规则、数据来源绑定。",
    icon: "builder",
  },
  {
    id: "ontology-bundle",
    stage: 3,
    title: "出包与交付",
    scenario: "方案已定，需要产出一份能直接导入平台的本体包 JSON，并在交付前做结构自检与语义自检。",
    outputs: "<标识>.ontology.json（format: ontology.bundle）+ 导入 / 校验 / 发布步骤与常见报错修法。",
    icon: "bundle",
  },
];

const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** 单个文件读进来的上限，防止有人往里塞一个巨型文件把接口拖死。 */
const MAX_FILE_BYTES = 512 * 1024;

export type SkillFile = {
  /** 相对技能目录的路径，用 `/` 分隔，例如 `SKILL.md`、`references/bundle-format.md`。 */
  path: string;
  bytes: number;
  /** 是不是技能入口。 */
  entry: boolean;
};

export type SkillDetail = SkillCatalogEntry & {
  /** front-matter 里的 description（可能比界面上的 scenario 更详细）。 */
  description: string;
  files: SkillFile[];
};

export function skillsRoot() {
  // 仓库根下的 skills/。容器里由 Dockerfile 从构建阶段的同一个目录拷过来。
  return path.join(process.cwd(), "skills");
}

export function isSkillId(value: string): boolean {
  return SKILL_ID_PATTERN.test(value) && SKILL_CATALOG.some((entry) => entry.id === value);
}

/**
 * 解析技能目录里的相对路径。
 *
 * 这里是**唯一**把用户输入拼进文件系统的入口，所以要挡住 `..`、绝对路径与反斜杠：
 * 解析结果必须仍旧落在该技能目录内。
 */
export function resolveSkillFile(skillId: string, relative: string): string | null {
  if (!isSkillId(skillId)) return null;
  const cleaned = relative.replace(/\\/g, "/").trim();
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("../") || cleaned.endsWith("/..") || cleaned === "..") return null;
  const base = path.join(skillsRoot(), skillId);
  const target = path.resolve(base, cleaned);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}

/** 技能入口的 front-matter（name / description）。解析本身在 @/lib/markdown —— 客户端展示时也要用同一份。 */
export function parseSkillFrontMatter(markdown: string): { name: string; description: string } {
  const { name, description } = parseFrontMatter(markdown);
  return { name, description };
}

async function listSkillFiles(skillId: string): Promise<SkillFile[]> {
  const base = path.join(skillsRoot(), skillId);
  const files: SkillFile[] = [];
  const walk = async (directory: string, prefix: string) => {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      const absolute = path.join(directory, entry);
      const info = await stat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) { await walk(absolute, `${prefix}${entry}/`); continue; }
      files.push({ path: `${prefix}${entry}`, bytes: info.size, entry: prefix === "" && entry === "SKILL.md" });
    }
  };
  await walk(base, "");
  return files;
}

/** 技能清单（含文件列表）。技能目录不存在时返回空数组 —— 部署里没带目录不该让整页报错。 */
export async function listSkills(): Promise<SkillDetail[]> {
  const skills: SkillDetail[] = [];
  for (const entry of SKILL_CATALOG) {
    const files = await listSkillFiles(entry.id);
    if (!files.some((file) => file.entry)) continue;
    const markdown = await readFile(path.join(skillsRoot(), entry.id, "SKILL.md"), "utf8").catch(() => "");
    skills.push({ ...entry, description: parseSkillFrontMatter(markdown).description, files });
  }
  return skills;
}



export async function readSkillFile(skillId: string, relative: string): Promise<{ path: string; content: string } | null> {
  const target = resolveSkillFile(skillId, relative);
  if (!target) return null;
  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
  const content = await readFile(target, "utf8").catch(() => null);
  if (content === null) return null;
  return { path: relative.replace(/\\/g, "/"), content };
}

/**
 * 打包用：**全部技能**装进一个 zip（每条路径以技能名开头，解压出来就是三个可以直接安装的技能目录）。
 *
 * 只提供整体下载（2026-09-17 用户要求"不要支持一个一个下载，要只支持整体下载"）——
 * 别再加 `readSkillArchive(skillId)` 那种按套打包的口子。
 */
export async function readSkillsArchive(): Promise<{ path: string; content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const skill of await listSkills()) {
    for (const file of skill.files) {
      const read = await readSkillFile(skill.id, file.path);
      if (read) files.push({ path: `${skill.id}/${read.path}`, content: read.content });
    }
  }
  return files;
}