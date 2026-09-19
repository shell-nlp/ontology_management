import { randomUUID } from "node:crypto";
import { DataSourceEntity, PlatformSettingEntity, AuditEntryEntity, PlatformUserEntity, ensurePlatformSchema, jsonValue, platformRepo, repoIn, withAdvisoryLock, withPlatformTransaction } from "@/lib/db";
import { BUILTIN_EMBEDDED_TARGET_ID } from "@/lib/graph/types";

/**
 * 平台库（PostgreSQL）的数据访问。
 *
 * **这一层现在只负责"业务口径"，SQL 全部交给 TypeORM**（2026-09-19 用户要求：
 * "操作数据库一定要用 ORM，不能直接写 SQL"）。表结构在 `@/lib/db/migrations`，
 * 实体在 `@/lib/db/entities`，这里只做查询编排与领域类型转换。
 *
 * 换库 / 换存储实现时改的是 `@/lib/db` 里的 `type` 与那一处 advisory lock，
 * 本文件与所有调用点都不需要动。
 */

export type Role = "ADMIN" | "VIEWER";

export type PlatformUser = {
  id: string;
  email: string;
  role: Role;
  password_hash: string;
};

export { ensurePlatformSchema, withAdvisoryLock, withPlatformTransaction };

/** 按 id 取当前有效用户；找不到说明这个会话已经不该再用（换库、删用户、改权限）。 */
export async function findSessionUser(id: string): Promise<Pick<PlatformUser, "id" | "email" | "role"> | null> {
  const repo = await platformRepo(PlatformUserEntity);
  const user = await repo.findOne({ where: { id }, select: { id: true, email: true, role: true } });
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role as Role };
}

/** 按邮箱取账号（含密码哈希）：登录用。 */
export async function findUserByEmail(email: string): Promise<PlatformUser | null> {
  const repo = await platformRepo(PlatformUserEntity);
  const user = await repo.findOne({ where: { email: email.trim().toLowerCase() } });
  if (!user) return null;
  return { id: user.id, email: user.email, role: user.role as Role, password_hash: user.passwordHash };
}

/** 用户总数：首次启动引导用。 */
export async function countUsers(): Promise<number> {
  const repo = await platformRepo(PlatformUserEntity);
  return repo.count();
}

/** 建用户（引导流程与将来的用户管理都用它）。 */
export async function insertUser(input: { id?: string; email: string; passwordHash: string; role?: Role }) {
  const repo = await platformRepo(PlatformUserEntity);
  const id = input.id ?? randomUUID();
  await repo.insert({ id, email: input.email.trim().toLowerCase(), passwordHash: input.passwordHash, role: input.role ?? "ADMIN" });
  return id;
}

export async function writeAuditEntry(input: {
  actorId?: string;
  targetId?: string;
  action: string;
  details?: Record<string, unknown>;
}) {
  // 虚拟入口不在 graph_targets 中；审计表的 FK 只引用真实受管目标。
  const virtualTarget = input.targetId === BUILTIN_EMBEDDED_TARGET_ID;
  const details = virtualTarget ? { ...input.details, virtualTargetId: input.targetId } : (input.details ?? {});
  const versionId = typeof details.versionId === "string" ? details.versionId : null;
  const repo = await platformRepo(AuditEntryEntity);
  await repo.insert({
    id: randomUUID(),
    actorId: input.actorId ?? null,
    targetId: virtualTarget ? null : (input.targetId ?? null),
    action: input.action,
    versionId,
    details: jsonValue(details),
  });
}

export type AuditEntry = {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  targetId: string | null;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

/**
 * 读审计记录。动作的决策记录（干跑 / 执行 / 被拦截）也走这张表，
 * 因此按 action 前缀过滤就能同时服务"审计"和"决策记录"两个界面。
 *
 * 版本过滤走 `version_id` 这一列（写入时从 details 里提出来），不再在查询里拆 jsonb。
 */
export async function listAuditEntries(input: { targetId: string; actions?: string[]; versionId?: string; limit?: number }): Promise<AuditEntry[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const repo = await platformRepo(AuditEntryEntity);
  const query = repo.createQueryBuilder("a")
    .leftJoin(PlatformUserEntity, "u", "u.id = a.actorId")
    .select("a.id", "id")
    .addSelect("a.actor_id", "actorId")
    .addSelect("u.email", "actorEmail")
    .addSelect("a.target_id", "targetId")
    .addSelect("a.action", "action")
    .addSelect("a.details", "details")
    .addSelect("a.created_at", "createdAt")
    .where("a.target_id = :targetId", { targetId: input.targetId })
    .orderBy("a.created_at", "DESC")
    .limit(limit);
  if (input.actions?.length) query.andWhere("a.action IN (:...actions)", { actions: input.actions });
  if (input.versionId) query.andWhere("a.version_id = :versionId", { versionId: input.versionId });
  const rows = await query.getRawMany<{
    id: string;
    actorId: string | null;
    actorEmail: string | null;
    targetId: string | null;
    action: string;
    details: Record<string, unknown> | null;
    createdAt: Date | string;
  }>();
  return rows.map((row) => ({
    id: row.id,
    actorId: row.actorId,
    actorEmail: row.actorEmail,
    targetId: row.targetId,
    action: row.action,
    details: row.details ?? {},
    createdAt: new Date(row.createdAt).toISOString(),
  }));
}

/**
 * 平台级设置：一段 JSON 存在库里，按 key 取。
 *
 * 与「问答配置」的区别：那几个数是**浏览器本地**的偏好（一台机器一套），
 * 而工具开关要影响服务端 —— MCP 端点在外部客户端手里，模型看不到浏览器，
 * 所以这类"跟着部署走"的设置必须落在平台库上。
 */
export async function readPlatformSetting<T>(key: string): Promise<T | null> {
  const repo = await platformRepo(PlatformSettingEntity);
  const row = await repo.findOne({ where: { key } });
  return (row?.value as T) ?? null;
}

export async function writePlatformSetting<T>(key: string, value: T, updatedBy?: string): Promise<T> {
  const repo = await platformRepo(PlatformSettingEntity);
  // upsert：主键冲突时覆盖值与更新人，等价于原来的 ON CONFLICT DO UPDATE。
  await repo.upsert({ key, value: jsonValue(value), updatedBy: updatedBy ?? null, updatedAt: new Date() }, ["key"]);
  return value;
}

/**
 * 数据资源的**结构缓存**，落在 `data_sources.catalog` 这一列（用户要求复用这张表）。
 *
 * 两个桶：
 * - `catalog`：表 / 视图清单，按范围分片（登记的模式、或"*"=看全库）。
 * - `views`：某张表 / 视图的字段清单与样本行，按「模式.表@行数」分片。
 *
 * 只存，不判断新鲜度 —— "什么时候该回源库"由调用方决定（现在只有用户点刷新才回）。
 */
export type DataSourceCatalogEntry = { fetchedAt: string };
export type DataSourceCatalogCache = {
  catalog?: Record<string, DataSourceCatalogEntry & { objects?: unknown[] }>;
  views?: Record<string, DataSourceCatalogEntry & { fields?: unknown[]; preview?: unknown }>;
};

export async function readDataSourceCatalogCache(sourceId: string): Promise<DataSourceCatalogCache> {
  const repo = await platformRepo(DataSourceEntity);
  const row = await repo.findOne({ where: { id: sourceId }, select: { id: true, catalog: true } });
  const value = row?.catalog;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as DataSourceCatalogCache) : {};
}

/**
 * 合并写入：只覆盖这次给到的分片，别的分片原样留着。
 * 用 `FOR UPDATE` 锁住这一行再做读-改-写，效果与原来 SQL 里的 `||` 合并一致：
 * 并发写进来的另一张表不会被这次写覆盖掉。
 */
export async function writeDataSourceCatalogCache(
  sourceId: string,
  patch: { catalog?: NonNullable<DataSourceCatalogCache["catalog"]>; views?: NonNullable<DataSourceCatalogCache["views"]> },
): Promise<void> {
  await withPlatformTransaction(async (manager) => {
    const repo = repoIn(manager, DataSourceEntity);
    const row = await repo.findOne({ where: { id: sourceId }, lock: { mode: "pessimistic_write" } });
    if (!row) return;
    const current = row.catalog && typeof row.catalog === "object" && !Array.isArray(row.catalog) ? (row.catalog as DataSourceCatalogCache) : {};
    await repo.update({ id: sourceId }, {
      catalog: jsonValue({
        ...current,
        ...(patch.catalog ? { catalog: { ...(current.catalog ?? {}), ...patch.catalog } } : {}),
        ...(patch.views ? { views: { ...(current.views ?? {}), ...patch.views } } : {}),
      }),
    });
  });
}

/** 清掉一个数据资源的全部结构缓存（改连接信息时用：换了库还拿旧结构就是错的）。 */
export async function clearDataSourceCatalogCache(sourceId: string): Promise<void> {
  const repo = await platformRepo(DataSourceEntity);
  await repo.update({ id: sourceId }, { catalog: {} });
}
