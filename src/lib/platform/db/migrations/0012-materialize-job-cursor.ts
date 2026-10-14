import type { QueryRunner } from "typeorm";
import { platformCommentStatements } from "@/lib/platform/db/comments";

/**
 * 物化任务加一列**断点游标**（`cursor`）。
 *
 * 为什么要它：断点续跑以前只存"读到第几条"，续跑时还原不出游标，只能退回 OFFSET 翻页 ——
 * 而 Oracle 的 OFFSET 上限是 5000 行，于是**大表一旦中断就再也续不上**（真踩过）。
 * 现在每读完一页就把"上一页最后一行的排序键值"写进这一列，续跑接着用键集翻页，跟表多大无关。
 */
export class MaterializeJobCursor0012 {
  name = "MaterializeJobCursor0012";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ontology_platform.materialization_jobs ADD COLUMN IF NOT EXISTS cursor JSONB`);
    // 注释的唯一出处是 @/lib/platform/db/comments；这支迁移自己补上，不等 0006 下一轮再跑。
    for (const statement of platformCommentStatements()) {
      if (!statement.startsWith("COMMENT ON COLUMN ontology_platform.materialization_jobs.cursor ")) continue;
      await queryRunner.query(statement);
    }
  }
}
