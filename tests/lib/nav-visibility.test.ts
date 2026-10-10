import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS } from "@/lib/platform/permissions";

/**
 * 左侧导航的可见性安全网（2026-10-10）。
 *
 * 背景：角色以前只管得住接口，管不住界面 —— 一个没有 `instance.read` 的角色照样看得见
 * 「实例图谱 / 对象 / 关系」，点进去才吃 403。现在 `NAV_SECTIONS` 每一项都带一个权限点，
 * 渲染前按它过滤（见 `functional-workbench.tsx` 的 `mayEnterView` / 导航渲染）。
 *
 * 这条测试守的是**加视图时别忘标权限**：视图清单与权限点都是从源码里扫出来的，
 * 新增一个 View 却没在 NAV_SECTIONS 里登记（或者写了个不存在的权限点）当场红。
 * 和 `authz-coverage.test.ts` 一个路子：扫源码，不做 AST。
 */
/**
 * 2026-10-10：工作台按模块拆了文件 —— `type View` 搬去了 `workbench/shared.tsx`，
 * `NAV_SECTIONS` 留在 `functional-workbench.tsx`。两份拼起来一起扫，测试的口径不变。
 */
const SOURCES = [
  path.join(process.cwd(), "src", "components", "functional-workbench.tsx"),
  path.join(process.cwd(), "src", "components", "workbench", "shared.tsx"),
];

function sourceText() {
  return SOURCES.map((file) => readFileSync(file, "utf8")).join("\n");
}

/** `type View = "overview" | ...` 里的全部视图 id。 */
function declaredViews(text: string): string[] {
  const line = text.split("\n").find((item) => /^(export )?type View = /.test(item));
  if (!line) throw new Error("找不到 View 类型定义");
  return [...line.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
}

/** NAV_SECTIONS 里的 `["view", "标签", Icon, 权限点 | null]`。 */
function navEntries(text: string) {
  return [...text.matchAll(/\["([a-z]+)", "[^"]+", \w+, (null|"[^"]+")\]/g)]
    .map((match) => ({ view: match[1], permission: match[2] === "null" ? null : match[2].slice(1, -1) }));
}

describe("左侧导航可见性", () => {
  it("扫到了导航与视图（防止扫描逻辑自己坏掉）", () => {
    const entries = navEntries(sourceText());
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(declaredViews(sourceText()).length).toBeGreaterThanOrEqual(12);
  });

  it("每个视图都登记了权限点（null 表示所有登录用户可见）", () => {
    const text = sourceText();
    const declared = declaredViews(text);
    const registered = navEntries(text).map((entry) => entry.view);
    expect([...declared].sort()).toEqual([...registered].sort());
  });

  it("导航里的权限点都是真权限点（拼错就红）", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    const unknown = navEntries(sourceText()).filter((entry) => entry.permission !== null && !known.has(entry.permission));
    expect(unknown.map((entry) => `${entry.view} → ${entry.permission}`)).toEqual([]);
  });

  it("每个视图只登记一次", () => {
    const registered = navEntries(sourceText()).map((entry) => entry.view);
    expect(new Set(registered).size).toBe(registered.length);
  });
});
