import { type EntityManager } from "typeorm";
import { In, Not } from "typeorm";
import { ObjectEntryEntity, jsonValue, platformRepo, repoIn, withAdvisoryLock, withPlatformQueryRunner, withPlatformTransaction } from "@/lib/db";
import { planObjectSearch, type ObjectSearchFeatures } from "@/lib/object-index/sql";
import type {
  ObjectIndex,
  ObjectIndexCapabilities,
  ObjectIndexEntry,
  ObjectIndexStats,
  ObjectIndexSyncResult,
  ObjectSearchHit,
  ObjectSearchQuery,
  ObjectSearchResult,
} from "@/lib/object-index/types";

/**
 * 对象检索索引的 PostgreSQL 实现。
 *
 * **数据访问走 ORM**（2026-09-19 用户要求"操作数据库一定要用 ORM"）：
 * 写、读、删、统计都是 TypeORM 仓储操作，冲突目标是对象键 `(targetId, objectKey)`。
 *
 * 只有三处是显式 SQL，且都是 **PostgreSQL 专有、ORM 表达不了**的库特性，集中在本文件：
 * 1. 建表与索引（GIN / tsvector 生成列 / pgvector 列 / hnsw 索引）—— 表结构；
 * 2. 全文检索与向量检索的查询（`@@` / `ts_rank` / `<=>` / `similarity`）；
 * 3. 扩展安装（pg_trgm / vector）。
 * 换句话说：**换搜索引擎（OpenSearch / 其它）只需要换掉这个文件**，上层接口 `ObjectIndex` 不变。
 *
 * 向量维度固定 1536（OpenAI text-embedding-3-small 的默认维度）。改维度不是改常量就行：
 * pgvector 的列维度写死在表上，需要 ALTER 列并重建索引。
 */
export const EMBEDDING_DIM = 1536;

const TABLE = "ontology_platform.object_entries";
/** 一批写多少条：批量 upsert 一条语句带太多参数会顶到驱动的参数上限。 */
const INSERT_CHUNK = 200;

let schemaPromise: Promise<ObjectSearchFeatures> | undefined;

async function ensureObjectIndexSchemaOnce(): Promise<ObjectSearchFeatures> {
  // DDL 里有 CREATE EXTENSION / CREATE INDEX，并发请求会互相踩；用平台库的 advisory lock 串行。
  return withAdvisoryLock("ontology_platform_object_index_schema", async () => {
    return withPlatformQueryRunner(async (runner) => {
      const tryExtension = async (name: "pg_trgm" | "vector") => {
        try {
          await runner.query(`CREATE EXTENSION IF NOT EXISTS ${name}`);
          return true;
        } catch {
          // 没有权限或扩展未提供时如实降级：模糊检索退回 ILIKE，向量检索直接不可用。
          return false;
        }
      };
      await tryExtension("pg_trgm");
      const vector = await tryExtension("vector");
      const installed = (await runner.query("SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector')")) as { extname: string }[];
      const names = new Set(installed.map((row) => row.extname));
      const features: ObjectSearchFeatures = { trigram: names.has("pg_trgm"), vector: names.has("vector") && vector };

      await runner.query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          target_id TEXT NOT NULL,
          object_id TEXT NOT NULL,
          entity_type TEXT NOT NULL DEFAULT '',
          object_key TEXT NOT NULL DEFAULT '',
          labels TEXT[] NOT NULL DEFAULT '{}'::text[],
          title TEXT NOT NULL DEFAULT '',
          properties JSONB NOT NULL DEFAULT '{}'::jsonb,
          primary_key JSONB NOT NULL DEFAULT '{}'::jsonb,
          search_text TEXT NOT NULL DEFAULT '',
          version_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (target_id, object_id)
        )
      `);
      /*
       * 对象键（对象类型 + 主键）是增量 upsert 的落点：发布与"同步一行"都按它写入。
       * 老索引表没有这两列，这里补列 + 回填：拿不到可靠键的行退回对象 id（仍然唯一，但不构成身份），
       * 下一次发布/重建就会把它们换成真正的键。
       */
      await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT ''`);
      await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS object_key TEXT NOT NULL DEFAULT ''`);
      await runner.query(`UPDATE ${TABLE} SET entity_type = COALESCE(labels[1], ''), object_key = 'id:' || object_id WHERE object_key = ''`);
      await runner.query(`CREATE UNIQUE INDEX IF NOT EXISTS object_entries_key_idx ON ${TABLE} (target_id, object_key)`);
      /*
       * search_doc 改成**生成列**：过去每次写入都要在 SQL 里手写 to_tsvector(...)，属于"业务写入里夹库特性"；
       * 改成 `GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED` 之后，
       * ORM 只写 search_text，全文列由库自己维护，永远不会和文本不一致。
       * 索引是派生数据，所以这里可以安全地重建这一列（重建后需要重新发布/重建索引一次）。
       */
      const generated = (await runner.query(`
        SELECT is_generated FROM information_schema.columns
         WHERE table_schema = 'ontology_platform' AND table_name = 'object_entries' AND column_name = 'search_doc'
      `)) as { is_generated: string }[];
      if (generated.length && generated[0].is_generated !== "ALWAYS") {
        await runner.query(`ALTER TABLE ${TABLE} DROP COLUMN search_doc`);
      }
      await runner.query(`
        ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS search_doc tsvector
          GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED
      `);
      if (features.vector) await runner.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIM})`);

      await runner.query(`CREATE INDEX IF NOT EXISTS object_entries_labels_idx ON ${TABLE} USING GIN (labels)`);
      await runner.query(`CREATE INDEX IF NOT EXISTS object_entries_search_doc_idx ON ${TABLE} USING GIN (search_doc)`);
      await runner.query(`CREATE INDEX IF NOT EXISTS object_entries_properties_idx ON ${TABLE} USING GIN (properties jsonb_path_ops)`);
      if (features.trigram) await runner.query(`CREATE INDEX IF NOT EXISTS object_entries_search_text_trgm_idx ON ${TABLE} USING GIN (search_text gin_trgm_ops)`);
      if (features.vector) await runner.query(`CREATE INDEX IF NOT EXISTS object_entries_embedding_idx ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`);

      return features;
    });
  });
}

export function ensureObjectIndexSchema(): Promise<ObjectSearchFeatures> {
  schemaPromise ??= ensureObjectIndexSchemaOnce().catch((error) => {
    // 与平台库 schema 同一处理：失败的 promise 不能留在缓存里，否则一次抖动会让本进程后续请求全挂。
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

/** 索引条目 -> 实体行。search_doc / embedding 由库自己维护，这里不出现。 */
function toRow(targetId: string, entry: ObjectIndexEntry, versionId: string | null): ObjectEntryEntity {
  return {
    targetId,
    objectId: entry.objectId,
    entityType: entry.entityType,
    objectKey: entry.objectKey || `id:${entry.objectId}`,
    labels: entry.labels,
    title: entry.title,
    properties: jsonValue(entry.properties),
    primaryKey: jsonValue(entry.primaryKey),
    searchText: entry.searchText,
    versionId,
    updatedAt: new Date(),
  };
}

function entryFromRow(row: ObjectEntryEntity): ObjectIndexEntry {
  return {
    objectId: row.objectId,
    entityType: row.entityType,
    objectKey: row.objectKey,
    labels: row.labels ?? [],
    title: row.title,
    properties: (row.properties ?? {}) as Record<string, unknown>,
    primaryKey: (row.primaryKey ?? {}) as Record<string, string>,
    searchText: row.searchText ?? "",
  };
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** 按对象键 upsert 一批条目；冲突目标是对象键，不是对象 id。 */
async function upsertWith(manager: EntityManager, targetId: string, entries: readonly ObjectIndexEntry[], versionId: string | null) {
  if (!entries.length) return 0;
  const repo = repoIn(manager, ObjectEntryEntity);
  for (const chunk of chunked(entries, INSERT_CHUNK)) {
    await repo.upsert(chunk.map((entry) => toRow(targetId, entry, versionId)), ["targetId", "objectKey"]);
  }
  return entries.length;
}

async function replaceWith(manager: EntityManager, targetId: string, entries: readonly ObjectIndexEntry[], versionId: string | null) {
  const repo = repoIn(manager, ObjectEntryEntity);
  await repo.delete({ targetId });
  return upsertWith(manager, targetId, entries, versionId);
}

/**
 * 增量同步：先把这次的对象按对象键写进去，`prune` 为真时再删掉本次没出现的键。
 * 这是发布的默认路径 —— 没变的对象不会被删了重写，别的写入者也不受影响。
 */
async function syncWith(
  manager: EntityManager,
  targetId: string,
  entries: readonly ObjectIndexEntry[],
  versionId: string | null,
  prune: boolean,
): Promise<ObjectIndexSyncResult> {
  const upserted = await upsertWith(manager, targetId, entries, versionId);
  let deleted = 0;
  if (prune) {
    const repo = repoIn(manager, ObjectEntryEntity);
    // 空集时就是"这个本体存储不该有对象了"，整表删。
    const result = entries.length
      ? await repo.delete({ targetId, objectKey: Not(In(entries.map((entry) => entry.objectKey || `id:${entry.objectId}`))) })
      : await repo.delete({ targetId });
    deleted = result.affected ?? 0;
  }
  const total = await repoIn(manager, ObjectEntryEntity).count({ where: { targetId } });
  return { upserted, deleted, total };
}

type HitRow = {
  object_id: string;
  entity_type: string | null;
  object_key: string | null;
  labels: string[] | null;
  title: string | null;
  properties: Record<string, unknown> | null;
  primary_key: Record<string, string> | null;
  score: number | string | null;
};

async function searchObjects(query: ObjectSearchQuery): Promise<ObjectSearchResult> {
  const features = await ensureObjectIndexSchema();
  if (query.vector?.length && !features.vector) {
    throw new Error("当前 PostgreSQL 实例未启用 pgvector，向量检索不可用。");
  }
  const plan = planObjectSearch(query, features);
  const started = Date.now();
  // 全文 / 向量检索是 PG 专有表达式，ORM 表达不了：语句本身仍是**参数化**的纯函数产物。
  const [hitRows, countRows] = await withPlatformQueryRunner(async (runner) => [
    (await runner.query(plan.hits.text, plan.hits.values)) as HitRow[],
    (await runner.query(plan.count.text, plan.count.values)) as { total: number }[],
  ]);
  const hits: ObjectSearchHit[] = hitRows.map((row) => ({
    objectId: row.object_id,
    entityType: row.entity_type ?? "",
    objectKey: row.object_key ?? "",
    labels: row.labels ?? [],
    title: row.title ?? "",
    properties: row.properties ?? {},
    primaryKey: row.primary_key ?? {},
    score: Number(row.score ?? 0),
  }));
  return {
    hits,
    total: Number(countRows[0]?.total ?? 0),
    tookMs: Date.now() - started,
    textMode: plan.textMode,
    vectorUsed: plan.vectorUsed,
  };
}

async function stats(targetId: string): Promise<ObjectIndexStats> {
  await ensureObjectIndexSchema();
  const repo = await platformRepo(ObjectEntryEntity);
  const [entries, latest, labels] = await Promise.all([
    repo.count({ where: { targetId } }),
    repo.find({ where: { targetId }, order: { updatedAt: "DESC" }, take: 1, select: { updatedAt: true } }),
    // 按类分布：取标签数组在内存里数（索引条目数量级不高，且这条路径只在状态页用）。
    repo.find({ where: { targetId }, select: { labels: true } }),
  ]);
  const counts = new Map<string, number>();
  for (const row of labels) for (const label of row.labels ?? []) counts.set(label, (counts.get(label) ?? 0) + 1);
  return {
    entries,
    byLabel: [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    updatedAt: latest[0] ? new Date(latest[0].updatedAt).toISOString() : null,
  };
}

export function createPostgresObjectIndex(): ObjectIndex {
  return {
    kind: "POSTGRES",
    async syncTargetObjects(targetId, entries, options): Promise<ObjectIndexSyncResult> {
      await ensureObjectIndexSchema();
      return withPlatformTransaction((manager) =>
        syncWith(manager, targetId, entries, options?.versionId ?? null, options?.prune ?? false));
    },
    async readObject(targetId, objectKey) {
      await ensureObjectIndexSchema();
      const repo = await platformRepo(ObjectEntryEntity);
      const row = await repo.findOne({ where: { targetId, objectKey } });
      return row ? entryFromRow(row) : null;
    },
    async deleteObjects(targetId, objectKeys) {
      const keys = [...new Set(objectKeys.map((key) => key?.trim()).filter(Boolean))];
      if (!keys.length) return 0;
      await ensureObjectIndexSchema();
      const repo = await platformRepo(ObjectEntryEntity);
      let deleted = 0;
      for (const chunk of chunked(keys, INSERT_CHUNK)) {
        const result = await repo.delete({ targetId, objectKey: In(chunk) });
        deleted += result.affected ?? 0;
      }
      return deleted;
    },
    async replaceTargetObjects(targetId, entries, options) {
      await ensureObjectIndexSchema();
      const indexed = await withPlatformTransaction((manager) =>
        replaceWith(manager, targetId, entries, options?.versionId ?? null));
      return { indexed };
    },
    searchObjects,
    async deleteTargetObjects(targetId) {
      await ensureObjectIndexSchema();
      const repo = await platformRepo(ObjectEntryEntity);
      await repo.delete({ targetId });
    },
    stats,
    async capabilities(): Promise<ObjectIndexCapabilities> {
      try {
        const features = await ensureObjectIndexSchema();
        return {
          available: true,
          fullText: true,
          trigram: features.trigram,
          vector: features.vector,
          embeddingDim: features.vector ? EMBEDDING_DIM : null,
        };
      } catch (error) {
        return {
          available: false,
          fullText: false,
          trigram: false,
          vector: false,
          embeddingDim: null,
          reason: error instanceof Error ? error.message : "对象检索索引不可用。",
        };
      }
    },
  };
}
