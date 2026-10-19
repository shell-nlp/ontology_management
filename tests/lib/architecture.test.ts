import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const libRoot = path.join(repoRoot, "src", "lib");

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const imports = [...text.matchAll(/(?:from\s+|import\s*\()["']([^"']+)["']/g)].map((match) => match[1]);
  return [...new Set(imports)];
}

function violations(predicate: (relativePath: string, specifier: string) => boolean) {
  return sourceFiles(libRoot).flatMap((file) => {
    const relative = path.relative(repoRoot, file).replaceAll("\\", "/");
    return importsOf(file)
      .filter((specifier) => predicate(relative, specifier))
      .map((specifier) => `${relative} -> ${specifier}`);
  });
}

describe("src/lib 依赖边界", () => {
  it("shared 只依赖自身和第三方包，不反向引用业务模块", () => {
    const found = violations((file, specifier) =>
      file.startsWith("src/lib/shared/")
      && specifier.startsWith("@/lib/")
      && !specifier.startsWith("@/lib/shared/"),
    );
    expect(found).toEqual([]);
  });

  it("query-dsl 不认识具体对象索引实现", () => {
    const found = violations((file, specifier) =>
      file.startsWith("src/lib/query-dsl/") && specifier.startsWith("@/lib/infrastructure/"),
    );
    expect(found).toEqual([]);
  });

  it("infrastructure 不反向依赖 instance、platform 或上层应用模块", () => {
    const forbidden = ["instance", "platform", "versioning", "reasoning", "mcp", "oauth", "skills"];
    const found = violations((file, specifier) =>
      file.startsWith("src/lib/infrastructure/")
      && forbidden.some((name) => specifier.startsWith(`@/lib/${name}`)),
    );
    expect(found).toEqual([]);
  });

  it("具体图库和对象索引实现只能由适配层与契约测试直接引用", () => {
    const found = violations((file, specifier) => {
      if (file.startsWith("src/lib/infrastructure/")) return false;
      return specifier.startsWith("@/lib/infrastructure/graph/jena")
        || (specifier.startsWith("@/lib/infrastructure/graph/embedded")
          && !specifier.endsWith("/embedded/repository"))
        || specifier.startsWith("@/lib/infrastructure/object-index/clickhouse");
    });
    expect(found).toEqual([]);
  });

  it("旧的 framework 目录不再被引用", () => {
    const found = violations((_, specifier) => specifier.includes("/lib/framework"));
    expect(found).toEqual([]);
  });

  it("顶层 lib 模块之间不存在双向依赖", () => {
    const edges = new Map<string, Set<string>>();
    for (const file of sourceFiles(libRoot)) {
      const relative = path.relative(libRoot, file).replaceAll("\\", "/");
      const from = relative.split("/")[0];
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith("@/lib/")) continue;
        const to = specifier.slice("@/lib/".length).split("/")[0];
        if (!to || to === from) continue;
        const targets = edges.get(from) ?? new Set<string>();
        targets.add(to);
        edges.set(from, targets);
      }
    }
    const found = [...edges].flatMap(([from, targets]) => [...targets]
      .filter((to) => edges.get(to)?.has(from))
      .map((to) => `${from} ⇄ ${to}`));
    expect([...new Set(found)].sort()).toEqual([]);
  });
});
