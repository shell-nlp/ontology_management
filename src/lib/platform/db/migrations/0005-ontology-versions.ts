import type { QueryRunner } from "typeorm";

/**
 * 本体版本与**本体定义**从磁盘迁进平台库（2026-10-10 用户要求：
 * 「本体定义不要存到磁盘，要存到 PG 数据库中」）。
 *
 * 以前版本记录（`manifest.json`）和定义（`definition.json`）躺在
 * `.data/ontology-versions/<targetId>/<versionId>/`，于是同一份定义要被问答、总览、
 * 导出反复读盘 + `JSON.parse` + zod 校验（`listVersionRecords` 甚至会把每个版本的
 * definition 都读一遍，只为了挑出 PUBLISHED 那一条）。现在：
 *
 * - **定义与版本元数据进 PG**（`ontology_versions.definition` 一个 jsonb 列装整份 OntologyDefinition），
 *   这张表就是唯一权威，`listVersionRecords` 变成一次查询；
 * - 磁盘只留**实例快照** `nodes.csv` / `relationships.csv` —— 那是实例数据、可能很大、
 *   只在「激活历史版本」时读，暂不进 PG（写在 `@/lib/versioning/snapshot` 的注释里）；
 * - 顺带建 `ontology_concepts`：把定义里的概念（对象类型 / 属性 / 关系类型 / 接口 / 指标 /
 *   动作 / 规则 / 分组）拍平成一行一条，**现在只存文本**；将来做向量检索时只差
 *   「算 embedding」这一步 —— 全文列、trigram 索引、pgvector 列与 hnsw 索引由
 *   `@/lib/platform/version-records` 的 `ensureConceptSearchIndex()` 按扩展是否可用补，
 *   装不上就如实降级（和 `object_entries` 一个套路）。
 *
 * 两支 `CREATE TABLE IF NOT EXISTS` 都是幂等的；`target_id` **刻意不加外键**：
 * 删除本体存储时版本先行清理（`deleteTargetVersions`），加外键反而会让清理顺序变成硬约束。
 */
export class OntologyVersionsAndConcepts0005 {
  name = "OntologyVersionsAndConcepts0005";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.ontology_versions (
        id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        definition JSONB NOT NULL,
        snapshot JSONB,
        created_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ,
        entity_count INTEGER NOT NULL DEFAULT 0,
        relationship_count INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (target_id, version_number)
      )
    `);

    // 已经建过表的部署补这一列（实例快照 nodes + relationships）。
    await queryRunner.query(`ALTER TABLE ontology_platform.ontology_versions ADD COLUMN IF NOT EXISTS snapshot JSONB`);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ontology_versions_target_idx
        ON ontology_platform.ontology_versions (target_id, version_number DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.ontology_concepts (
        version_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        object_type TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (version_id, kind, name)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ontology_concepts_target_idx
        ON ontology_platform.ontology_concepts (target_id, kind)
    `);
  }
}
