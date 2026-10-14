import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, BUILTIN_ROLES, PERMISSIONS, builtinRole } from "@/lib/platform/permissions";
import { PUBLIC_API_PREFIXES } from "@/lib/platform/public-routes";

/**
 * 授权覆盖的**安全网**（2026-10-09 RBAC 起，2026-10-14 升到方法级）。
 *
 * 为什么必须有这一条：把 `requireRole("ADMIN"|"VIEWER")` 换成模块级权限点之后，
 * "漏改一处"的后果是**权限被放宽**（不是收紧）—— 新加一个路由忘了写守卫，界面看不出来、
 * 测试也不会红，只有攻击者会知道。
 *
 * **2026-10-14 起判据变了**：守卫从"每个 handler 手写 `requirePermission(...)`"改成
 * `route-guard.ts` 的包装器（`withPermission` / `withUser` / `withPublic` / `withOwnAuth`），
 * 所以这里不再扫文件里的字符串，而是**用 TS 语法树逐个导出方法看它被哪个包装器包着**：
 *
 * 1. 每个 `export const GET|POST|PUT|PATCH|DELETE` 都必须包在四个包装器之一里（**方法级**，
 *    以前只做到文件级 —— "文件里某个方法漏了"抓不住）；
 * 2. 不判权限点的那几个方法（公开端点 + 自带鉴权的 MCP）必须**恰好**等于下面的名单 ——
 *    想偷偷加一个公开接口，得先改这份名单，评审就看得见；
 * 3. `withPermission("...")` 里的权限点必须都在 `PERMISSIONS` 里（拼错当场红）。
 */
const API_DIR = path.join(process.cwd(), "src", "app", "api");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const GUARDS = ["withPermission", "withUser", "withPublic", "withOwnAuth"];

/**
 * 允许**不判权限点**的方法（写死在代码里，这里再钉一遍）。两种理由，别混：
 * - `withPublic`：按设计谁都能调（登录、登出、会话探测、首次初始化、OAuth 的两个匿名端点、
 *   免令牌的技能 MCP、授权同意页那个只读预览）；
 * - `withOwnAuth`：**自带鉴权** —— MCP 端点同一个 `Authorization` 头上认两套凭据
 *   （平台会话 JWT 与 MCP 访问令牌），走 `mcp-endpoint.ts` 的 `authorization()`。
 */
const PUBLIC_METHODS = [
  "src/app/api/auth/login/route.ts POST",
  "src/app/api/auth/logout/route.ts POST",
  "src/app/api/auth/session/route.ts GET",
  "src/app/api/bootstrap/route.ts POST",
  "src/app/api/oauth/authorize/route.ts GET",
  "src/app/api/oauth/register/route.ts POST",
  "src/app/api/oauth/token/route.ts POST",
  "src/app/api/skills/mcp/route.ts GET",
  "src/app/api/skills/mcp/route.ts POST",
  "src/app/api/mcp/route.ts GET",
  "src/app/api/mcp/route.ts POST",
  "src/app/api/mcp/[ontologyId]/route.ts GET",
  "src/app/api/mcp/[ontologyId]/route.ts POST",
  // CORS 预检：浏览器发 OPTIONS 时**不带 Authorization**，只能匿名
  "src/app/api/mcp/route.ts OPTIONS",
  "src/app/api/mcp/[ontologyId]/route.ts OPTIONS",
  "src/app/api/oauth/register/route.ts OPTIONS",
  "src/app/api/oauth/token/route.ts OPTIONS",
  "src/app/api/skills/mcp/route.ts OPTIONS",
];

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry === "route.ts") out.push(path.join("src", "app", "api", path.relative(API_DIR, full)).split(path.sep).join("/"));
  }
  return out;
}

type Scanned = { file: string; method: string; wrapper: string | null; code: string | null };

/** 逐个导出方法看它被哪个包装器包着；没包就是 null（违规）。 */
function scanRoutes(): Scanned[] {
  const found: Scanned[] = [];
  for (const file of routeFiles(API_DIR)) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    sf.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      const isExported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (!isExported) return;
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !HTTP_METHODS.includes(decl.name.text)) continue;
        const method = decl.name.text;
        const init = decl.initializer;
        if (!init || !ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || !GUARDS.includes(init.expression.text)) {
          found.push({ file, method, wrapper: null, code: null });
          continue;
        }
        const wrapper = init.expression.text;
        const first = init.arguments[0];
        found.push({ file, method, wrapper, code: wrapper === "withPermission" && first && ts.isStringLiteral(first) ? first.text : null });
      }
    });
    // 还在用 `export async function GET` 的（没包守卫）也算违规
    ts.forEachChild(sf, (node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name || !HTTP_METHODS.includes(node.name.text)) return;
      const isExported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (isExported) found.push({ file, method: node.name.text, wrapper: null, code: null });
    });
  }
  return found;
}

describe("授权覆盖", () => {
  const files = routeFiles(API_DIR);
  const scanned = scanRoutes();

  it("扫到了路由与方法（防止扫描逻辑自己坏掉）", () => {
    expect(files.length).toBeGreaterThan(40);
    expect(scanned.length).toBeGreaterThan(90);
  });

  it("每个路由方法都包在守卫里（方法级，不是文件级）", () => {
    const naked = scanned.filter((item) => item.wrapper === null).map((item) => `${item.file} ${item.method}`);
    expect(naked, `这些方法没有包守卫（应该用 withPermission / withUser / withPublic / withOwnAuth）：\n${naked.join("\n")}`).toEqual([]);
  });

  it("不判权限点的方法恰好等于公开名单（想加公开接口必须先改名单）", () => {
    const publicish = scanned
      .filter((item) => item.wrapper === "withPublic" || item.wrapper === "withOwnAuth")
      .map((item) => `${item.file} ${item.method}`)
      .sort();
    expect(publicish).toEqual([...PUBLIC_METHODS].sort());
  });

  it("withPermission 里用的都是真权限点，且不许再手写 requirePermission", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    const wrong: string[] = [];
    const handwritten: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      for (const match of source.matchAll(/withPermission\("([^"]+)"/g)) {
        if (!known.has(match[1])) wrong.push(`${match[1]}（${file}）`);
      }
      // 守卫收口之后，路由里不该再出现手写的 requirePermission / requireUser
      if (/requirePermission\(|requireUser\(/.test(source)) handwritten.push(file);
    }
    expect(wrong).toEqual([]);
    expect(handwritten, `这些路由还在手写守卫，应该改用 route-guard 的包装器：\n${handwritten.join("\n")}`).toEqual([]);
  });

  /*
   * 中间件（src/middleware.ts）只做"有没有带令牌"的粗筛，它按 PUBLIC_API_PREFIXES 放行。
   * 那份名单**漏一个**的后果是"公开接口被挡成 401"（真正的故障），所以这里逐个公开方法核对
   * —— 名单与代码不许漂移，这也是"一份名单两处用"能成立的前提。
   */
  it("middleware 的公开名单覆盖了每一个免鉴权路由", () => {
    const apiPathOf = (file: string) => {
      const rel = file.replace(/^src\/app/, "").replace(/\/route\.ts$/, "");
      return `/${rel.split("/").filter((seg) => seg && !seg.startsWith("[")).join("/")}`;
    };
    const missing = [...new Set(PUBLIC_METHODS.map((entry) => apiPathOf(entry.split(" ")[0])))]
      .filter((apiPath) => !PUBLIC_API_PREFIXES.some((prefix) => apiPath === prefix || apiPath.startsWith(`${prefix}/`)));
    expect(missing, `这些公开路由不在 middleware 的放行名单里，会被挡成 401：\n${missing.join("\n")}`).toEqual([]);
  });

  it("版本删除使用独立权限点", () => {
    const file = "src/app/api/ontology/[versionId]/route.ts";
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    const deleteBlock = source.slice(source.indexOf("export const DELETE"));
    expect(deleteBlock).toMatch(/withPermission\("ontology\.version\.delete"/);

    const resetFile = "src/app/api/targets/[targetId]/reset/route.ts";
    const resetSource = readFileSync(path.join(process.cwd(), resetFile), "utf8");
    expect(resetSource).toMatch(/withPermission\("ontology\.version\.delete"/);
  });

  it("内置角色的权限点也都是真权限点", () => {
    const known = new Set<string>(ALL_PERMISSIONS);
    for (const role of BUILTIN_ROLES) {
      for (const code of role.permissions) expect(known.has(code), `${role.id} 里的 ${code} 不存在`).toBe(true);
    }
  });

  it("三条边界：管理员全权、编辑者不能管用户 / 令牌 / 图引擎、查看者只读", () => {
    const all = new Set<string>(ALL_PERMISSIONS);
    const admin = new Set(builtinRole("admin")!.permissions);
    expect([...all].every((code) => admin.has(code))).toBe(true);

    const editor = new Set(builtinRole("editor")!.permissions);
    for (const forbidden of ["users.manage", "mcp.token.manage", "target.write"]) {
      expect(editor.has(forbidden), `编辑者不该有 ${forbidden}`).toBe(false);
    }
    expect(admin.has("ontology.version.delete")).toBe(true);
    expect(editor.has("ontology.version.delete")).toBe(false);
    expect(editor.has("ontology.publish")).toBe(true);
    expect(editor.has("datasource.write")).toBe(true);

    const viewer = new Set(builtinRole("viewer")!.permissions);
    for (const spec of PERMISSIONS) {
      const writeish = /\.(write|publish|manage|delete)$/.test(spec.code);
      if (writeish) expect(viewer.has(spec.code), `查看者不该有 ${spec.code}`).toBe(false);
    }
    expect(viewer.has("reasoning.use")).toBe(true);
  });
});
