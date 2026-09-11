import { Pool, type QueryResultRow } from "pg";
import { GRAPH_TARGET_KINDS } from "@/lib/graph/types";

let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export type Role = "ADMIN" | "VIEWER";

export type PlatformUser = QueryResultRow & {
  id: string;
  email: string;
  role: Role;
  password_hash: string;
};

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured.");
  }

  pool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export async function ensurePlatformSchema() {
  schemaPromise ??= (async () => {
    const client = await getPool().connect();
    try {
      await client.query("CREATE SCHEMA IF NOT EXISTS ontology_platform");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('ADMIN', 'VIEWER')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // 目标表从 neo4j_targets 演进为后端无关的 graph_targets，并保留历史数据。
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ontology_platform' AND table_name = 'neo4j_targets')
             AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ontology_platform' AND table_name = 'graph_targets') THEN
            ALTER TABLE ontology_platform.neo4j_targets RENAME TO graph_targets;
          END IF;
        END $$;
      `);
      const kinds = GRAPH_TARGET_KINDS.map((item) => `'${item.kind}'`).join(", ");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.graph_targets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'NEO4J',
          uri TEXT NOT NULL,
          database_name TEXT NOT NULL DEFAULT 'neo4j',
          username TEXT NOT NULL DEFAULT '',
          credential_secret TEXT NOT NULL DEFAULT '',
          options JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'NEO4J'`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets DROP CONSTRAINT IF EXISTS graph_targets_kind_check`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD CONSTRAINT graph_targets_kind_check CHECK (kind IN (${kinds}))`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.audit_entries (
          id TEXT PRIMARY KEY,
          actor_id TEXT REFERENCES ontology_platform.users(id),
          target_id TEXT REFERENCES ontology_platform.graph_targets(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } finally {
      client.release();
    }
  })();

  return schemaPromise;
}

export async function platformQuery<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  await ensurePlatformSchema();
  return getPool().query<T>(text, values);
}

/**
 * 跨实例互斥锁。
 *
 * 进程内的 Promise 队列只能挡住同一个实例：多实例部署时，两个实例可能同时发布同一个目标。
 * 这里用 PostgreSQL 会话级 advisory lock 补齐这一层，让同一个 key 在集群范围内串行。
 * 连接断开时锁会自动释放；解锁在 finally 里显式执行，且必须与加锁落在同一条连接上。
 */
export async function withAdvisoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)", [key]);
  } catch (error) {
    client.release();
    throw error;
  }
  try {
    return await operation();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(('x' || substr(md5($1), 1, 16))::bit(64)::bigint)", [key]);
    } finally {
      client.release();
    }
  }
}

export async function writeAuditEntry(input: {
  actorId?: string;
  targetId?: string;
  action: string;
  details?: Record<string, unknown>;
}) {
  await platformQuery(
    `INSERT INTO ontology_platform.audit_entries (id, actor_id, target_id, action, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), input.actorId ?? null, input.targetId ?? null, input.action, JSON.stringify(input.details ?? {})],
  );
}
