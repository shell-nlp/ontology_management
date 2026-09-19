import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, it } from "vitest";
import { getPlatformDataSource } from "@/lib/db";
import { createPostgresObjectIndex } from "@/lib/object-index/postgres";
import { runObjectIndexContract } from "./contract";

/**
 * 拿真 PostgreSQL 跑一遍对象索引的后端契约。
 *
 * **为什么默认会被跳过**：`pnpm test` 不该依赖数据库（现在 363 条用例都是纯的）。
 * vitest 不会把 `.env.local` 灌进 `process.env`，所以没有 `DATABASE_URL` 时这里只留一条显式跳过的说明；
 * 要真跑就用仓库脚本：
 *
 *   pnpm test:object-index        # = node --env-file=.env.local vitest run 这个文件
 *
 * 用例只写随机 target id 的索引行（`object_entries` 对该列没有外键），跑完自己清干净，
 * 不会碰你正在用的本体。
 */
const databaseUrl = process.env.DATABASE_URL;

/*
 * 平台库的连接在应用里由启动流程 `ensurePlatformSchema()` 建立（它顺带跑迁移）。
 * 测试进程没有那个启动流程，所以这里自己把连接初始化一次 —— 只连、不跑迁移。
 * 这是 **PostgreSQL 专属**的引导，所以放在这个文件里，不进后端无关的契约。
 */
beforeAll(async () => {
  if (!databaseUrl) return;
  const source = getPlatformDataSource();
  if (!source.isInitialized) await source.initialize();
});

afterAll(async () => {
  if (!databaseUrl) return;
  // 不关连接池的话 vitest 会挂着不退（池里有空闲连接）。
  await getPlatformDataSource().destroy().catch(() => undefined);
});

describe("对象索引后端契约（PostgreSQL）", () => {
  it.skipIf(!databaseUrl)("需要 DATABASE_URL：用 `pnpm test:object-index` 跑完整契约", () => {
    // 真正的用例由下面的 runObjectIndexContract 注册；这条只是"为什么没跑"的说明。
  });
});

if (databaseUrl) {
  runObjectIndexContract({
    label: "PostgreSQL",
    kind: "POSTGRES",
    createIndex: () => createPostgresObjectIndex(),
    targetId: () => `contract-${randomUUID()}`,
  });
}
