import { describe, expect, it } from "vitest";
import type { ObjectIndex, ObjectIndexEntry, ObjectIndexKind, ObjectIndexLink } from "@/lib/framework/object-index/types";

/**
 * **对象检索索引的后端契约**。
 *
 * 为什么单独抽一份：`ObjectIndex` 是"换后端只换实现"的那层抽象，但抽象本身不会说话 ——
 * 语义（upsert 不新增、prune 只留这一批、按对象键读、总数精确、过滤算子怎么解释……）
 * 只有跑一遍才知道。这份用例跟 PostgreSQL 无关，任何实现（PG / ES / OpenSearch）都应该跑过它。
 *
 * 用法：新后端写完后加一个 `<后端>.contract.test.ts`，把 `createIndex` 换成自己的实现即可。
 * 现在只有 ClickHouse 一个实例，它在 `clickhouse.contract.test.ts` 里跑（需要 `CLICKHOUSE_URL`）。
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

    /**
     * 来源隔离（2026-10-12 用户口径）：手工/动作建的对象（SNAPSHOT）与整份物化的对象（MATERIALIZED）
     * 必须互不覆盖 —— 发布与「重建索引」只替换 SNAPSHOT，不许把物化数据清掉。
     */
    it("来源隔离：SNAPSHOT 的 prune 与整体替换都不动 MATERIALIZED 的行", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("m1"), entry("m2")], { origin: "MATERIALIZED" });
        await index.syncTargetObjects(target, [entry("s1")], { origin: "SNAPSHOT", prune: true });
        expect((await index.stats(target)).entries).toBe(3);

        const replaced = await index.replaceTargetObjects(target, [entry("s9")], { origin: "SNAPSHOT" });
        expect(replaced.indexed).toBe(1);
        expect((await index.stats(target)).entries).toBe(3);
        expect(await index.readObject(target, entry("m1").objectKey)).not.toBeNull();
        expect(await index.readObject(target, entry("s1").objectKey)).toBeNull();
        expect(await index.readObject(target, entry("s9").objectKey)).not.toBeNull();
      });
    });

    /*
     * 整份物化是「一个对象类型一批」跑的：带 `pruneLabel` 的 prune 只能在这个类型里生效，
     * 不然物化 A 会把 B 的物化数据一起删掉（2026-10-12 真踩过 —— 索引里最后只剩最近物化的那一个类型，
     * 对象页与图谱看着就是空的）。
     */
    it("prune:true + pruneLabel 只删这个对象类型，别的类型原样留着", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(
          target,
          [
            entry("a1", { entityType: "类型A", labels: ["类型A"], objectKey: "[\"类型A\",\"CUST_ID=a1\"]" }),
            entry("a2", { entityType: "类型A", labels: ["类型A"], objectKey: "[\"类型A\",\"CUST_ID=a2\"]" }),
            entry("b1", { entityType: "类型B", labels: ["类型B"], objectKey: "[\"类型B\",\"CUST_ID=b1\"]" }),
          ],
          { origin: "MATERIALIZED" },
        );
        // 物化「类型A」只留 a2：b1 必须活着。
        const pruned = await index.syncTargetObjects(
          target,
          [entry("a2", { entityType: "类型A", labels: ["类型A"], objectKey: "[\"类型A\",\"CUST_ID=a2\"]" })],
          { origin: "MATERIALIZED", prune: true, pruneLabel: "类型A" },
        );
        expect(pruned.deleted).toBe(1);
        expect((await index.searchObjects({ targetId: target, labels: ["类型A"] })).total).toBe(1);
        expect((await index.searchObjects({ targetId: target, labels: ["类型B"] })).total).toBe(1);
      });
    });

    it("物化清单：记下并读回状态（含截断）", async () => {
      await withIndex(async (index, target) => {
        await index.saveMaterialization({
          targetId: target,
          entityType: "客户",
          rows: 100,
          sourceRows: 50000,
          scanned: 50000,
          folded: 0,
          truncated: true,
          pages: 100,
          completedAt: new Date().toISOString(),
        });
        const list = await index.listMaterializations(target);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ entityType: "客户", rows: 100, sourceRows: 50000, scanned: 50000, folded: 0, truncated: true, pages: 100 });
        expect(list[0].completedAt).toBeTruthy();
      });
    });

    /*
     * **主键重复折叠必须报数**（2026-10-13）：源里 1000 行、按主键去重后只有 800 个对象，
     * 折叠掉的 200 行要能记下、读回 —— 静默折叠会让用户以为「源里就这么多」。
     */
    it("物化清单：折叠掉的行数记下并读回", async () => {
      await withIndex(async (index, target) => {
        await index.saveMaterialization({
          targetId: target,
          entityType: "客户",
          rows: 800,
          sourceRows: 1000,
          scanned: 1000,
          folded: 200,
          truncated: false,
          pages: 2,
          completedAt: new Date().toISOString(),
        });
        const list = await index.listMaterializations(target);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ entityType: "客户", rows: 800, sourceRows: 1000, scanned: 1000, folded: 200, truncated: false });
      });
    });

    it("countTypeObjects：只数这个对象类型，并能按来源收窄", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetObjects(target, [entry("1"), entry("2")], { origin: "MATERIALIZED" });
        await index.syncTargetObjects(target, [entry("9", { entityType: "账户", labels: ["账户"] })], { origin: "MATERIALIZED" });
        await index.syncTargetObjects(target, [entry("7")], { origin: "SNAPSHOT" });
        expect(await index.countTypeObjects(target, "客户", { origin: "MATERIALIZED" })).toBe(2);
        expect(await index.countTypeObjects(target, "账户", { origin: "MATERIALIZED" })).toBe(1);
        expect(await index.countTypeObjects(target, "客户", { origin: "SNAPSHOT" })).toBe(1);
        // 不传 origin 时按整份物化算（物化对账用的就是这一档）。
        expect(await index.countTypeObjects(target, "客户")).toBe(2);
      });
    });

    /* ------------------------------------------------------------------
     * 关系（边）。唯一键 = (关系类型, 起点对象键, 终点对象键)；关系类型双向，一条边只存一行。
     * ------------------------------------------------------------------ */
    const link = (id: string, overrides: Partial<ObjectIndexLink> = {}): ObjectIndexLink => ({
      relationshipType: overrides.relationshipType ?? "客户拥有账户",
      relationshipTypeId: overrides.relationshipTypeId ?? "rel-1",
      source: overrides.source ?? { entityType: "客户", objectKey: `["客户","CUST_ID=${id}"]`, objectId: `c-${id}` },
      target: overrides.target ?? { entityType: "账户", objectKey: `["账户","ACCT_ID=${id}"]`, objectId: `a-${id}` },
      properties: overrides.properties ?? {},
    });

    it("边：写进去能按对象键（任一端）和关系类型查回来", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetLinks(target, [link("1"), link("2")], { origin: "MATERIALIZED" });
        expect((await index.searchLinks({ targetId: target })).total).toBe(2);
        // 起点侧命中：只有第 1 条
        const bySource = await index.searchLinks({ targetId: target, nodeKeys: [link("1").source.objectKey] });
        expect(bySource.links.map((item) => item.target.objectKey)).toEqual([link("1").target.objectKey]);
        // 终点侧也命中（关系类型是双向的，一条边只存一行）
        const byTarget = await index.searchLinks({ targetId: target, nodeKeys: [link("2").target.objectKey] });
        expect(byTarget.total).toBe(1);
        // 按关系类型筛
        expect((await index.searchLinks({ targetId: target, relationshipTypes: ["客户拥有账户"] })).total).toBe(2);
        expect((await index.searchLinks({ targetId: target, relationshipTypes: ["别的类型"] })).total).toBe(0);
        // 同一个键再写一次是 upsert，不是新增
        await index.syncTargetLinks(target, [link("1", { properties: { SINCE: "2026" } })], { origin: "MATERIALIZED" });
        const again = await index.searchLinks({ targetId: target });
        expect(again.total).toBe(2);
        expect(again.links.find((item) => item.target.objectId === "a-1")?.properties.SINCE).toBe("2026");
      });
    });

    it("边：prune 只删这个关系类型，别的类型的边原样留着", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetLinks(
          target,
          [link("1"), link("2"), link("9", { relationshipType: "别的类型" })],
          { origin: "MATERIALIZED" },
        );
        const pruned = await index.syncTargetLinks(target, [link("2")], {
          origin: "MATERIALIZED",
          prune: true,
          pruneRelationshipType: "客户拥有账户",
        });
        expect(pruned.deleted).toBe(1);
        expect((await index.searchLinks({ targetId: target, relationshipTypes: ["客户拥有账户"] })).total).toBe(1);
        expect((await index.searchLinks({ targetId: target, relationshipTypes: ["别的类型"] })).total).toBe(1);
      });
    });

    it("边：deleteRelationshipLinks 只删这个关系类型，stats 能报出边数", async () => {
      await withIndex(async (index, target) => {
        await index.syncTargetLinks(target, [link("1"), link("2"), link("9", { relationshipType: "别的类型" })], { origin: "MATERIALIZED" });
        expect((await index.stats(target)).links).toBe(3);
        const deleted = await index.deleteRelationshipLinks(target, "客户拥有账户");
        expect(deleted).toBe(2);
        const stats = await index.stats(target);
        expect(stats.links).toBe(1);
        expect(stats.byRelationship.find((item) => item.label === "别的类型")?.count).toBe(1);
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
        expect(stats.byLabelOrigin.find((item) => item.label === "客户" && item.origin === "SNAPSHOT")?.count).toBe(2);
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
