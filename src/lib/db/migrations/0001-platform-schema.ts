import type { QueryRunner } from "typeorm";
import { DATA_SOURCE_KINDS } from "@/lib/data-source/types";
import { GRAPH_TARGET_KINDS } from "@/lib/graph/types";

/**
 * 平台库基线结构（把原先写在 `ensurePlatformSchemaOnce` 里的 DDL 原样搬过来）。
 *
 * 约定：**每一支迁移都必须是幂等的**（`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`），
 * 因为它由启动流程直接按顺序执行，没有版本表记账。新加列/表就在这里追加一支新的迁移类，
 * 不要在业务代码里写 DDL。
 *
 * 为什么要单独的迁移而不是 TypeORM 的 `synchronize: true`：`object_entries` 上有 tsvector /
 * pgvector / GIN 这些 TypeORM 表达不了的列，交给 synchronize 会被当成"多余的列"删掉。
 */
export class PlatformSchema0001 {
  name = "PlatformSchema0001";

  async up(queryRunner: QueryRunner): Promise<void> {
    const kinds = GRAPH_TARGET_KINDS.map((item) => `'${item.kind}'`).join(", ");
    const sourceKinds = DATA_SOURCE_KINDS.map((item) => `'${item.kind}'`).join(", ");

    await queryRunner.query("CREATE SCHEMA IF NOT EXISTS ontology_platform");
    await queryRunner.query(`
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
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ontology_platform' AND table_name = 'neo4j_targets')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'ontology_platform' AND table_name = 'graph_targets') THEN
          ALTER TABLE ontology_platform.neo4j_targets RENAME TO graph_targets;
        END IF;
      END $$;
    `);
    await queryRunner.query(`
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
    await queryRunner.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'JENA'`);
    await queryRunner.query(`ALTER TABLE ontology_platform.graph_targets ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE ontology_platform.graph_targets DROP CONSTRAINT IF EXISTS graph_targets_kind_check`);
    await queryRunner.query(`ALTER TABLE ontology_platform.graph_targets ADD CONSTRAINT graph_targets_kind_check CHECK (kind IN (${kinds}))`);
    // 内置后端（平台自带类型图）的已发布视图：平台库负责持久化与原子切换，
    // 进程内的 RDF / Graphology 图始终可按当前版本重建。
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.embedded_graphs (
        target_id TEXT PRIMARY KEY REFERENCES ontology_platform.graph_targets(id) ON DELETE CASCADE,
        snapshot JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // 数据资源：外部业务数据的来源（关系库等）。与本体存储 graph_targets 是两件事：
    // 前者是数据从哪来，后者是本体存在哪。
    await queryRunner.query(`
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
    await queryRunner.query(`ALTER TABLE ontology_platform.data_sources DROP CONSTRAINT IF EXISTS data_sources_kind_check`);
    await queryRunner.query(`ALTER TABLE ontology_platform.data_sources ADD CONSTRAINT data_sources_kind_check CHECK (kind IN (${sourceKinds}))`);
    /*
     * 结构缓存（2026-09-19 用户要求"复用 data_sources 这张表"）：从源库读回来的
     * 表 / 视图清单、字段清单、样本行就存在这一行的 catalog 列里，之后只从平台库取，
     * 只有点「刷新结构 / 重新取数」才回源库重读。
     */
    await queryRunner.query(`ALTER TABLE ontology_platform.data_sources ADD COLUMN IF NOT EXISTS catalog JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.audit_entries (
        id TEXT PRIMARY KEY,
        actor_id TEXT REFERENCES ontology_platform.users(id),
        target_id TEXT REFERENCES ontology_platform.graph_targets(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.ontologies (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        tags TEXT[] NOT NULL DEFAULT '{}'::text[],
        target_id TEXT NOT NULL UNIQUE REFERENCES ontology_platform.graph_targets(id) ON DELETE CASCADE,
        owner_target_id TEXT REFERENCES ontology_platform.graph_targets(id) ON DELETE SET NULL,
        namespace TEXT,
        created_by TEXT REFERENCES ontology_platform.users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.platform_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_by TEXT REFERENCES ontology_platform.users(id),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
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
    await queryRunner.query(`
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
    // 多轮上下文：更早的轮次压成一段摘要存这儿，下一轮直接复用（不重复压）。
    await queryRunner.query(`ALTER TABLE ontology_platform.reasoning_conversations ADD COLUMN IF NOT EXISTS history_summary TEXT`);
    await queryRunner.query(`ALTER TABLE ontology_platform.reasoning_conversations ADD COLUMN IF NOT EXISTS history_summary_through TEXT`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS reasoning_conversations_scope_idx
        ON ontology_platform.reasoning_conversations (created_by, ontology_id, updated_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS reasoning_messages_conversation_idx
        ON ontology_platform.reasoning_messages (conversation_id, created_at)
    `);
  }
}
