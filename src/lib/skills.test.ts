import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateInterfaceImplementations, validateInterfaces } from "@/lib/interfaces";
import { planBundleImport, readOntologyBundle } from "@/lib/ontology-bundle";
import { DUPLICATE_NAME_CODES } from "@/lib/modeling-review";
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
      // 正文里点名的 `references/…` 与 `scripts/…` 都必须真的存在（防止改了文件名忘了改正文）。
      const referenced = [...markdown!.content.matchAll(/`((?:references|scripts)\/[^`]+)`/g)].map((match) => match[1]);
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

  it("建模体检的规则码与技能文档同步（加了规则就得补文档）", async () => {
    // 规则码是稳定标识，技能文档要照着它自查。这里直接读引擎源码抽码 ——
    // 断言"引擎里有的，文档里都得有"，免得加完规则忘了改文档（之前就漏过两个）。
    const source = await readFile(path.join(root, "src", "lib", "modeling-review.ts"), "utf8");
    const literals = [...source.matchAll(/finding\(\s*"([A-Z][A-Z0-9_]{4,})",\s*"(?:WARN|INFO)"/g)].map((match) => match[1]);
    const engineCodes = [...new Set([...literals, ...Object.values(DUPLICATE_NAME_CODES)])];
    expect(engineCodes.length).toBeGreaterThan(20);
    const rules = await readSkillFile("ontology-builder", "references/modeling-rules.md");
    for (const code of engineCodes) {
      expect(rules!.content, `modeling-rules.md 少了规则码 ${code}`).toContain(code);
    }
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
    // 编译脚本必须随整包下发：技能是自包含的，少一个文件对方就编译不了清单。
    expect(files.some((file) => file.path === "ontology-bundle/scripts/build-bundle.mjs"), "整包里缺编译脚本").toBe(true);
    expect(files.some((file) => file.path === "ontology-bundle/scripts/check-bundle.mjs"), "整包里缺结构自检脚本").toBe(true);
  });
});

describe("清单 → 本体包的编译脚本", () => {
  // 走真脚本、真子进程：Windows / Linux / macOS 都是 `process.execPath` + 脚本路径，不经过 shell。
  const script = () => path.join(root, "skills", "ontology-bundle", "scripts", "build-bundle.mjs");
  const blueprint = () => path.join(root, "skills", "ontology-bundle", "references", "example.blueprint.json");
  const tempFile = (name: string) => path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.json`);

  it("把示例清单编译成平台可导入的包，且和手写示例一样零违规", async () => {
    const out = tempFile("ontology-blueprint");
    try {
      const run = spawnSync(process.execPath, [script(), blueprint(), "--out", out], { encoding: "utf8" });
      expect(run.status, run.stderr || run.stdout).toBe(0);
      // 编译器自己不该报体检提醒：示例清单是「规矩」的样板。
      expect(run.stdout).not.toContain("⚠");

      const bundle = readOntologyBundle(JSON.parse(await readFile(out, "utf8")));
      expect(bundle.format).toBe("ontology.bundle");
      expect(bundle.formatVersion).toBe(1);
      expect(bundle.ontology.identifier).toBe("telecom-line-service-demo");

      // 和手写示例同一条链路：解析 → 导入（重发 id）→ 发布前校验，必须零违规。
      const plan = planBundleImport(bundle, []);
      expect(plan.definition.entityTypes).toHaveLength(4);
      expect(plan.definition.relationshipTypes).toHaveLength(5);
      expect(plan.definition.interfaces).toHaveLength(1);
      expect(plan.definition.actionTypes).toHaveLength(1);
      expect(plan.definition.rules).toHaveLength(1);
      expect(validateVersionSnapshot({ definition: plan.definition, nodes: [], relationships: [] })).toEqual([]);
      // 接口实现也要满足契约：编译出来的包不能只是「结构合法」。
      expect(validateInterfaces(plan.definition)).toEqual([]);
      expect(validateInterfaceImplementations(plan.definition)).toEqual([]);
    } finally {
      await rm(out, { force: true });
    }
  });

  it("引用解析不了时报错退出，并把可选的名字列出来", async () => {
    const file = tempFile("ontology-blueprint-broken");
    const broken = {
      format: "ontology.blueprint",
      formatVersion: 1,
      ontology: { name: "坏清单" },
      objectTypes: [{ name: "客户", properties: [{ name: "CUST_ID", dataType: "TEXT" }] }],
      relationTypes: [{ name: "拥有", source: "客户", target: "不存在的类型" }],
    };
    try {
      await writeFile(file, JSON.stringify(broken), "utf8");
      const run = spawnSync(process.execPath, [script(), file, "--check"], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("指向了不存在的对象类型「不存在的类型」");
      expect(run.stderr).toContain("当前清单里有：客户");
    } finally {
      await rm(file, { force: true });
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