import { describe, expect, it } from "vitest";
import type { ObjectIndex, ObjectIndexEntry, ObjectIndexKind } from "@/lib/object-index/types";

/**
 * **对象检索索引的后端契约**。
 *
 * 为什么单独抽一份：`ObjectIndex` 是"换后端只换实现"的那层抽象，但抽象本身不会说话 ——
 * 语义（upsert 不新增、prune 只留这一批、按对象键读、总数精确、过滤算子怎么解释……）
 * 只有跑一遍才知道。这份用例跟 PostgreSQL 无关，任何实现（PG / ES / OpenSearch）都应该跑过它。
 *
 * 用法：新后端写完后加一个 `<后端>.contract.test.ts`，把 `createIndex` 换成自己的实现即可。
 * 现在只有 PostgreSQL 一个实例，它在 `postgres.contract.test.ts` 里跑（需要 `DATABASE_URL`）。
 *
 * 约定：**每个用例一个全新 `targetId`**，前后端之间、用例之间互不干扰；跑完自己清干净。
 */
export type ObjectIndexContractOptions = {
  /** 用例名字里带的后端名（同一个后端可以多实例跑）。 */
  label: string;
  kind: ObjectIndexKind;
  createIndex: () => ObjectIndex;
  /** 每个用例一个隔离的 target id（后端之间、用例之间不互相踩）。 */
  targetId: () => string;
};

export function runObjectIndexContract(options: ObjectIndexContractOptions) {
  const { label, kind, createIndex, targetId } = options;

  /** 造一条索引条目：默认值是"客户 CUST_ID=<id>"，用例只覆盖关心的字段。 */
  const entry = (objectId: string, overrides: Partial<ObjectIndexEntry> = {}): ObjectIndexEntry => {
    const properties = overrides.properties ?? { CUST_ID: objectId, AREA_NAME: "郑州" };
    const title = overrides.title ?? `客户 ${objectId}`;
    return {
      objectId,
      entityType: overrides.entityType ?? "客户",
      objectKey: overrides.objectKey ?? `["客户","CUST_ID=${objectId}"]`,
      labels: overrides.labels ?? ["客户"],
      title,
      properties,
      primaryKey: overrides.primaryKey ?? { CUST_ID: objectId },
      searchText: overrides.searchText ?? `${title} ${Object.values(properties).join(" ")}`,
      embedding: overrides.embedding ?? null,
    };
  };

  /** 每个用例都在自己的 target 上跑，跑完（无论成败）清掉。 */
  const withIndex = async (job: (index: ObjectIndex, target: string) => Promise<void>) => {
    const index = createIndex();
    const target = targetId();
    try {
      await job(index, target);
    } finally {
      await index.deleteTargetObjects(target).catch(() => undefined);
    }
  };

  describe(`对象索引后端契约 · ${label}`, () => {
    it("实现自报的 kind 与契约一致", () => {
      expect(createIndex().kind).toBe(kind);
    });

    it("写入后能按对象键读回；没写过的键返回 null", async () => {
      await withIndex(async (index, target) => {
        const rows = [entry("1"), entry("2"), entry("3")];
        const synced = await index.syncTargetObjects(target, rows);
        expect(synced.upserted).toBe(3);
        expect(synced.total).toBe(3);

        const hit = await index.readObject(target, rows[0].objectKey);
        expect(hit?.objectId).toBe("1");
        expect(hit?.title).toBe("客户 1");
        expect(hit?.properties).toMatchObject({ CUST_ID: "1" });
        expect(hit?.primaryKey).toMatchObject({ CUST_ID: "1" });
        expect(hit?.entityType).toBe("客户");
        expect(await index.readObject(target, '["客户","CUST_ID=不存在"]')).toBeNull();
      });
    });

    it("同一个对象键再写一次是 upsert，不是新增", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1", { title: "旧标题" })]);
        const again = await index.syncTargetObjects(target, [entry("1", { title: "新标题" })]);
        expect(again.total).toBe(1);
        expect((await index.readObject(target, entry("1").objectKey))?.title).toBe("新标题");
      });
    });

    it("prune:true 只留下这一批（没出现的键被删掉）", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1"), entry("2"), entry("3")]);
        const pruned = await index.syncTargetObjects(target, [entry("2")], { prune: true });
        expect(pruned.deleted).toBe(2);
        expect(pruned.total).toBe(1);
        expect(await index.readObject(target, entry("1").objectKey)).toBeNull();
        expect(await index.readObject(target, entry("2").objectKey)).not.toBeNull();
      });
    });

    it("prune:false 只增不删", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1")]);
        const merged = await index.syncTargetObjects(target, [entry("2")], { prune: false });
        expect(merged.deleted).toBe(0);
        expect(merged.total).toBe(2);
      });
    });

    it("deleteObjects 按对象键删，返回实际删除条数", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1"), entry("2"), entry("3")]);
        const deleted = await index.deleteObjects(target, [entry("1").objectKey, entry("3").objectKey, "不存在的键"]);
        expect(deleted).toBe(2);
        expect((await index.stats(target)).entries).toBe(1);
      });
    });

    it("replaceTargetObjects 是整体替换（旧的键不再存在）", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1"), entry("2")]);
        const replaced = await index.replaceTargetObjects(target, [entry("7"), entry("8"), entry("9")]);
        expect(replaced.indexed).toBe(3);
        expect((await index.stats(target)).entries).toBe(3);
        expect(await index.readObject(target, entry("1").objectKey)).toBeNull();
        expect(await index.readObject(target, entry("9").objectKey)).not.toBeNull();
      });
    });

    it("检索：按标签过滤，总数是精确值", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [
          entry("1", { labels: ["客户"], entityType: "客户" }),
          entry("2", { labels: ["客户"], entityType: "客户" }),
          entry("3", { labels: ["账户"], entityType: "账户" }),
        ]);
        const clients = await index.searchObjects({ targetId: target, labels: ["客户"] });
        expect(clients.total).toBe(2);
        expect(clients.hits).toHaveLength(2);
        expect(clients.hits.every((hit) => hit.labels.includes("客户"))).toBe(true);
      });
    });

    it("检索：分页不改总数，翻页不重不漏", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, ["1", "2", "3", "4", "5"].map((id) => entry(id)));
        const first = await index.searchObjects({ targetId: target, labels: ["客户"], limit: 2, offset: 0 });
        const second = await index.searchObjects({ targetId: target, labels: ["客户"], limit: 2, offset: 2 });
        const third = await index.searchObjects({ targetId: target, labels: ["客户"], limit: 2, offset: 4 });
        expect(first.total).toBe(5);
        expect(second.total).toBe(5);
        expect([...first.hits, ...second.hits, ...third.hits]).toHaveLength(5);
        const seen = new Set([...first.hits, ...second.hits, ...third.hits].map((hit) => hit.objectId));
        expect(seen.size).toBe(5);
      });
    });

    it("检索：属性算子 EQ / IN / CONTAINS / EXISTS", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [
          entry("1", { properties: { CUST_ID: "1", LEVEL: "A", AREA_NAME: "郑州" } }),
          entry("2", { properties: { CUST_ID: "2", LEVEL: "B", AREA_NAME: "信阳" } }),
          entry("3", { properties: { CUST_ID: "3", LEVEL: "A" } }),
        ]);
        const eq = await index.searchObjects({ targetId: target, labels: ["客户"], filters: [{ property: "LEVEL", operator: "EQ", value: "A" }] });
        expect(eq.total).toBe(2);
        const inClause = await index.searchObjects({ targetId: target, labels: ["客户"], filters: [{ property: "LEVEL", operator: "IN", value: ["A", "B"] }] });
        expect(inClause.total).toBe(3);
        const contains = await index.searchObjects({ targetId: target, labels: ["客户"], filters: [{ property: "AREA_NAME", operator: "CONTAINS", value: "信" }] });
        expect(contains.total).toBe(1);
        const exists = await index.searchObjects({ targetId: target, labels: ["客户"], filters: [{ property: "AREA_NAME", operator: "EXISTS" }] });
        expect(exists.total).toBe(2);
      });
    });

    it("检索：关键字命中标题/属性里的词（没有全文能力时如实报 none）", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [
          entry("1", { title: "CONTRACTTOKEN7788 的客户" }),
          entry("2", { title: "另一个客户" }),
        ]);
        const capabilities = await index.capabilities();
        const found = await index.searchObjects({ targetId: target, labels: ["客户"], text: "CONTRACTTOKEN7788" });
        if (capabilities.fullText) {
          expect(found.total).toBeGreaterThanOrEqual(1);
          expect(found.hits.map((hit) => hit.objectId)).toContain("1");
          expect(["fulltext+trigram", "fulltext"]).toContain(found.textMode);
        } else {
          // 后端没有全文能力：不能假装命中，也不能报错。
          expect(found.textMode).toBe("none");
        }
      });
    });

    it("deleteTargetObjects 清空这个本体存储的索引", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1"), entry("2")]);
        await index.deleteTargetObjects(target);
        const stats = await index.stats(target);
        expect(stats.entries).toBe(0);
        expect(stats.byLabel).toEqual([]);
      });
    });

    it("stats 报得出条数与按标签分布", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [
          entry("1", { labels: ["客户"] }),
          entry("2", { labels: ["客户"] }),
          entry("3", { labels: ["账户"] }),
        ]);
        const stats = await index.stats(target);
        expect(stats.entries).toBe(3);
        expect(stats.byLabel.find((item) => item.label === "客户")?.count).toBe(2);
        expect(stats.updatedAt).toBeTruthy();
      });
    });

    it("capabilities 报的是能力布尔值，不是「后端名」", async () => {
      const capabilities = await createIndex().capabilities();
      expect(typeof capabilities.available).toBe("boolean");
      expect(typeof capabilities.fullText).toBe("boolean");
      expect(typeof capabilities.trigram).toBe("boolean");
      expect(typeof capabilities.vector).toBe("boolean");
      if (!capabilities.available) expect(capabilities.reason).toBeTruthy();
    });
  });
}
