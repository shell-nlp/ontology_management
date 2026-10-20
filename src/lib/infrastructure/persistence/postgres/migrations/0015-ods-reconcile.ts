import type { QueryRunner } from "typeorm";
import { platformCommentStatements } from "@/lib/infrastructure/persistence/postgres/comments";

/** ODS 定期全量校准配置。 */
export class OdsReconcile0015 {
  name = "OdsReconcile0015";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ontology_platform.ods_sources ADD COLUMN IF NOT EXISTS last_full_sync_at TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE ontology_platform.ods_sources ADD COLUMN IF NOT EXISTS auto_reconcile_hours INTEGER NOT NULL DEFAULT 24`);
    await queryRunner.query(`ALTER TABLE ontology_platform.ods_sources ADD COLUMN IF NOT EXISTS next_reconcile_at TIMESTAMPTZ`);
    for (const statement of platformCommentStatements()) {
      if (statement.includes("ontology_platform.ods_sources.last_full_sync_at")
        || statement.includes("ontology_platform.ods_sources.auto_reconcile_hours")
        || statement.includes("ontology_platform.ods_sources.next_reconcile_at")) {
        await queryRunner.query(statement);
      }
    }
  }
}
