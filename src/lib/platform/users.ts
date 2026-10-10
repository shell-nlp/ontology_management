import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { platformRepo } from "@/lib/platform/db";
import { PlatformUserEntity, RoleEntity } from "@/lib/platform/db/entities";
import { can, effectivePermissions, isBuiltinRole, normalizePermissions, type Permission } from "@/lib/platform/permissions";

/**
 * 用户与角色的领域逻辑（RBAC 的数据面）。
 *
 * 路由只做"校验入参 + 调这里 + 写审计"，规则都收在这一层，因为有几条**不能靠界面记**：
 *
 * - **内置角色不可改不可删**：管理员 / 编辑者 / 查看者的权限集由 `@/lib/permissions` 决定，
 *   启动时同步进库（迁移 0004）。要定制就复制一份自定义角色。
 * - **不能把最后一个"能管用户"的账号降级 / 停用 / 删掉** —— 否则平台当场锁死，谁也进不来配权限。
 * - 删除用户是**真删**（用户明确要求）。指向 users 的 4 条外键是 `ON DELETE SET NULL`，
 *   所以他历史上的审计记录会保留、只是"操作人"变空；路由那边会单独写一条 `USER_DELETED`
 *   审计把邮箱记下来，人名还能从那条追。
 */

export const ROLE_NAME_MAX = 30;
/** 平台**不校验密码强度**（用户明确要求），只挡空密码；界面会提示自行用足够长的密码。 */
export const MIN_PASSWORD_MESSAGE = "密码不能为空。";

export type RoleRecord = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  permissions: Permission[];
  /** 有多少账号在用这个角色（删角色前要先看它）。 */
  userCount: number;
};

export type UserRecord = {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  disabled: boolean;
  createdAt: string;
};

export type RoleInput = { name: string; description?: string; permissions?: unknown };

function normalizeRoleName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  if (!text) throw new Error("角色名称不能为空。");
  if (text.length > ROLE_NAME_MAX) throw new Error(`角色名称最多 ${ROLE_NAME_MAX} 个字。`);
  return text;
}

function normalizeEmail(email: unknown): string {
  const text = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new Error("邮箱格式不对。");
  return text;
}

function normalizePassword(password: unknown): string {
  const text = typeof password === "string" ? password : "";
  if (!text.trim()) throw new Error(MIN_PASSWORD_MESSAGE);
  return text;
}

/** 角色清单（带每个角色有多少人，界面要显示"不可删：还有 2 个账号在用"）。 */
export async function listRoles(): Promise<RoleRecord[]> {
  const [roleRepo, userRepo] = await Promise.all([platformRepo(RoleEntity), platformRepo(PlatformUserEntity)]);
  const [roles, users] = await Promise.all([roleRepo.find(), userRepo.find()]);
  const counts = new Map<string, number>();
  for (const user of users) counts.set(user.roleId, (counts.get(user.roleId) ?? 0) + 1);
  // 内置三档排前面，其余按名字；界面读起来稳定。
  const order = (role: RoleEntity) => (role.builtin ? 0 : 1);
  return roles
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name, "zh-CN"))
    .map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      builtin: role.builtin,
      permissions: effectivePermissions(role.id, role.permissions),
      userCount: counts.get(role.id) ?? 0,
    }));
}

export async function findRoleRecord(id: string): Promise<RoleRecord | null> {
  const repo = await platformRepo(RoleEntity);
  const role = await repo.findOne({ where: { id } });
  if (!role) return null;
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    builtin: role.builtin,
    permissions: effectivePermissions(role.id, role.permissions),
    userCount: 0,
  };
}

/** 角色名唯一（内置角色的名字也占位，避免自定义角色跟"管理员"重名造成误解）。 */
async function assertRoleNameFree(name: string, exceptId?: string) {
  const repo = await platformRepo(RoleEntity);
  const existing = await repo.findOne({ where: { name } });
  if (existing && existing.id !== exceptId) throw new Error(`已经有一个叫「${name}」的角色了。`);
}

export async function createRole(input: RoleInput): Promise<RoleRecord> {
  const name = normalizeRoleName(input.name);
  await assertRoleNameFree(name);
  const repo = await platformRepo(RoleEntity);
  const id = randomUUID();
  const now = new Date();
  const permissions = normalizePermissions(input.permissions);
  await repo.insert({
    id,
    name,
    description: (input.description ?? "").trim(),
    builtin: false,
    permissions,
    createdAt: now,
    updatedAt: now,
  });
  return { id, name, description: (input.description ?? "").trim(), builtin: false, permissions, userCount: 0 };
}

export async function updateRole(id: string, input: RoleInput): Promise<RoleRecord> {
  const repo = await platformRepo(RoleEntity);
  const role = await repo.findOne({ where: { id } });
  if (!role) throw new Error("这个角色不存在，可能已经被删掉了。");
  if (isBuiltinRole(id)) throw new Error(`「${role.name}」是内置角色，权限集由平台决定，不能改；要定制就复制一份自定义角色。`);
  const name = normalizeRoleName(input.name);
  await assertRoleNameFree(name, id);
  const description = (input.description ?? "").trim();
  const permissions = normalizePermissions(input.permissions);
  await repo.update({ id }, { name, description, permissions, updatedAt: new Date() });
  const users = await (await platformRepo(PlatformUserEntity)).count({ where: { roleId: id } });
  return { id, name, description, builtin: false, permissions, userCount: users };
}

/** 删角色。**还挂着人就不许删** —— 否则那些人会掉进"没有角色的账号"这种没法解释的状态。 */
export async function deleteRole(id: string): Promise<RoleRecord> {
  const repo = await platformRepo(RoleEntity);
  const role = await repo.findOne({ where: { id } });
  if (!role) throw new Error("这个角色不存在，可能已经被删掉了。");
  if (isBuiltinRole(id)) throw new Error(`「${role.name}」是内置角色，不能删。`);
  const users = await (await platformRepo(PlatformUserEntity)).count({ where: { roleId: id } });
  if (users > 0) throw new Error(`还有 ${users} 个账号在用「${role.name}」，先把他们换成别的角色再删。`);
  await repo.delete({ id });
  return { id, name: role.name, description: role.description, builtin: false, permissions: effectivePermissions(role.id, role.permissions), userCount: 0 };
}

async function decorate(users: PlatformUserEntity[], roles: RoleEntity[]): Promise<UserRecord[]> {
  const names = new Map(roles.map((role) => [role.id, role.name]));
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    roleId: user.roleId,
    roleName: names.get(user.roleId) ?? "（角色已删）",
    disabled: Boolean(user.disabledAt),
    createdAt: user.createdAt.toISOString(),
  }));
}

export async function listUsers(): Promise<UserRecord[]> {
  const [userRepo, roleRepo] = await Promise.all([platformRepo(PlatformUserEntity), platformRepo(RoleEntity)]);
  const [users, roles] = await Promise.all([userRepo.find({ order: { email: "ASC" } }), roleRepo.find()]);
  return decorate(users, roles);
}

/**
 * 还有几个**能管用户**的启用账号（可以排除某个人，用于"改他的角色之前先看看剩下几个"）。
 * 这是那条锁死保护的唯一依据：结果不能为 0。
 */
export async function countActiveManagers(exceptUserId?: string): Promise<number> {
  const [userRepo, roleRepo] = await Promise.all([platformRepo(PlatformUserEntity), platformRepo(RoleEntity)]);
  const [users, roles] = await Promise.all([userRepo.find(), roleRepo.find()]);
  const managerRoles = new Set(roles.filter((role) => can(effectivePermissions(role.id, role.permissions), "users.manage")).map((role) => role.id));
  return users.filter((user) => !user.disabledAt && user.id !== exceptUserId && managerRoles.has(user.roleId)).length;
}

export async function createUser(input: { email: unknown; password: unknown; roleId: unknown }): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const password = normalizePassword(input.password);
  const roleId = typeof input.roleId === "string" ? input.roleId.trim() : "";
  const role = await findRoleRecord(roleId);
  if (!role) throw new Error("要选一个存在的角色。");
  const repo = await platformRepo(PlatformUserEntity);
  if (await repo.findOne({ where: { email } })) throw new Error(`已经有一个账号用 ${email} 了。`);
  const id = randomUUID();
  const now = new Date();
  await repo.insert({ id, email, passwordHash: await bcrypt.hash(password, 12), roleId, disabledAt: null, createdAt: now });
  return { id, email, roleId, roleName: role.name, disabled: false, createdAt: now.toISOString() };
}

/**
 * 改用户：角色 / 密码 / 停用，三样都可选。
 *
 * 改角色或停用前先看"还剩几个能管用户的启用账号"——**不能把最后一个弄没**，
 * 那也是平台当场锁死。改密码不涉及这条。
 */
export async function updateUser(id: string, input: { roleId?: unknown; password?: unknown; disabled?: unknown }): Promise<UserRecord> {
  const [userRepo, roleRepo] = await Promise.all([platformRepo(PlatformUserEntity), platformRepo(RoleEntity)]);
  const user = await userRepo.findOne({ where: { id } });
  if (!user) throw new Error("这个账号不存在，可能已经被删掉了。");

  const patch: Partial<PlatformUserEntity> = {};
  let roleName = (await roleRepo.findOne({ where: { id: user.roleId } }))?.name ?? "（角色已删）";

  if (input.roleId !== undefined) {
    const roleId = String(input.roleId).trim();
    const role = await roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw new Error("要选一个存在的角色。");
    if (roleId !== user.roleId) {
      const stillManager = can(effectivePermissions(role.id, role.permissions), "users.manage");
      if (!stillManager && !user.disabledAt && (await countActiveManagers(id)) === 0) {
        throw new Error("这是最后一个能管用户的账号，不能把它换成没有「管理用户与角色」权限的角色。");
      }
    }
    patch.roleId = roleId;
    roleName = role.name;
  }

  if (input.disabled !== undefined) {
    const disabled = Boolean(input.disabled);
    if (disabled && !user.disabledAt && (await countActiveManagers(id)) === 0) {
      throw new Error("这是最后一个能管用户的账号，停用之后就没人能进后台配权限了。");
    }
    patch.disabledAt = disabled ? new Date() : null;
  }

  if (input.password !== undefined) {
    patch.passwordHash = await bcrypt.hash(normalizePassword(input.password), 12);
  }

  if (Object.keys(patch).length) await userRepo.update({ id }, patch);
  return {
    id: user.id,
    email: user.email,
    roleId: patch.roleId ?? user.roleId,
    roleName,
    disabled: patch.disabledAt !== undefined ? Boolean(patch.disabledAt) : Boolean(user.disabledAt),
    createdAt: user.createdAt.toISOString(),
  };
}

/** 真删（用户明确要求要能删）。返回被删的那条，路由用它写 `USER_DELETED` 审计。 */
export async function deleteUser(id: string): Promise<UserRecord> {
  const [userRepo, roleRepo] = await Promise.all([platformRepo(PlatformUserEntity), platformRepo(RoleEntity)]);
  const user = await userRepo.findOne({ where: { id } });
  if (!user) throw new Error("这个账号不存在，可能已经被删掉了。");
  if (!user.disabledAt && (await countActiveManagers(id)) === 0) {
    throw new Error("这是最后一个能管用户的账号，删掉之后就没人能进后台配权限了。");
  }
  const roleName = (await roleRepo.findOne({ where: { id: user.roleId } }))?.name ?? "（角色已删）";
  await userRepo.delete({ id });
  return {
    id: user.id,
    email: user.email,
    roleId: user.roleId,
    roleName,
    disabled: Boolean(user.disabledAt),
    createdAt: user.createdAt.toISOString(),
  };
}

/** 改自己的密码：任何登录用户都能改自己的（不占 `users.manage`）。 */
export async function changeOwnPassword(id: string, currentPassword: unknown, nextPassword: unknown): Promise<void> {
  const repo = await platformRepo(PlatformUserEntity);
  const user = await repo.findOne({ where: { id } });
  if (!user) throw new Error("账号不存在。");
  const current = typeof currentPassword === "string" ? currentPassword : "";
  if (!(await bcrypt.compare(current, user.passwordHash))) throw new Error("当前密码不正确。");
  await repo.update({ id }, { passwordHash: await bcrypt.hash(normalizePassword(nextPassword), 12) });
}