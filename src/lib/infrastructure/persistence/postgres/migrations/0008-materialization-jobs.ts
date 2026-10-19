import type { QueryRunner } from "typeorm";

/**
 * 整份物化的后台任务历史表。
 *
 * 物化一个对象类型可能跑很久，任务状态只放内存的话进程一重启就什么都看不见了：
 * 这张表存状态与进度（scanned / rows / pages / truncated / message），启动时把遗留的
 * QUEUED / RUNNING 标成 INTERRUPTED（物化幂等，重新排队即可）。
 */
export class MaterializationJobs0008 {
  name = "MaterializationJobs0008";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.materialization_jobs (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        status TEXT NOT NULL,
        scanned BIGINT NOT NULL DEFAULT 0,
        rows BIGINT NOT NULL DEFAULT 0,
        pages INTEGER NOT NULL DEFAULT 0,
        truncated BOOLEAN NOT NULL DEFAULT FALSE,
        message TEXT,
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_by TEXT
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS materialization_jobs_target_idx ON ontology_platform.materialization_jobs (target_id, queued_at DESC)`,
    );
  }
}
