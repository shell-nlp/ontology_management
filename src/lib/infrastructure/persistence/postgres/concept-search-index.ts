import { pgOnlyColumnComment } from "@/lib/infrastructure/persistence/postgres/comments";
import { withPlatformQueryRunner } from "@/lib/infrastructure/persistence/postgres";

let conceptIndexPromise: Promise<void> | undefined;

/**
 * PostgreSQL 专有的概念检索索引。
 *
 * 全文生成列、pg_trgm、pgvector 和对应索引都不是 TypeORM schema 能可靠表达的结构；
 * 这些细节只能留在持久化适配层，对上层只暴露“确保索引已准备”这一项能力。
 */
export async function ensureConceptSearchIndex(): Promise<void> {
  conceptIndexPromise ??= bootstrapConceptSearchIndex().catch((error) => {
    conceptIndexPromise = undefined;
    throw error;
  });
  return conceptIndexPromise;
}

async function tryExtension(name: "pg_trgm" | "vector"): Promise<boolean> {
  try {
    await withPlatformQueryRunner((runner) => runner.query(`CREATE EXTENSION IF NOT EXISTS ${name}`));
    return true;
  } catch {
    return false;
  }
}

async function bootstrapConceptSearchIndex(): Promise<void> {
  const trigram = await tryExtension("pg_trgm");
  const vector = await tryExtension("vector");
  await withPlatformQueryRunner(async (runner) => {
    await runner.query(`ALTER TABLE ontology_platform.ontology_concepts ADD COLUMN IF NOT EXISTS search_doc tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED`);
    await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_search_idx ON ontology_platform.ontology_concepts USING gin (search_doc)`);
    if (trigram) {
      await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_name_trgm_idx ON ontology_platform.ontology_concepts USING gin (name gin_trgm_ops)`);
    }
    if (vector) {
      await runner.query(`ALTER TABLE ontology_platform.ontology_concepts ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
      await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_embedding_idx ON ontology_platform.ontology_concepts USING hnsw (embedding vector_cosine_ops)`);
    }
    await runner.query(`COMMENT ON COLUMN ontology_platform.ontology_concepts.search_doc IS '${pgOnlyColumnComment("ontology_concepts", "search_doc").replace(/'/g, "''")}'`);
    if (vector) {
      await runner.query(`COMMENT ON COLUMN ontology_platform.ontology_concepts.embedding IS '${pgOnlyColumnComment("ontology_concepts", "embedding").replace(/'/g, "''")}'`);
    }
  });
}
