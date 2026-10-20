import type { QueryRunner } from "typeorm";

/** 删除已退役的整份对象物化任务表；对象现在始终按当前版本虚拟查询。 */
export class DropLegacyObjectMaterialization0017 {
  name = "DropLegacyObjectMaterialization0017";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS ontology_platform.materialization_jobs");
  }
}
