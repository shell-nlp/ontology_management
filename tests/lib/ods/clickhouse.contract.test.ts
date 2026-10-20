import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getOdsStore } from "@/lib/infrastructure/ods";
import type { OdsTableSpec } from "@/lib/infrastructure/ods/types";
import { clickHouseConfig } from "@/lib/infrastructure/clickhouse/config";
import { clickHouseQuery } from "@/lib/infrastructure/clickhouse/client";

const clickHouseUrl = process.env.CLICKHOUSE_URL;

describe("ODS ClickHouse 契约", () => {
  it.skipIf(!clickHouseUrl)("全量原子替换、增量合并、过滤排序和删除都可用", async () => {
    const tableName = `ods_contract_${randomUUID().replace(/-/g, "")}`;
    const sourceId = `source-${randomUUID()}`;
    const spec: OdsTableSpec = {
      sourceId,
      tableName,
      primaryKeyColumns: ["ID"],
      columns: [
        { name: "ID", sourceType: "VARCHAR2(20)", clickhouseType: "String", nullable: false, primaryKey: true },
        { name: "SCORE", sourceType: "NUMBER(18)", clickhouseType: "Int64", nullable: true, primaryKey: false },
      ],
    };
    async function* rows(values: Record<string, unknown>[]) {
      for (const value of values) yield value;
    }
    const store = getOdsStore();
    try {
      await store.writeFull({ spec, rows: rows([{ ID: "A", SCORE: 10 }, { ID: "B", SCORE: 20 }, { ID: "C", SCORE: 5 }]), batchId: Date.now() });
      const first = await store.read({ sourceId, tableName, columns: ["ID", "SCORE"], filters: [], sort: [{ column: "SCORE", direction: "DESC" }], limit: 10 });
      expect(first.rows).toEqual([{ ID: "B", SCORE: 20 }, { ID: "A", SCORE: 10 }, { ID: "C", SCORE: 5 }]);
      const filtered = await store.read({ sourceId, tableName, columns: ["ID", "SCORE"], filters: [{ column: "SCORE", operator: "GT", value: 9 }], sort: [{ column: "SCORE", direction: "DESC" }], limit: 10 });
      expect(filtered.rows).toEqual([{ ID: "B", SCORE: 20 }, { ID: "A", SCORE: 10 }]);
      expect(filtered.total).toBe(2);
      await expect(store.writeFull({ spec, rows: rows([{ ID: "X", SCORE: 1 }, { ID: "X", SCORE: 2 }]), batchId: Date.now() + 10 })).rejects.toThrow(/主键不唯一/);
      expect(await store.count(spec)).toBe(3);
      const exact = await store.writeFull({ spec, rows: rows([{ ID: "A", SCORE: 10 }, { ID: "A", SCORE: 10 }, { ID: "B", SCORE: 20 }]), batchId: Date.now() + 20 });
      expect(exact).toMatchObject({ rows: 3, storedRows: 2, warnings: [expect.stringContaining("完全相同")] });
      expect(await store.count(spec)).toBe(2);
      const aggregate = await clickHouseQuery<{ total: number }>(
        `SELECT countIf(trimBoth(toString("root"."ID")) = {needle:String}) AS total FROM ${clickHouseConfig().database}.${tableName} AS "root" FINAL WHERE "root"."_source_id" = {source:String} AND "root"."_is_deleted" = 0`,
        { params: { source: sourceId, needle: "A" } },
      );
      expect(Number(aggregate[0]?.total)).toBe(1);

      await store.writeIncremental({ spec, rows: rows([{ ID: "A", SCORE: 99 }]), batchId: Date.now() + 1 });
      const updated = await store.read({ sourceId, tableName, columns: ["ID", "SCORE"], filters: [{ column: "ID", operator: "EQ", value: "A" }], limit: 10 });
      expect(updated.rows).toEqual([{ ID: "A", SCORE: 99 }]);
    } finally {
      await store.drop(sourceId, tableName).catch(() => undefined);
    }
  });
});
