import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateInterfaceImplementations, validateInterfaces } from "@/lib/interfaces";
import { planBundleImport, readOntologyBundle } from "@/lib/ontology-bundle";
import { isSkillId, listSkills, parseSkillFrontMatter, readSkillFile, readSkillsArchive, resolveSkillFile, SKILL_CATALOG } from "@/lib/skills";
import { validateVersionSnapshot } from "@/lib/version-snapshot";

const root = process.cwd();

async function exampleBundle() {
  const raw = JSON.parse(await readFile(path.join(root, "skills", "ontology-bundle", "references", "example.bundle.json"), "utf8"));
  return readOntologyBundle(raw);
}

describe("本体技能目录", () => {
  it("三套技能都在，入口文件带 front-matter 且名字与目录一致", async () => {
    const skills = await listSkills();
    expect(skills.map((skill) => skill.id)).toEqual(SKILL_CATALOG.map((entry) => entry.id));
    expect(skills).toHaveLength(3);
    for (const skill of skills) {
      const entry = skill.files.find((file) => file.entry);
      expect(entry, `${skill.id} 缺 SKILL.md`).toBeTruthy();
      const markdown = await readSkillFile(skill.id, "SKILL.md");
      const front = parseSkillFrontMatter(markdown!.content);
      expect(front.name).toBe(skill.id);
      expect(front.description.length).toBeGreaterThan(20);
      expect(skill.description.length).toBeGreaterThan(20);
      // SKILL.md 里点名的参考文件必须真的存在（防止改了文件名忘了改正文）。
      const referenced = [...markdown!.content.matchAll(/`(references\/[^`]+)`/g)].map((match) => match[1]);
      for (const file of referenced) {
        expect(skill.files.map((item) => item.path), `${skill.id} 引用了不存在的 ${file}`).toContain(file);
      }
    }
  });

  it("技能里写清了产物格式与导入路径（防止文档漂移）", async () => {
    const bundleSkill = await readSkillFile("ontology-bundle", "SKILL.md");
    expect(bundleSkill!.content).toContain("ontology.bundle");
    expect(bundleSkill!.content).toContain("导入本体包");
    const format = await readSkillFile("ontology-bundle", "references/bundle-format.md");
    // 字段名与枚举是契约的一部分：改了定义就要改文档，这里挡住"只改代码不改文档"。
    for (const token of ["entityTypes", "relationshipTypes", "interfaces", "actionTypes", "rules", "formatVersion", "scopeEntityTypeId", "dataType"]) {
      expect(format!.content, `bundle-format.md 少了 ${token}`).toContain(token);
    }
    expect(format!.content).toContain("TEXT_ARRAY");
    expect(format!.content).toContain("BLOCK");
  });

  it("文件路径不能跑出技能目录", async () => {
    expect(isSkillId("ontology-bundle")).toBe(true);
    expect(isSkillId("../../etc")).toBe(false);
    expect(resolveSkillFile("ontology-bundle", "../../package.json")).toBeNull();
    expect(resolveSkillFile("ontology-bundle", "/etc/passwd")).toBeNull();
    expect(resolveSkillFile("ontology-bundle", "SKILL.md")).not.toBeNull();
    expect(await readSkillFile("ontology-bundle", "../README.md")).toBeNull();
    expect(await readSkillFile("ontology-bundle", "does-not-exist.md")).toBeNull();
  });

  it("整体打包：三套技能都在一个 zip 里，每条路径以技能名开头（解压即可安装）", async () => {
    const files = await readSkillsArchive();
    const roots = [...new Set(files.map((file) => file.path.split("/")[0]))].sort();
    expect(roots).toEqual(SKILL_CATALOG.map((entry) => entry.id).sort());
    for (const entry of SKILL_CATALOG) {
      expect(files.some((file) => file.path === `${entry.id}/SKILL.md`), `${entry.id} 缺 SKILL.md`).toBe(true);
    }
  });
});

describe("技能自带的示例本体包", () => {
  it("能被平台解析、导入，且通过发布前校验（结构与语义都干净）", async () => {
    const bundle = await exampleBundle();
    expect(bundle.format).toBe("ontology.bundle");
    expect(bundle.formatVersion).toBe(1);

    // 导入：id 重发 + 数据资源按坐标匹配（本机没有登记，于是留空并给一条提醒）。
    const plan = planBundleImport(bundle, []);
    expect(plan.definition.entityTypes).toHaveLength(4);
    expect(plan.definition.relationshipTypes).toHaveLength(5);
    expect(plan.definition.interfaces).toHaveLength(1);
    expect(plan.definition.actionTypes).toHaveLength(1);
    expect(plan.definition.rules).toHaveLength(1);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("在本机没有登记");

    // 示例必须"零违规"：连 WARN 都不应该有，否则它就不配当范例。
    const violations = validateVersionSnapshot({ definition: plan.definition, nodes: [], relationships: [] });
    expect(violations).toEqual([]);
  });

  it("示例里的接口实现是满足契约的（同名属性 + 方向正确的必填关系）", async () => {
    const bundle = await exampleBundle();
    expect(validateInterfaces(bundle.definition)).toEqual([]);
    expect(validateInterfaceImplementations(bundle.definition)).toEqual([]);
    const implementers = bundle.definition.entityTypes.filter((type) => type.implements.length > 0);
    expect(implementers.map((type) => type.name).sort()).toEqual(["专线产品用户", "固话用户"]);
  });
});