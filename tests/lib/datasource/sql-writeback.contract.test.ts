import { describe, expect, it } from "vitest";
import { getDataSource, openDataSource } from "@/lib/datasource/sources";

/**
 * 写回的**真库契约**（默认跳过）。
 *
 * 连接器那一半（`updateRows`）不能只靠单测：语句是不是真能发下去、Oracle 的绑定参数认不认、
 * 事务有没有提交、回读对不对得上 —— 只有真库答得了。**这个用例只做"写同值"的原地写**：
 * 它会真的发一条 UPDATE 并提交，但赋的是这一列当前的值，数据一个字节都不变；
 * 唯一的例外是"键不唯一"那条 —— 连接器在**发语句之前**就拒绝，所以也不会改到任何行。
 *
 * 跑法（需要平台库 + 一个可写的关系库数据资源）：
 *   WRITEBACK_CONTRACT_DATA_SOURCE=<数据资源 id> \
 *   node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/lib/datasource/sql-writeback.contract.test.ts
 * 可选：WRITEBACK_CONTRACT_TABLE=GISTOOLS.TB_DIC_AREA_CODE（默认就是它）。
 */
const DATA_SOURCE_ID = process.env.WRITEBACK_CONTRACT_DATA_SOURCE ?? "";
const TABLE = process.env.WRITEBACK_CONTRACT_TABLE ?? "GISTOOLS.TB_DIC_AREA_CODE";
const [SCHEMA, ...REST] = TABLE.split(".");
const NAME = REST.join(".");

const enabled = Boolean(DATA_SOURCE_ID && process.env.DATABASE_URL);

describe.runIf(enabled)("写回：真库契约（原地写同值，不改数据）", () => {
  it("按键改一行：语句能发下去、事务提交、回读对得上", async () => {
    const record = await getDataSource(DATA_SOURCE_ID);
    expect(record, "数据资源不存在").toBeTruthy();
    const connector = await openDataSource(record!);
    expect(typeof connector.updateRows, "这个连接器没有实现写回").toBe("function");

    const view = { schema: SCHEMA, name: NAME };
    const page = await connector.selectRows!({ view, limit: 1 });
    expect(page.rows.length, `表 ${TABLE} 里没有数据可测`).toBeGreaterThan(0);
    const row = page.rows[0];
    const columns = Object.keys(row).filter((column) => row[column] !== null && row[column] !== undefined);
    // 挑一个"看起来像主键"的列做键：优先名字带 ID / CODE 的。
    const keyColumn = columns.find((column) => /(^|_)(ID|CODE|NO)$/i.test(column)) ?? columns[0];
    const valueColumn = columns.find((column) => column !== keyColumn);
    expect(keyColumn, "这一行没有可当键的列").toBeTruthy();
    expect(valueColumn, "这一行没有第二列可以写").toBeTruthy();

    const result = await connector.updateRows!({
      view,
      keys: [{ column: keyColumn!, value: row[keyColumn!] }],
      assignments: [{ column: valueColumn!, value: row[valueColumn!] }],
    });
    expect(result.affected).toBe(1);
    expect(result.statement.toUpperCase()).toContain("UPDATE ");
    // 旧值就是当前值（我们写的就是它），说明回读这一趟真的读到了那一行。
    expect(String(result.before[valueColumn!]).trim()).toBe(String(row[valueColumn!]).trim());
  }, 60_000);

  it("键命中 0 行：拒绝写，并说清没找到这一行", async () => {
    const record = await getDataSource(DATA_SOURCE_ID);
    const connector = await openDataSource(record!);
    const view = { schema: SCHEMA, name: NAME };
    const page = await connector.selectRows!({ view, limit: 1 });
    const columns = Object.keys(page.rows[0] ?? {});
    const keyColumn = columns.find((column) => /(^|_)(ID|CODE|NO)$/i.test(column)) ?? columns[0];
    const valueColumn = columns.find((column) => column !== keyColumn)!;
    await expect(connector.updateRows!({
      view,
      keys: [{ column: keyColumn, value: "__WRITEBACK_CANNOT_EXIST__" }],
      assignments: [{ column: valueColumn, value: "__never__" }],
    })).rejects.toThrow(/没找到这一行/);
  }, 60_000);

  it("键命中多行：拒绝写（键不唯一会改到别人的行）", async () => {
    const record = await getDataSource(DATA_SOURCE_ID);
    const connector = await openDataSource(record!);
    const view = { schema: SCHEMA, name: NAME };
    const page = await connector.selectRows!({ view, limit: 300 });
    const columns = Object.keys(page.rows[0] ?? {});
    // 找一个"有重复值"的列 —— 拿它当键就必然命中多行。
    const duplicated = columns.find((column) => {
      const seen = new Map<string, number>();
      for (const row of page.rows) {
        const value = row[column];
        if (value === null || value === undefined || String(value).trim() === "") continue;
        const key = String(value).trim();
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return [...seen.values()].some((count) => count > 1);
    });
    if (!duplicated) return; // 这张表每列都唯一，测不了这条 —— 不假装测过。
    const duplicateValue = (() => {
      const counts = new Map<string, number>();
      for (const row of page.rows) {
        const value = row[duplicated];
        if (value === null || value === undefined) continue;
        const key = String(value).trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].find(([, count]) => count > 1)![0];
    })();
    const valueColumn = columns.find((column) => column !== duplicated)!;
    await expect(connector.updateRows!({
      view,
      keys: [{ column: duplicated, value: duplicateValue }],
      assignments: [{ column: valueColumn, value: "__never__" }],
    })).rejects.toThrow(/键不唯一/);
  }, 60_000);
});
