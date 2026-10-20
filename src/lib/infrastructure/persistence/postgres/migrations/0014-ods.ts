import type { QueryRunner } from "typeorm";
import { platformCommentStatements } from "@/lib/infrastructure/persistence/postgres/comments";

/** ClickHouse ODS 配置与同步任务。 */
export class OdsTables0014 {
  name = "OdsTables0014";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.ods_sources (
        id TEXT PRIMARY KEY,
        data_source_id TEXT NOT NULL,
        schema_name TEXT NOT NULL DEFAULT '',
        table_name TEXT NOT NULL,
        table_kind TEXT NOT NULL DEFAULT 'table',
        columns JSONB NOT NULL,
        primary_key_columns JSONB NOT NULL,
        watermark_column TEXT NOT NULL DEFAULT '',
        sync_mode TEXT NOT NULL DEFAULT 'FULL',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ch_table TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'NEVER',
        last_sync_at TIMESTAMPTZ,
        last_sync_job_id TEXT,
        row_count BIGINT NOT NULL DEFAULT 0,
        last_error TEXT,
        last_watermark JSONB,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (data_source_id, schema_name, table_name)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.ods_sync_jobs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        scanned BIGINT NOT NULL DEFAULT 0,
        rows BIGINT NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        total BIGINT,
        truncated BOOLEAN NOT NULL DEFAULT FALSE,
        message TEXT,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_by TEXT,
        checkpoint JSONB
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS ods_sync_jobs_source_idx ON ontology_platform.ods_sync_jobs (source_id, queued_at DESC)`,
    );
    for (const statement of platformCommentStatements()) {
      const sourceColumns = [
        "id", "data_source_id", "schema_name", "table_name", "table_kind", "columns", "primary_key_columns",
        "watermark_column", "sync_mode", "enabled", "ch_table", "status", "last_sync_at", "last_sync_job_id",
        "row_count", "last_error", "last_watermark", "created_by", "created_at", "updated_at",
      ];
      const inJobs = statement.includes("ontology_platform.ods_sync_jobs");
      const inSourceTable = statement.includes("COMMENT ON TABLE ontology_platform.ods_sources");
      const inSourceColumn = sourceColumns.some((column) => statement.includes(`ontology_platform.ods_sources.${column} `));
      if (inJobs || inSourceTable || inSourceColumn) await queryRunner.query(statement);
    }
  }
}
