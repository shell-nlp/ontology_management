import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 命令行导入脚本的"不联网"契约：用法说明与参数校验。
 *
 * 为什么要这一步：这个脚本是给人拿去导大文件的（一个 bkn 知识网络动辄几十个类型），
 * 语法写坏、用法提示消失、参数校验退化都不会被 tsc 抓到（它是 .mjs），
 * 所以像 `build-bundle.mjs` 那样真起一次进程来钉住：**只跑不需要账号与网络的那几条路径**。
 */
const root = process.cwd();
const script = () => path.join(root, "scripts", "import-ontology.mjs");
/** 清掉账号环境变量：本地开发机上真配了 ONTOLOGY_EMAIL 时，用例不能因此变成"要联网"。 */
const cleanEnv = { ...process.env, ONTOLOGY_EMAIL: "", ONTOLOGY_PASSWORD: "", ONTOLOGY_COOKIE: "" };

describe("scripts/import-ontology.mjs", () => {
  it("--help：打用法、退出码 0", () => {
    const run = spawnSync(process.execPath, [script(), "--help"], { encoding: "utf8", env: cleanEnv });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("node scripts/import-ontology.mjs <文件.json>");
    for (const flag of ["--dry-run", "--publish", "--storage-target", "--cookie"]) {
      expect(run.stdout, `用法里少了 ${flag}`).toContain(flag);
    }
  });

  it("不给参数：说清用法并退出码 2", () => {
    const run = spawnSync(process.execPath, [script()], { encoding: "utf8", env: cleanEnv });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("用法不对");
  });

  it("只给文件、没给账号：在联网之前就挡下来（退出码 2）", () => {
    const run = spawnSync(process.execPath, [script(), "随便哪个.json"], { encoding: "utf8", env: cleanEnv });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("要能登录");
  });
});
