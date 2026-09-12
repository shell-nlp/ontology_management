import type { PoolClient } from "pg";
import { platformQuery, withAdvisoryLock, withPlatformTransaction } from "@/lib/platform-db";
import { planObjectSearch, type ObjectSearchFeatures } from "@/lib/object-index/sql";
import type {
  ObjectIndex,
  ObjectIndexCapabilities,
  ObjectIndexEntry,
  ObjectIndexStats,
  ObjectSearchHit,
  ObjectSearchQuery,
  ObjectSearchResult,
} from "@/lib/object-index/types";

/**
 * 向量维度固定 1536（OpenAI text-embedding-3-small 的默认维度）。
 * 改维度不是改常量就行：pgvector 的列维度写死在表上，需要 ALTER 列并重建索引。
 */
export const EMBEDDING_DIM = 1536;

const TABLE = "ontology_platform.object_entries";
/** 一批写多少条。jsonb 走单次往返，批次太大会顶到 max_parameter 或内存。 */
const INSERT_CHUNK = 500;

let schemaPromise: Promise<ObjectSearchFeatures> | undefined;

async function tryExtension(name: "pg_trgm" | "vector") {
  try {
    await platformQuery(`CREATE EXTENSION IF NOT EXISTS ${name}`);
    return true;
  } catch {
    // 没有权限或扩展未提供时如实降级：模糊检索退回 ILIKE，向量检索直接不可用。
    return false;
  }
}

async function installedExtensions() {
  const result = await platformQuery<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'vector')");
  return new Set(result.rows.map((row) => row.extname));
}

async function ensureObjectIndexSchemaOnce(): Promise<ObjectSearchFeatures> {
  // DDL 里有 CREATE EXTENSION / CREATE INDEX，并发请求会互相踩；用平台库的 advisory lock 串行。
  return withAdvisoryLock("ontology_platform_object_index_schema", async () => {
    await tryExtension("pg_trgm");
    await tryExtension("vector");
    const installed = await installedExtensions();
    const features: ObjectSearchFeatures = { trigram: installed.has("pg_trgm"), vector: installed.has("vector") };

    await platformQuery(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        target_id TEXT NOT NULL,
        object_id TEXT NOT NULL,
        labels TEXT[] NOT NULL DEFAULT '{}'::text[],
        title TEXT NOT NULL DEFAULT '',
        properties JSONB NOT NULL DEFAULT '{}'::jsonb,
        primary_key JSONB NOT NULL DEFAULT '{}'::jsonb,
        search_text TEXT NOT NULL DEFAULT '',
        search_doc TSVECTOR NOT NULL,
        version_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (target_id, object_id)
      )
    `);
    if (features.vector) await platformQuery(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIM})`);

    await platformQuery(`CREATE INDEX IF NOT EXISTS object_entries_labels_idx ON ${TABLE} USING GIN (labels)`);
    await platformQuery(`CREATE INDEX IF NOT EXISTS object_entries_search_doc_idx ON ${TABLE} USING GIN (search_doc)`);
    await platformQuery(`CREATE INDEX IF NOT EXISTS object_entries_properties_idx ON ${TABLE} USING GIN (properties jsonb_path_ops)`);
    if (features.trigram) await platformQuery(`CREATE INDEX IF NOT EXISTS object_entries_search_text_trgm_idx ON ${TABLE} USING GIN (search_text gin_trgm_ops)`);
    if (features.vector) await platformQuery(`CREATE INDEX IF NOT EXISTS object_entries_embedding_idx ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`);

    return features;
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

type IndexRowPayload = {
  object_id: string;
  labels: string[];
  title: string;
  properties: Record<string, unknown>;
  primary_key: Record<string, string>;
  search_text: string;
  embedding: string | null;
};

function toPayload(entry: ObjectIndexEntry): IndexRowPayload {
  return {
    object_id: entry.objectId,
    labels: entry.labels,
    title: entry.title,
    properties: entry.properties,
    primary_key: entry.primaryKey,
    search_text: entry.searchText,
    embedding: entry.embedding?.length ? `[${entry.embedding.join(",")}]` : null,
  };
}

function insertStatement(withEmbedding: boolean) {
  const embeddingSelect = withEmbedding ? ", NULLIF(r.embedding, '')::vector, $3, NOW()" : ", $3, NOW()";
  const embeddingColumn = withEmbedding ? ", embedding" : "";
  const embeddingUpdate = withEmbedding ? ", embedding = EXCLUDED.embedding" : "";
  const recordEmbedding = withEmbedding ? ", embedding text" : "";
  return `INSERT INTO ${TABLE}
      (target_id, object_id, labels, title, properties, primary_key, search_text, search_doc${embeddingColumn}, version_id, updated_at)
    SELECT $1, r.object_id, COALESCE(r.labels, '{}'::text[]), COALESCE(r.title, ''), COALESCE(r.properties, '{}'::jsonb),
           COALESCE(r.primary_key, '{}'::jsonb), COALESCE(r.search_text, ''),
           to_tsvector('simple', COALESCE(r.search_text, ''))${embeddingSelect}
      FROM jsonb_to_recordset($2::jsonb) AS r(
        object_id text, labels text[], title text, properties jsonb, primary_key jsonb, search_text text${recordEmbedding}
      )
    ON CONFLICT (target_id, object_id) DO UPDATE SET
      labels = EXCLUDED.labels, title = EXCLUDED.title, properties = EXCLUDED.properties,
      primary_key = EXCLUDED.primary_key, search_text = EXCLUDED.search_text,
      search_doc = EXCLUDED.search_doc${embeddingUpdate}, version_id = EXCLUDED.version_id, updated_at = NOW()`;
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function replaceInTransaction(
  client: PoolClient,
  targetId: string,
  entries: readonly ObjectIndexEntry[],
  versionId: string | null,
  features: ObjectSearchFeatures,
) {
  await client.query(`DELETE FROM ${TABLE} WHERE target_id = $1`, [targetId]);
  if (!entries.length) return 0;
  const statement = insertStatement(features.vector);
  let indexed = 0;
  for (const chunk of chunked(entries, INSERT_CHUNK)) {
    await client.query(statement, [targetId, JSON.stringify(chunk.map(toPayload)), versionId]);
    indexed += chunk.length;
  }
  return indexed;
}

type HitRow = {
  object_id: string;
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
  const [hitResult, countResult] = await Promise.all([
    platformQuery<HitRow>(plan.hits.text, plan.hits.values),
    platformQuery<{ total: number }>(plan.count.text, plan.count.values),
  ]);
  const hits: ObjectSearchHit[] = hitResult.rows.map((row) => ({
    objectId: row.object_id,
    labels: row.labels ?? [],
    title: row.title ?? "",
    properties: row.properties ?? {},
    primaryKey: row.primary_key ?? {},
    score: Number(row.score ?? 0),
  }));
  return {
    hits,
    total: Number(countResult.rows[0]?.total ?? 0),
    tookMs: Date.now() - started,
    textMode: plan.textMode,
    vectorUsed: plan.vectorUsed,
  };
}

async function stats(targetId: string): Promise<ObjectIndexStats> {
  await ensureObjectIndexSchema();
  const [total, labels, updated] = await Promise.all([
    platformQuery<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${TABLE} WHERE target_id = $1`, [targetId]),
    platformQuery<{ label: string; count: number }>(
      `SELECT label, COUNT(*)::int AS count
         FROM ${TABLE} e, unnest(e.labels) AS label
        WHERE e.target_id = $1
        GROUP BY label
        ORDER BY count DESC, label ASC`,
      [targetId],
    ),
    platformQuery<{ updated_at: Date | null }>(`SELECT MAX(updated_at) AS updated_at FROM ${TABLE} WHERE target_id = $1`, [targetId]),
  ]);
  const updatedAt = updated.rows[0]?.updated_at ?? null;
  return {
    entries: Number(total.rows[0]?.count ?? 0),
    byLabel: labels.rows.map((row) => ({ label: row.label, count: Number(row.count) })),
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
  };
}

export function createPostgresObjectIndex(): ObjectIndex {
  return {
    kind: "POSTGRES",
    async replaceTargetObjects(targetId, entries, options) {
      const features = await ensureObjectIndexSchema();
      const indexed = await withPlatformTransaction((client) =>
        replaceInTransaction(client, targetId, entries, options?.versionId ?? null, features),
      );
      return { indexed };
    },
    searchObjects,
    async deleteTargetObjects(targetId) {
      await ensureObjectIndexSchema();
      await platformQuery(`DELETE FROM ${TABLE} WHERE target_id = $1`, [targetId]);
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
