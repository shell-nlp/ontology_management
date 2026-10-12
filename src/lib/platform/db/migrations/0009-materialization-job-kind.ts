import type { QueryRunner } from "typeorm";

/**
 * 物化任务补 `kind`：任务不再只物化对象类型，也要物化**关系类型**（边）。
 *
 * 老行没有这一列，默认 OBJECT_TYPE —— 那时只会物化对象类型，语义正好对上。
 * 顺带把 0008 漏掉的表 / 字段注释补上（用户要求：建库时注释必须齐全，`COMMENT ON` 本身幂等）。
 */
export class MaterializationJobKind0009 {
  name = "MaterializationJobKind0009";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE ontology_platform.materialization_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'OBJECT_TYPE'`);
    await queryRunner.query(
      `COMMENT ON TABLE ontology_platform.materialization_jobs IS '整份物化的后台任务历史：一个任务 = 一个类型（对象类型或关系类型），记录状态与进度。'`,
    );
    const comments: [string, string][] = [
      ["id", "任务 id（内存登记处与库里同 id）。"],
      ["target_id", "本体存储 id：这个任务是给哪个本体做的。"],
      ["kind", "物化对象：OBJECT_TYPE = 对象类型（节点），RELATIONSHIP_TYPE = 关系类型（边）。"],
      ["entity_type", "对象类型名或关系类型名（`kind` 决定怎么解释）。"],
      ["status", "任务状态：QUEUED / RUNNING / DONE / CANCELLED / FAILED / INTERRUPTED（进程重启遗留）。"],
      ["scanned", "从数据源读过的行数（进度；撞上限时 = 上限）。"],
      ["rows", "写进对象索引的条数（断点续跑时只是后半段）。"],
      ["pages", "读了多少页。"],
      ["truncated", "是否只物化了一部分（撞到单次上限 / 取消 / 分页卡住），半份必须报数。"],
      ["message", "结束原因 / 失败信息；正常完成为空。"],
      ["queued_at", "入队时间（列表按它倒序）。"],
      ["started_at", "开始跑的时间。"],
      ["finished_at", "结束时间（已完成 / 已取消 / 失败 / 被中断）。"],
      ["created_by", "发起人（审计用；目前留空）。"],
    ];
    for (const [column, comment] of comments) {
      await queryRunner.query(`COMMENT ON COLUMN ontology_platform.materialization_jobs.${column} IS '${comment}'`);
    }
  }
}
