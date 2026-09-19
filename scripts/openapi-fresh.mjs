/**
 * 接口文档（`public/openapi.json` + Swagger UI 静态资源）的**唯一生成入口**，
 * `pnpm openapi`、`pnpm dev`、`pnpm build` 都走这里；第二步是 `scripts/openapi-build.mjs`。
 *
 * 以前 `pnpm dev` 每次都先跑一遍完整生成：生成器加后处理 ~1s，还会把「TypeScript 版本偏低」
 * 和几十条诊断刷满屏。可这份产物只有**接口相关的东西**变了才会变 —— 改了组件、改了样式再重启
 * dev 时，这一秒是白花的。所以：
 *
 * - 不带参数（`pnpm dev`）：把会进产物的输入（`src/` 下全部 TS + 生成器配置 + 后处理脚本）算成
 *   一个哈希存进 `.data/openapi-fresh.json`，对得上就跳过；对不上（或产物被删了）才真的生成。
 * - `--force`（`pnpm openapi`、`pnpm build`）：无条件重新生成。
 *
 * 跳过判定故意**宁滥勿缺**：整个 `src/` 都进哈希 —— 多算一次只多花 1s，漏算才会让文档过期。
 *
 * 只用 Node 内置模块（和 `scripts/openapi-build.mjs` 一个路子：不装额外依赖、不联网）；
 * 两步都用 `process.execPath` 直接调 Node、不经过 shell，Windows / Linux / macOS 同一套。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const stampPath = path.join(root, ".data", "openapi-fresh.json");
const generatorBin = path.join(root, "node_modules", "next-openapi-gen", "bin", "cli.mjs");
const buildScript = path.join(root, "scripts", "openapi-build.mjs");

/** 除 src/ 之外还决定产物内容的文件。 */
const EXTRA_INPUTS = ["openapi-gen.config.ts", "scripts/openapi-build.mjs", "scripts/openapi-fresh.mjs", "package.json"];
/** 只要有一个不在，就不能凭哈希跳过。 */
const OUTPUTS = ["public/openapi.json", "public/swagger-ui/swagger-ui.css"];
/** 只看这几种扩展名，避免把图片、md 也算进哈希。 */
const INPUT_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".json"]);

const force = process.argv.includes("--force") || process.env.OPENAPI_FORCE === "1";

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (INPUT_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

/** 输入清单的哈希：路径也进哈希，改名 / 移动同样算变化。 */
function inputHash() {
  const files = [...walk(path.join(root, "src")), ...EXTRA_INPUTS.map((file) => path.join(root, file))]
    .filter((file) => existsSync(file))
    .map((file) => path.relative(root, file).split(path.sep).join("/"))
    .sort();
  const hash = createHash("sha1");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function generate() {
  if (!existsSync(generatorBin)) {
    console.error("[openapi] 找不到 next-openapi-gen 的入口，先 `pnpm install`（或手动 `pnpm exec openapi-gen generate`）。");
    process.exit(1);
  }
  execFileSync(process.execPath, [generatorBin, "generate"], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, [buildScript], { cwd: root, stdio: "inherit" });
}

const stamp = (() => {
  try {
    return JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return null;
  }
})();
const hash = inputHash();

if (!force && stamp?.hash === hash && OUTPUTS.every((file) => existsSync(path.join(root, file)))) {
  console.log("[openapi] 接口没变，跳过生成（改了 src 下任何文件会自动重生成；强制重生成用 pnpm openapi）");
  process.exit(0);
}

console.log(force ? "[openapi] --force：重新生成接口文档…" : "[openapi] 检测到接口相关文件有变化，重新生成…");
generate();

mkdirSync(path.dirname(stampPath), { recursive: true });
writeFileSync(stampPath, `${JSON.stringify({ hash, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
