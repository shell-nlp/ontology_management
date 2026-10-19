import type { QueryRunner } from "typeorm";

/**
 * 清理「本体已经被删掉、数据还留着」的孤儿（2026-10-12）。
 *
 * 前因：`deleteOntology` 原先只删 `ontologies` + `graph_targets` + 磁盘目录，版本、概念检索索引、
 * 物化任务历史、问答历史都留在库里 —— 一个本体删掉就留一堆孤儿（库里真查出 3 个已删本体的 14 个版本
 * + 840 条 concepts）。级联那半已经在 `purgeTargetData` 里补齐，这一支只是**把已经攒下的清掉**。
 *
 * 判据：`target_id` 既不在 `graph_targets` 里、也不是内置虚拟目标（虚拟根资源没有 FK 行，见 `managedTargetId`）。
 * 内置目标的 id 在这里**写死字面量**而不是 import 常量 —— 迁移是历史，不能再随时跟着代码变。
 * 幂等：再跑一次没有可删的行；`audit_entries` 一律不动（删本体这件事本身要留痕）。
 */
const VIRTUAL_ROOT_TARGET_ID = "00000000-0000-4000-8000-000000000100";

export class OrphanTargetCleanup0010 {
  name = "OrphanTargetCleanup0010";

  async up(queryRunner: QueryRunner): Promise<void> {
    const orphan = (column: string) =>
      `${column} IS NOT NULL AND ${column} NOT IN (SELECT id FROM ontology_platform.graph_targets) AND ${column} <> '${VIRTUAL_ROOT_TARGET_ID}'`;
    // 顺序：消息挂在会话上先删；概念索引虽然按版本重建，两个都按 target 删，互不依赖。
    await queryRunner.query(`DELETE FROM ontology_platform.reasoning_messages WHERE conversation_id IN (SELECT id FROM ontology_platform.reasoning_conversations WHERE ${orphan("target_id")})`);
    await queryRunner.query(`DELETE FROM ontology_platform.reasoning_conversations WHERE ${orphan("target_id")}`);
    await queryRunner.query(`DELETE FROM ontology_platform.ontology_concepts WHERE ${orphan("target_id")}`);
    await queryRunner.query(`DELETE FROM ontology_platform.ontology_versions WHERE ${orphan("target_id")}`);
    await queryRunner.query(`DELETE FROM ontology_platform.embedded_graphs WHERE ${orphan("target_id")}`);
    await queryRunner.query(`DELETE FROM ontology_platform.materialization_jobs WHERE ${orphan("target_id")}`);
  }
}
