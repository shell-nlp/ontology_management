import type { QueryRunner } from "typeorm";
import { PLATFORM_PG_ONLY_COLUMN_COMMENTS, platformCommentStatements } from "@/lib/infrastructure/persistence/postgres/comments";

/**
 * 给平台库补上**表注释与字段注释**（用户要求：建库必须有注释，不然看不懂表和字段是干什么的）。
 *
 * 语句由 `@/lib/infrastructure/persistence/postgres/comments` 生成，`COMMENT ON` 天然幂等（重复执行只是覆盖同样的文本），
 * 所以这支迁移每次启动跑一遍也没副作用。
 */
export class TableAndColumnComments0006 {
  name = "TableAndColumnComments0006";

  async up(queryRunner: QueryRunner): Promise<void> {
    /*
     * 只给**已经存在**的表补注释：注释清单是"库里应该有哪些表"的全集，而迁移是按顺序跑的 ——
     * 后加的表（例如 0008 的 materialization_jobs）在这支迁移跑的时候还不存在，
     * 直接 `COMMENT ON TABLE` 会报 `relation ... does not exist`，整个启动都起不来。
     */
    const existing = (await queryRunner.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ontology_platform'`,
    )) as { table_name: string }[];
    const present = new Set(existing.map((row) => row.table_name));
    /*
     * **列注释还要再查一次"列在不在"**：注释清单是"库里应该有哪些列"的全集，
     * 而新增列是由更靠后的迁移加的，这支 0006 在它们**之前**跑。
     * 少了这一道，给老表新增一列注释就会让 0006 在下次启动时炸掉 —— 迁移失败 = 整个平台起不来，
     * 而路由层只会回一句笼统的"请求无效"，非常难查（2026-10-14 真踩过：加 materialization_jobs.cursor）。
     */
    const existingColumns = (await queryRunner.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'ontology_platform'`,
    )) as { table_name: string; column_name: string }[];
    const presentColumns = new Set(existingColumns.map((row) => row.table_name + "." + row.column_name));
    for (const statement of platformCommentStatements()) {
      const tableMatch = /^COMMENT ON (?:TABLE|COLUMN) ontology_platform\.([a-z_]+)/.exec(statement);
      if (tableMatch && !present.has(tableMatch[1])) continue;
      const columnMatch = /^COMMENT ON COLUMN ontology_platform\.([a-z_]+)\.([a-z_]+) /.exec(statement);
      if (columnMatch && !presentColumns.has(columnMatch[1] + "." + columnMatch[2])) continue;
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
