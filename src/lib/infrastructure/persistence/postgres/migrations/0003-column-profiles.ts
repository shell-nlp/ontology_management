import type { QueryRunner } from "typeorm";

/**
 * 列画像缓存表（2026-10-08）。
 *
 * `COUNT(DISTINCT)` 在大表上很贵，所以列画像不实时算：按「数据资源 + 模式.表」缓存一份
 * **采样**结果（见 @/lib/column-profile），默认一天内复用，只有显式刷新才回源库重采。
 * 表结构仍然只由迁移负责，业务代码不写 DDL。
 */
export class ColumnProfiles0003 {
  name = "ColumnProfiles0003";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.column_profiles (
        source_id TEXT NOT NULL REFERENCES ontology_platform.data_sources(id) ON DELETE CASCADE,
        table_key TEXT NOT NULL,
        schema_name TEXT NOT NULL DEFAULT '',
        table_name TEXT NOT NULL,
        profile JSONB NOT NULL,
        sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_id, table_key)
      )
    `);
  }
}
