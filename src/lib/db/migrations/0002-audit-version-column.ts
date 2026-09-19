import type { QueryRunner } from "typeorm";

/**
 * 审计表补 `version_id` 列。
 *
 * 原先按版本筛审计记录要在查询里写 `details->>'versionId'` —— 那是 jsonb 路径表达式，
 * ORM 表达不了，只能手写 SQL 片段。把版本号提成独立列之后：
 * 写入时顺手填好（`writeAuditEntry` 从 details 里读），查询就是普通的列比较。
 * 历史行在这里一次性回填。
 */
export class AuditVersionColumn0002 {
  name = "AuditVersionColumn0002";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ontology_platform.audit_entries ADD COLUMN IF NOT EXISTS version_id TEXT`);
    await queryRunner.query(`
      UPDATE ontology_platform.audit_entries
         SET version_id = details->>'versionId'
       WHERE version_id IS NULL AND details ? 'versionId'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS audit_entries_version_idx
        ON ontology_platform.audit_entries (target_id, version_id)
    `);
  }
}
