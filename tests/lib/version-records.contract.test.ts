import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { platformRepo } from "@/lib/platform/db";
import { OntologyConceptEntity } from "@/lib/platform/db/entities";
import {
  deleteTargetVersionRecords,
  deleteVersionRecordRow,
  getVersionRecordRow,
  insertVersionRecordRow,
  listVersionRecordRows,
  replaceVersionConcepts,
  updateVersionRecordRow,
} from "@/lib/platform/version-records";

/**
 * 版本记录的**契约测试**：要连真平台库。
 *
 *   pnpm test:version-store
 *   # = node --env-file=.env.local vitest run tests/lib/version-records.contract.test.ts
 *
 * `pnpm test`（不带 DATABASE_URL）时整块跳过 —— 和 `tests/lib/object-index/postgres.contract.test.ts` 一个套路。
 * 用随机 targetId / versionId，跑完自己删干净。
 */
const databaseUrl = process.env.DATABASE_URL;

const targetId = randomUUID();
const ids = [randomUUID(), randomUUID()];

const definition: OntologyDefinition = ontologyDefinitionSchema.parse({
  groups: [{ id: randomUUID(), name: "客户域" }],
  entityTypes: [{ id: randomUUID(), name: "客户", properties: [{ name: "customer_id", dataType: "TEXT" }] }],
});

afterAll(async () => {
  if (!databaseUrl) return;
  await deleteTargetVersionRecords(targetId);
});

describe.skipIf(!databaseUrl)("版本记录（平台库）", () => {
  it("写入后能读回来，定义 / 快照 / 计数 / 哈希一致", async () => {
    const created = await insertVersionRecordRow({
      id: ids[0],
      targetId,
      versionNumber: 1,
      createdBy: "user-test",
      definition,
      snapshot: { nodes: [], relationships: [] },
      entityCount: 0,
      relationshipCount: 0,
      contentHash: "hash-1",
    });
    expect(created.status).toBe("DRAFT");
    expect(created.definition.entityTypes[0].name).toBe("客户");

    const fetched = await getVersionRecordRow(ids[0]);
    expect(fetched?.target_id).toBe(targetId);
    expect(fetched?.content_hash).toBe("hash-1");
    expect(fetched?.snapshot).toEqual({ nodes: [], relationships: [] });
  });

  it("列表按版本号倒序", async () => {
    await insertVersionRecordRow({ id: ids[1], targetId, versionNumber: 2, createdBy: "user-test", definition });
    const rows = await listVersionRecordRows(targetId);
    expect(rows.map((row) => row.version_number)).toEqual([2, 1]);
  });

  it("更新状态与哈希生效", async () => {
    const updated = await updateVersionRecordRow(ids[0], { status: "PUBLISHED", publishedAt: new Date().toISOString(), contentHash: "hash-2" });
    expect(updated?.status).toBe("PUBLISHED");
    expect(updated?.content_hash).toBe("hash-2");
    expect(updated?.published_at).toBeTruthy();
  });

  it("概念索引先删后插，重复写不会翻倍", async () => {
    const first = await replaceVersionConcepts(ids[0], targetId, definition);
    expect(first).toBeGreaterThan(0);
    const repo = await platformRepo(OntologyConceptEntity);
    const before = await repo.count({ where: { versionId: ids[0] } });
    expect(before).toBe(first);

    await replaceVersionConcepts(ids[0], targetId, definition);
    const after = await repo.count({ where: { versionId: ids[0] } });
    expect(after).toBe(before);
  });

  it("概念表带全文列，且能按词检索到（库支持时）", async () => {
    const columns = await platformRepo(OntologyConceptEntity);
    void columns;
    const runner = (await platformRepo(OntologyConceptEntity)).manager.connection.createQueryRunner();
    try {
      const rows = (await runner.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema = 'ontology_platform' AND table_name = 'ontology_concepts' AND column_name = 'search_doc'`,
      )) as { n: number }[];
      // search_doc 是「库支持 pg_trgm / tsvector 时才有」的生成列：没有就跳过检索断言。
      if (!rows[0]?.n) return;
      const hits = (await runner.query(
        `SELECT count(*)::int AS n FROM ontology_platform.ontology_concepts
          WHERE version_id = $1 AND search_doc @@ to_tsquery('simple', $2)`,
        [ids[0], "customer_id"],
      )) as { n: number }[];
      expect(hits[0].n).toBeGreaterThan(0);
    } finally {
      await runner.release();
    }
  });

  it("删单个版本后读不到", async () => {
    await deleteVersionRecordRow(ids[0]);
    expect(await getVersionRecordRow(ids[0])).toBeNull();
  });
});

if (!databaseUrl) {
  describe("版本记录（平台库）", () => {
    it.skip("需要 DATABASE_URL：用 `pnpm test:version-store` 跑完整契约", () => {});
  });
}
