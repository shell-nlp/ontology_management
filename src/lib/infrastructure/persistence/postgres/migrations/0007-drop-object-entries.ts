import type { QueryRunner } from "typeorm";

/**
 * 对象索引搬去 ClickHouse 之后，删掉平台库里的 `object_entries`。
 *
 * 这张表是**派生数据**（对象实例的检索索引，可以从数据源与已发布快照重建），
 * 所以删除是安全的：对象查询现在直接读取 ODS / 业务源，不再依赖这张表。
 * 本体定义与版本在 `ontology_versions` / `ontology_concepts`，与这张表无关。
 */
export class DropObjectEntries0007 {
  name = "DropObjectEntries0007";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS ontology_platform.object_entries`);
  }
}
