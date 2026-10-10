/**
 * 权限点与内置角色 —— 平台的授权模型（2026-10-09 RBAC）。
 *
 * 在这之前只有一列 `users.role`（`ADMIN` / `VIEWER`）加 70 处 `requireRole()`：能表达"是不是管理员"，
 * 表达不了"能改本体但不能碰数据资源"。现在按**模块 × 动作**划 13 个权限点，角色 = 一组权限点，
 * 守卫也从 `requireRole("ADMIN")` 换成 `requirePermission("ontology.publish")`。
 *
 * 三条口径，改之前先读：
 * 1. **权限点是代码里的常量**（下面 `PERMISSIONS`），不是库里可随便造的数据 —— 每个点都对应真实的守卫调用，
 *    库里造一个没人检查的点只是装饰。
 * 2. **粒度是模块级，不是接口级**：13 个点对 70 处守卫。刻意不按单个接口划（那会变成"每个端点一个权限"，
 *    配置的人根本读不懂）。真要更细，先想清楚界面怎么表达。
 * 3. **内置角色不可改不可删**（界面上只读，要改就复制一份自定义角色）。它们的权限集**由代码决定**，
 *    启动时按下面的定义同步进库 —— 所以以后新增权限点，`ADMIN` 会自动拿到，不用写数据迁移。
 */

/** 一个权限点：代码、分组（界面按它成块）、中文名、以及"它到底管什么"的一句话。 */
export type PermissionSpec = {
  code: string;
  group: string;
  label: string;
  detail: string;
};

/**
 * 权限点全表。**新增一个点必须同时有守卫在用它**，否则就是给人看的摆设。
 */
export const PERMISSIONS = [
  { code: "ontology.read", group: "本体模型", label: "查看本体与版本", detail: "对象类型、关系类型、接口、指标、版本记录与导出" },
  { code: "ontology.write", group: "本体模型", label: "编辑草稿", detail: "改草稿里的对象类型、关系类型、接口、指标、动作、规则、概念分组，以及绑定数据源" },
  { code: "ontology.publish", group: "本体模型", label: "校验与发布", detail: "校验、发布、激活历史版本、清空与重置图数据" },
  { code: "instance.read", group: "本体实例", label: "查看对象与关系", detail: "对象、关系、实例图谱与实例检索" },
  { code: "instance.write", group: "本体实例", label: "编辑对象与关系", detail: "增删改对象与关系、把业务库的对象取进草稿、对对象跑动作" },
  { code: "datasource.read", group: "数据资源", label: "查看数据资源", detail: "数据资源清单、库表与字段结构、连通性试连" },
  { code: "datasource.write", group: "数据资源", label: "管理数据资源", detail: "新增、修改、删除数据资源，刷新结构缓存" },
  { code: "target.read", group: "平台", label: "查看图引擎连接", detail: "图引擎连接清单与连通状态" },
  { code: "target.write", group: "平台", label: "管理图引擎连接", detail: "新增、修改、删除图引擎连接" },
  { code: "reasoning.use", group: "能力验证", label: "用智能问答与 MCP", detail: "智能问答、对话历史，以及 MCP 的只读查询工具" },
  { code: "mcp.token.manage", group: "能力验证", label: "管理 MCP 访问令牌", detail: "生成、查看、撤销外部客户端用的访问令牌" },
  { code: "audit.read", group: "平台", label: "查看审计记录", detail: "发布、动作决策与配置变更的审计流水" },
  { code: "users.manage", group: "平台", label: "管理用户与角色", detail: "建用户、改角色、重置密码、停用与删除；以及新建和编辑角色" },
] as const satisfies readonly PermissionSpec[];

export type Permission = (typeof PERMISSIONS)[number]["code"];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((item) => item.code);

const KNOWN = new Set<string>(ALL_PERMISSIONS);

/** 权限点分组，顺序就是界面上的顺序（跟左侧导航的分区一致）。 */
export const PERMISSION_GROUPS: string[] = [...new Set(PERMISSIONS.map((item) => item.group))];

export function permissionSpec(code: string): PermissionSpec | null {
  return PERMISSIONS.find((item) => item.code === code) ?? null;
}

/** 库里存的权限数组可能夹着已经不存在的点（改过代码）或重复项，读出来统一过滤。 */
export function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set(value.map((item) => String(item ?? "").trim()).filter((code) => KNOWN.has(code)));
  // 按 `PERMISSIONS` 的顺序返回：界面与 diff 都稳定，不随编辑顺序抖。
  return ALL_PERMISSIONS.filter((code) => unique.has(code));
}

/** 这个人有没有某个权限点。 */
export function can(permissions: readonly string[] | undefined, code: Permission): boolean {
  return Boolean(permissions?.includes(code));
}

/** 内置管理员的固定 id。 */
export const ADMIN_ROLE_ID = "admin";

/**
 * 一个角色**实际生效**的权限集。
 *
 * `admin` **永远是全部权限** —— 这里直接短路，不看库里那一行 jsonb。用户口径：
 * 「admin 用户是拥有所有权限的」。这样下面这几种情况都锁不死管理员：
 * 迁移没跑、库里那行被人手改坏、以后加了新权限点但还没同步。
 * 其它角色（内置的 editor / viewer 与自定义角色）按库里存的走，并过滤掉已经不存在的点。
 */
export function effectivePermissions(roleId: string, stored: unknown): Permission[] {
  if (roleId === ADMIN_ROLE_ID) return ALL_PERMISSIONS;
  return normalizePermissions(stored);
}

/** 内置角色的固定 id。自定义角色用 uuid，`isBuiltinRole` 靠这个集合区分。 */
export const BUILTIN_ROLE_IDS = ["admin", "editor", "viewer"] as const;

export function isBuiltinRole(id: string): boolean {
  return (BUILTIN_ROLE_IDS as readonly string[]).includes(id);
}

/**
 * 三档内置角色的权限集。**这里就是权威定义**：启动时同步进库（见迁移 0004），
 * 所以它们不需要也不允许在界面上改。
 *
 * - `管理员`：全权。
 * - `编辑者`：能建模、能发布、能管数据资源 —— 但碰不到用户与角色、MCP 访问令牌、图引擎连接。
 *   这是"干活的人"和"管平台的人"之间那条线。
 * - `查看者`：只读 + 问答。审计也看不到（跟这一版之前 ADMIN 之外什么都没有的边界一致）。
 */
export const BUILTIN_ROLES = [
  {
    id: "admin",
    name: "管理员",
    description: "平台全权：本体、数据资源、图引擎、用户与角色都在里面。",
    permissions: ALL_PERMISSIONS,
  },
  {
    id: "editor",
    name: "编辑者",
    description: "建模与发布、管数据资源与对象，但不碰用户、访问令牌和图引擎连接。",
    permissions: [
      "ontology.read",
      "ontology.write",
      "ontology.publish",
      "instance.read",
      "instance.write",
      "datasource.read",
      "datasource.write",
      "target.read",
      "reasoning.use",
    ] satisfies Permission[],
  },
  {
    id: "viewer",
    name: "查看者",
    description: "只读：看本体与对象、用智能问答查数，改不了任何东西。",
    permissions: [
      "ontology.read",
      "instance.read",
      "datasource.read",
      "target.read",
      "reasoning.use",
    ] satisfies Permission[],
  },
] as const;

/** 内置角色的定义（按 id 取）。 */
export function builtinRole(id: string) {
  return BUILTIN_ROLES.find((role) => role.id === id) ?? null;
}
