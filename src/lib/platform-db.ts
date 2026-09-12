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
      // 本体存储表从 neo4j_targets 演进为后端无关的 graph_targets，并保留历史数据。
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
 * 进程内的 Promise 队列只能挡住同一个实例：多实例部署时，两个实例可能同时发布同一个本体存储。
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
 */
export async function listAuditEntries(input: { targetId: string; actions?: string[]; versionId?: string; limit?: number }): Promise<AuditEntry[]> {
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const result = await platformQuery<{
    id: string;
    actor_id: string | null;
    actor_email: string | null;
    target_id: string | null;
    action: string;
    details: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `SELECT a.id, a.actor_id, u.email AS actor_email, a.target_id, a.action, a.details, a.created_at
       FROM ontology_platform.audit_entries a
       LEFT JOIN ontology_platform.users u ON u.id = a.actor_id
      WHERE a.target_id = $1
        AND ($2::text[] IS NULL OR a.action = ANY($2))
        AND ($4::text IS NULL OR a.details->>'versionId' = $4)
      ORDER BY a.created_at DESC
      LIMIT $3`,
    [input.targetId, input.actions && input.actions.length ? input.actions : null, limit, input.versionId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    targetId: row.target_id,
    action: row.action,
    details: row.details ?? {},
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
