import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, BUILTIN_ROLES, PERMISSIONS, builtinRole } from "@/lib/platform/permissions";

/**
 * 授权覆盖的**安全网**（2026-10-09 RBAC）。
 *
 * 为什么必须有这一条：这次把 74 处 `requireRole("ADMIN"|"VIEWER")` 换成了 13 个权限点，
 * 而"漏改一处"的后果是**权限被放宽**（不是收紧）—— 新加一个路由、忘了写守卫，
 * 或者权限点拼错（写成 `ontolgy.read`），界面看不出来，测试也不会红，只有攻击者会知道。
 * 所以这里直接扫源码：
 *
 * 1. 每个非公开路由都必须声明 `requirePermission(...)` / `requireUser(...)`；
 * 2. 代码里出现的权限点必须都在 `PERMISSIONS` 里（拼错当场红）；
 * 3. 内置角色的权限点也必须都存在（改权限点时忘了改角色定义也当场红）。
 *
 * 它扫的是**文件级**：一个 route.ts 里有几个导出方法、每个方法有没有守卫，这里不做 AST 分析
 * —— 文件内每个方法都写守卫是评审要看的事；这一条的职责是"整个文件都漏了"这种最低级的情况。
 */
const API_DIR = path.join(process.cwd(), "src", "app", "api");

/** 不需要平台鉴权的路由：登录、登出、会话探测、首次初始化、免令牌的技能 MCP。 */
const PUBLIC_ROUTES = [
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/logout/route.ts",
  "src/app/api/auth/session/route.ts",
  "src/app/api/bootstrap/route.ts",
  "src/app/api/skills/mcp/route.ts",
];

/**
 * 自己实现鉴权的路由：MCP 端点同一个 `Authorization` 头上要认两套凭据（平台会话 JWT 与 MCP 访问令牌），
 * 走的是 `mcp-endpoint.ts` 的 authorization()，不是 requirePermission。别把这条豁免随便加宽。
 */
const SELF_GUARDED_ROUTES = ["src/app/api/mcp/route.ts", "src/app/api/mcp/[ontologyId]/route.ts"];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(path.join("src", "app", "api", path.relative(API_DIR, full)).split(path.sep).join("/"));
  }
  return out;
}

describe("授权覆盖", () => {
  const files = routeFiles(API_DIR);

  it("扫到了路由（防止扫描逻辑自己坏掉）", () => {
    expect(files.length).toBeGreaterThan(40);
    for (const route of PUBLIC_ROUTES) expect(files).toContain(route);
  });

  it("每个非公开路由都声明了守卫", () => {
    const unguarded = files
      .filter((file) => !PUBLIC_ROUTES.includes(file) && !SELF_GUARDED_ROUTES.includes(file))
      .filter((file) => {
        const source = readFileSync(path.join(process.cwd(), file), "utf8");
        return !/requirePermission\(|requireUser\(/.test(source);
      });
    expect(unguarded, `这些路由没有声明任何权限守卫：\n${unguarded.join("\n")}`).toEqual([]);
  });

  it("代码里用的权限点都是真权限点（拼错就红）", () => {
    const known = new Set(ALL_PERMISSIONS);
    const used = new Map<string, string>();
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      for (const match of source.matchAll(/requirePermission\("([^"]+)"\)/g)) {
        if (!known.has(match[1])) used.set(match[1], file);
      }
    }
    expect([...used.entries()].map(([code, file]) => `${code}（${file}）`)).toEqual([]);
  });

  it("内置角色的权限点也都是真权限点", () => {
    const known = new Set(ALL_PERMISSIONS);
    for (const role of BUILTIN_ROLES) {
      for (const code of role.permissions) expect(known.has(code), `${role.id} 里的 ${code} 不存在`).toBe(true);
    }
  });

  it("三条边界：管理员全权、编辑者不能管用户 / 令牌 / 图引擎、查看者只读", () => {
    const all = new Set(ALL_PERMISSIONS);
    const admin = new Set(builtinRole("admin")!.permissions);
    expect([...all].every((code) => admin.has(code))).toBe(true);

    const editor = new Set(builtinRole("editor")!.permissions);
    for (const forbidden of ["users.manage", "mcp.token.manage", "target.write"]) {
      expect(editor.has(forbidden), `编辑者不该有 ${forbidden}`).toBe(false);
    }
    expect(editor.has("ontology.publish")).toBe(true);
    expect(editor.has("datasource.write")).toBe(true);

    const viewer = new Set(builtinRole("viewer")!.permissions);
    for (const spec of PERMISSIONS) {
      const writeish = /\.(write|publish|manage)$/.test(spec.code);
      if (writeish) expect(viewer.has(spec.code), `查看者不该有 ${spec.code}`).toBe(false);
    }
    expect(viewer.has("reasoning.use")).toBe(true);
  });
});