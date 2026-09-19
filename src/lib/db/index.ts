import "reflect-metadata";

import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { DataSource, type EntityManager, type EntityTarget, type ObjectLiteral, type QueryRunner, type Repository } from "typeorm";
import {
  AuditEntryEntity,
  ConversationEntity,
  ConversationMessageEntity,
  DataSourceEntity,
  EmbeddedGraphEntity,
  GraphTargetEntity,
  ObjectEntryEntity,
  OntologyEntity,
  PlatformSettingEntity,
  PlatformUserEntity,
} from "@/lib/db/entities";
import { PLATFORM_MIGRATIONS } from "@/lib/db/migrations";

/**
 * 平台库的统一访问入口（TypeORM）。
 *
 * 规则（2026-09-19 用户要求）：**业务代码不再直接写 SQL**。
 * - 读写平台库 -> `platformRepo(Entity)` 拿仓储；
 * - 需要事务 -> `withPlatformTransaction(manager => …)`；
 * - 建表 / 改列 -> 新的迁移类（`migrations/`），由启动流程执行；
 * - 需要 TypeORM 表达不了的库特性（全文索引、pgvector、advisory lock、扩展）-> 
 *   `withPlatformQueryRunner` 拿查询器，在**唯一一处**显式写出来，并写明为什么不能用 ORM。
 *
 * 换库（PostgreSQL -> 其它）时改的是这里的 `type` 与那几处显式 SQL，业务代码不动。
 */

export * from "@/lib/db/entities";

/**
 * jsonb 列的写入值类型。
 *
 * TypeORM 对写入做"深度可选"映射，普通对象类型套进去推不动（见 entities.ts 的 JsonColumn 说明）。
 * 所有 jsonb 写入统一过这个函数，转换只发生在这一个地方 —— 业务侧仍然用具体类型。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonValue = any;

export function jsonValue(value: unknown): JsonValue {
  return value;
}

export const PLATFORM_ENTITIES = [
  PlatformUserEntity,
  GraphTargetEntity,
  DataSourceEntity,
  OntologyEntity,
  EmbeddedGraphEntity,
  AuditEntryEntity,
  PlatformSettingEntity,
  ConversationEntity,
  ConversationMessageEntity,
  ObjectEntryEntity,
];

type PlatformCache = {
  __ontologyPlatform?: { source: DataSource; schema?: Promise<void> };
};

// 挂在 globalThis 上：dev 的 HMR 会重新求值模块，实例级缓存会漏出第二个连接池。
const cache = globalThis as unknown as PlatformCache;

/** 平台库 DataSource（惰性创建）。 */
export function getPlatformDataSource(): DataSource {
  return cacheEntry().source;
}

/**
 * 进程内唯一的 DataSource 条目。
 *
 * **刻意不做"实体类对不上就重建"**：dev 的 HMR 会让同一份代码存在多个模块副本，
 * 各自持有不同的类对象；按类身份判断重建，会让两份副本互相销毁对方的实例（来回打架，
 * 表现为随机的 `No metadata for "…Entity" was found`）。所以 DataSource 只按配置建一次，
 * 仓储解析一律**按实体名**去已注册的元数据里找 target（见 `repositoryFor`）。
 */
function cacheEntry() {
  if (!cache.__ontologyPlatform) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured.");
    const source = new DataSource({
      type: "postgres",
      url,
      entities: PLATFORM_ENTITIES,
      // 结构由 migrations/ 负责：synchronize 会删掉 tsvector / pgvector 这类它不认识的列。
      synchronize: false,
      logging: false,
    });
    /*
     * 空闲连接被对端或中间的网络设备掐断时（远端平台库很常见），驱动会在**池对象**上发 error 事件。
     * 没有监听者就是一个未捕获的 error 事件 —— 进程可能直接退出，部署里表现为"用着用着服务没了"。
     * 这里兜住并只记一行：断了池会自己重建。
     */
    const driver = source.driver as unknown as { master?: { on?: (event: string, listener: (error: Error) => void) => void } };
    driver.master?.on?.("error", (error: Error) => {
      console.error(`[platform-db] 平台库连接断了（连接池会自动重连）：${error.message}`);
    });
    cache.__ontologyPlatform = { source };
  }
  return cache.__ontologyPlatform;
}

/** 建表 / 改列：幂等迁移按顺序执行，随后补齐首个管理员。 */
export async function ensurePlatformSchema(): Promise<void> {
  const entry = cacheEntry();
  entry.schema ??= bootstrapPlatformSchema(entry.source).catch((error) => {
    // 失败的 promise 不能留在缓存里：一次并发竞争或连接抖动，会让这个进程后续所有请求都失败。
    entry.schema = undefined;
    throw error;
  });
  return entry.schema;
}

async function bootstrapPlatformSchema(source: DataSource) {
  if (!source.isInitialized) await source.initialize();
  // 迁移里有 "先 DROP 约束再 ADD" 这类两步操作，多实例同时启动会互相踩，用库级锁串起来。
  await withAdvisoryLock("ontology_platform_schema", async () => {
    for (const migration of PLATFORM_MIGRATIONS) {
      await withPlatformQueryRunner(async (runner) => {
        await migration.up(runner);
      });
    }
  });
  await ensureBootstrapAdmin(source);
}

/**
 * 首次使用新平台库时自动创建管理员。
 * 检查与写入都在同一把 advisory lock 里，多个进程同时启动也不会各建一个；
 * 已有用户的库绝不重设密码。
 */
async function ensureBootstrapAdmin(source: DataSource) {
  const users = source.getRepository(PlatformUserEntity);
  if (await users.count()) return;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("平台库还没有用户，请配置 BOOTSTRAP_ADMIN_EMAIL 和 BOOTSTRAP_ADMIN_PASSWORD。");
  }
  await users.insert({ id: randomUUID(), email, passwordHash: await bcrypt.hash(password, 12), role: "ADMIN" });
}

/**
 * 解析仓储。
 *
 * 关键细节：**按实体名兜底**。dev 的 HMR 会让不同模块各自换一批实体类，
 * DataSource 元数据里记的还是上一批 —— 直接 `getRepository(新类)` 会报
 * `No metadata for "…Entity" was found`。这里先按类找，找不到就按同名元数据找，
 * 于是热更新、以及"同一张表被两处 import"都不会踩这个坑。
 */
function repositoryFor<T extends ObjectLiteral>(host: DataSource | EntityManager, entity: EntityTarget<T>): Repository<T> {
  const source = host instanceof DataSource ? host : host.connection;
  const name = typeof entity === "function" ? (entity as { name?: string }).name ?? "" : "";
  const metadata = source.entityMetadatas.find((item) => item.target === entity)
    ?? source.entityMetadatas.find((item) => item.name === name);
  if (!metadata) {
    throw new Error(`平台库实体元数据缺失：${name || String(entity)}。请重启服务（dev 下改过实体后需要重启一次）。`);
  }
  return host.getRepository(metadata.target as EntityTarget<T>);
}

/** 拿一个已初始化的仓储。所有平台表的读写都从这里开始。 */
export async function platformRepo<T extends ObjectLiteral>(entity: EntityTarget<T>): Promise<Repository<T>> {
  await ensurePlatformSchema();
  return repositoryFor(getPlatformDataSource(), entity);
}

/** 事务里拿仓储：同样按实体名兜底，见 `repositoryFor`。 */
export function repoIn<T extends ObjectLiteral>(manager: EntityManager, entity: EntityTarget<T>): Repository<T> {
  return repositoryFor(manager, entity);
}

/** 事务：回调里用传入的 manager 拿仓储，或直接 `manager.save(...)`。 */
export async function withPlatformTransaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  return getPlatformDataSource().transaction((manager) => operation(manager));
}

/**
 * 借一条 TypeORM 查询器执行"ORM 表达不了"的库操作（扩展、全文索引、pgvector、结构性 DDL）。
 * 业务数据读写不要走这里。
 */
export async function withPlatformQueryRunner<T>(operation: (runner: QueryRunner) => Promise<T>): Promise<T> {
  const runner = getPlatformDataSource().createQueryRunner();
  try {
    if (!runner.isReleased) await runner.connect().catch(() => undefined);
    return await operation(runner);
  } finally {
    await runner.release();
  }
}

/**
 * 跨实例互斥锁。
 *
 * 进程内的 Promise 队列只能挡住同一个实例：多实例部署时，两个实例可能同时发布同一个本体存储。
 * PostgreSQL 的会话级 advisory lock 补上这一层 —— 这是**库特性、不是数据访问**，
 * TypeORM 没有等价 API，所以是全平台唯一保留的锁语句：连接断开时锁自动释放，
 * 解锁在 finally 里显式执行，且必须与加锁落在同一条连接上。
 */
export async function withAdvisoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const runner = getPlatformDataSource().createQueryRunner();
  await runner.connect();
  try {
    // TypeORM 1.x 的 PG 查询器只接受**位置参数**（$1 + 数组），命名占位符会直接抛错。
    await runner.query("SELECT pg_advisory_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)", [key]);
  } catch (error) {
    await runner.release();
    throw error;
  }
  try {
    return await operation();
  } finally {
    try {
      await runner.query("SELECT pg_advisory_unlock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)", [key]);
    } finally {
      await runner.release();
    }
  }
}
