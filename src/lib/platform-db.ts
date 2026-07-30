import { Pool, type QueryResultRow } from "pg";

let pool: Pool | undefined;
let schemaPromise: Promise<void> | undefined;

export type Role = "ADMIN" | "VIEWER";

export type PlatformUser = QueryResultRow & {
  id: string;
  email: string;
  role: Role;
  password_hash: string;
};

export type Neo4jTarget = QueryResultRow & {
  id: string;
  name: string;
  uri: string;
  database_name: string;
  username: string;
  credential_secret: string;
  created_at: Date;
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.neo4j_targets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          uri TEXT NOT NULL,
          database_name TEXT NOT NULL DEFAULT 'neo4j',
          username TEXT NOT NULL,
          credential_secret TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.ontology_versions (
          id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL REFERENCES ontology_platform.neo4j_targets(id) ON DELETE CASCADE,
          version_number INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
          definition JSONB NOT NULL DEFAULT '{"entityTypes":[],"relationshipTypes":[]}'::jsonb,
          created_by TEXT NOT NULL REFERENCES ontology_platform.users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          published_at TIMESTAMPTZ,
          UNIQUE (target_id, version_number)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ontology_platform.audit_entries (
          id TEXT PRIMARY KEY,
          actor_id TEXT REFERENCES ontology_platform.users(id),
          target_id TEXT REFERENCES ontology_platform.neo4j_targets(id) ON DELETE SET NULL,
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
