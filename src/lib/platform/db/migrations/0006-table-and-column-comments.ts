import type { QueryRunner } from "typeorm";
import { PLATFORM_PG_ONLY_COLUMN_COMMENTS, platformCommentStatements } from "@/lib/platform/db/comments";

/**
 * 给平台库补上**表注释与字段注释**（用户要求：建库必须有注释，不然看不懂表和字段是干什么的）。
 *
 * 语句由 `@/lib/platform/db/comments` 生成，`COMMENT ON` 天然幂等（重复执行只是覆盖同样的文本），
 * 所以这支迁移每次启动跑一遍也没副作用。
 */
export class TableAndColumnComments0006 {
  name = "TableAndColumnComments0006";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of platformCommentStatements()) {
      await queryRunner.query(statement);
    }
    // PG 专有列（tsvector 生成列 / pgvector）由代码按扩展可用性补建：存在才补注释，文案与代码同一份。
    for (const item of PLATFORM_PG_ONLY_COLUMN_COMMENTS) {
      const rows = (await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'ontology_platform' AND table_name = $1 AND column_name = $2`,
        [item.table, item.column],
      )) as unknown[];
      if (!rows.length) continue;
      await queryRunner.query(`COMMENT ON COLUMN ontology_platform.${item.table}.${item.column} IS '${item.comment.replace(/'/g, "''")}'`);
    }
  }
}
