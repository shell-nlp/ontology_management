import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { DATA_SOURCE_KINDS } from "@/lib/data-source/types";
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

  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    /*
     * 空闲连接被对端或中间的网络设备掐断时（远端平台库很常见），pg 会在**池对象**上发 error 事件。
     * 没有监听者就是一个未捕获的 error 事件 —— 进程可能直接退出，部署里表现为"用着用着服务没了"，
     * 而且日志会把整个连接对象打出来（几 KB 的噪音）。这里兜住并只记一行：断了池会自己重建。
     */
    pool.on("error", (error) => {
      console.error(`[platform-db] 平台库连接断了（连接池会自动重连）：${error.message}`);
    });
  }
  return pool;
}

export async function ensurePlatformSchema() {
  schemaPromise ??= ensurePlatformSchemaOnce().catch((error) => {
    // 失败的 promise 不能留在缓存里：一次并发竞争或连接抖动，会让这个进程后续所有请求都失败。
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

async function ensurePlatformSchemaOnce() {
  // DDL 里有 DROP + ADD 约束这种两步操作，并发请求会互相踩（约束已存在）。用数据库层面的锁串起来。
  return withAdvisoryLock("ontology_platform_schema", async () => {
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
      // 本体存储表从 neo4j_targets 演进为后端无关的 graph_targets；这条改名迁移保留，
      // 老部署升级时历史数据不会丢（Neo4j 引擎本身已于 2026-09-14 移除）。
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
          kind TEXT NOT NULL DEFAULT 'JENA',
          uri TEXT NOT NULL,
          database_name TEXT NOT NULL DEFAULT 'ds',
          username TEXT NOT NULL DEFAULT '',
          credential_secret TEXT NOT NULL DEFAULT '',
          options JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'JENA'`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets DROP CONSTRAINT IF EXISTS graph_targets_kind_check`);
      await client.query(`ALTER TABLE ontology_platform.graph_targets ADD CONSTRAINT graph_targets_kind_check CHECK (kind IN (${kinds}))`);
      // 数据资源：外部业务数据的来源（关系库等）。与本体存储 graph_targets 是两件事：
      // 前者是数据从哪来，后者是本体存在哪。这里只存连接信息，取数一律按需连、用完断开。
      const sourceKinds = DATA_SOURCE_KINDS.map((item) => `'${item.kind}'`).join(", ");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.data_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'POSTGRES',
          host TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 5432,
          database_name TEXT NOT NULL DEFAULT '',
          schema_name TEXT NOT NULL DEFAULT '',
          username TEXT NOT NULL DEFAULT '',
          credential_secret TEXT NOT NULL DEFAULT '',
          options JSONB NOT NULL DEFAULT '{}'::jsonb,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE ontology_platform.data_sources DROP CONSTRAINT IF EXISTS data_sources_kind_check`);
      await client.query(`ALTER TABLE ontology_platform.data_sources ADD CONSTRAINT data_sources_kind_check CHECK (kind IN (${sourceKinds}))`);
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
      // 本体：平台的隔离单位。一个本体占一份图数据（target_id 唯一），
      // 「本体存储」退到后面当落点用；用户建本体时只需要挑一个存储资源。
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.ontologies (
          id TEXT PRIMARY KEY,
          identifier TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '',
          tags TEXT[] NOT NULL DEFAULT '{}'::text[],
          target_id TEXT NOT NULL UNIQUE REFERENCES ontology_platform.graph_targets(id) ON DELETE CASCADE,
          /** 用户挑的那个存储资源。Jena 上会另开一条受管记录，这里记住它从哪来。 */
          owner_target_id TEXT REFERENCES ontology_platform.graph_targets(id) ON DELETE SET NULL,
          /** Fuseki 里的命名图，一个本体一个。 */
          namespace TEXT,
          created_by TEXT REFERENCES ontology_platform.users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      /*
       * 智能问答的对话历史（能力验证 → 智能问答）。
       *
       * conversation 挂在**一个本体**下、属于**提问的那个人**；message 是一轮问答，
       * 存问题、结论、思考过程，以及那次运行的完整结果 `run`（步骤 / 证据 / 用量）。
       * 存 run 是为了"看以前的对话"能看到和当时一模一样的过程，而不是只剩一段结论。
       *
       * ontology_id 可为空、target_id 不设外键：只有直接选中一条未纳管的存储资源时
       * 才没有本体可挂，这时退化成按落点归类；本体换落点之后历史仍然属于这个本体。
       */
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.platform_settings (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_by TEXT REFERENCES ontology_platform.users(id),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.reasoning_conversations (
          id TEXT PRIMARY KEY,
          ontology_id TEXT REFERENCES ontology_platform.ontologies(id) ON DELETE CASCADE,
          target_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          created_by TEXT REFERENCES ontology_platform.users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.reasoning_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES ontology_platform.reasoning_conversations(id) ON DELETE CASCADE,
          question TEXT NOT NULL,
          answer TEXT NOT NULL DEFAULT '',
          thinking TEXT NOT NULL DEFAULT '',
          thinking_on BOOLEAN NOT NULL DEFAULT TRUE,
          run JSONB,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS reasoning_conversations_scope_idx
          ON ontology_platform.reasoning_conversations (created_by, ontology_id, updated_at DESC)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS reasoning_messages_conversation_idx
          ON ontology_platform.reasoning_messages (conversation_id, created_at)
      `);
    } finally {
      client.release();
    }
  });
}

export async function platformQuery<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  await ensurePlatformSchema();
  return getPool().query<T>(text, values);
}

/**
 * 需要多条语句原子生效时用这个（典型场景：删掉旧索引 + 写入新索引）。
 * 与 platformQuery 共用同一个连接池；回调里拿到的 client 只在回调内使用，不要外传。
 */
export async function withPlatformTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensurePlatformSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 连接已经断开时回滚也会失败；保留原始错误更有诊断价值。
    }
    throw error;
  } finally {
    client.release();
  }
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

/**
 * 平台级设置：一段 JSON 存在库里，按 key 取。
 *
 * 与「问答配置」的区别：那几个数是**浏览器本地**的偏好（一台机器一套），
 * 而工具开关要影响服务端 —— MCP 端点在外部客户端手里，模型看不到浏览器，
 * 所以这类"跟着部署走"的设置必须落在平台库上。
 */
export async function readPlatformSetting<T>(key: string): Promise<T | null> {
  const result = await platformQuery<{ value: T }>("SELECT value FROM ontology_platform.platform_settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

export async function writePlatformSetting<T>(key: string, value: T, updatedBy?: string): Promise<T> {
  await platformQuery(
    `INSERT INTO ontology_platform.platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, JSON.stringify(value), updatedBy ?? null],
  );
  return value;
}
