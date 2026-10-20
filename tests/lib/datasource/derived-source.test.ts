import { DataSource } from "typeorm";
import { describe, expect, it } from "vitest";
import { derivedCountStatement, derivedRowsStatement } from "@/lib/shared/server/sql-guard";

/**
 * **取数口径当来源**（对象类型的 `DERIVED` 来源）：纯函数部分永远跑，真库冒烟要 `DATABASE_URL`。
 *
 * 口径用 `VALUES` 写，不需要建表就能验整条路：过滤 / 排序 / 翻页 / 总数 / 只读闸门。
 * 真库那一批跟 ClickHouse 契约测试一个套路：
 *
 *   node --env-file=.env.local ./node_modules/vitest/vitest.mjs run tests/lib/datasource/derived-source.test.ts
 *
 * 只读查询、不写任何表，不会碰你正在用的本体。
 */
const url = process.env.DATABASE_URL;

/** 典型口径：同一个 user_id 有多行，按业务键去重取一行。 */
const DERIVED = `
  SELECT user_id, MAX(user_name) AS user_name
    FROM (VALUES ('u1','张三'),('u1','张三丰'),('u2','李四')) AS s(user_id, user_name)
   GROUP BY user_id
`;

describe("取数口径当来源：语句生成（纯函数）", () => {
  it("PostgreSQL：值与列都进不了字面量，占位符是 $n", () => {
    const built = derivedRowsStatement(
      "POSTGRES",
      DERIVED,
      { columns: ["user_id", "user_name"], filters: [{ column: "user_id", operator: "EQ", value: "u1" }] },
      11,
    );
    expect(built.statement).toContain('"t"."user_id"');
    expect(built.statement).toContain('"t"."user_id" = $1');
    expect(built.statement).toContain("LIMIT 11 OFFSET 0");
    expect(built.params).toEqual(["u1"]);
    expect(built.skip).toBe(0);
  });

  it("MySQL：占位符是 ?，值与列同样不拼字面量", () => {
    const built = derivedRowsStatement("MYSQL", DERIVED, { filters: [{ column: "user_id", operator: "IN", value: ["u1", "u2"] }] }, 5);
    expect(built.statement).toContain("`t`.`user_id` IN (?, ?)");
    expect(built.params).toEqual(["u1", "u2"]);
  });

  it("Oracle：没有 OFFSET，用 ROWNUM 多读几行、由 skip 在内存里丢掉", () => {
    const built = derivedRowsStatement("ORACLE", DERIVED, { filters: [{ column: "user_id", operator: "EQ", value: "u1" }], offset: 20 }, 10);
    expect(built.statement).toContain('"t"."user_id" = :1');
    expect(built.statement).toContain("WHERE ROWNUM <= 30");
    expect(built.params).toEqual({ "1": "u1" });
    expect(built.skip).toBe(20);
  });

  it("游标翻页：条件与结构化取行同一口径（位置占位符不能复用，所以 after 的值绑两次）", () => {
    const built = derivedRowsStatement("POSTGRES", DERIVED, { orderBy: ["user_id", "user_name"], after: ["u1", "张三"] }, 10);
    // 语义 = `(k0 > a) OR (k0 = a AND k1 > b)`；和 QueryBuilder 那条路等价（那里用的是可复用的具名参数）。
    expect(built.statement).toContain('("t"."user_id" > $1 OR "t"."user_id" = $2 AND "t"."user_name" > $3)');
    expect(built.params).toEqual(["u1", "u1", "张三"]);
  });

  it("数值比较、空值判断与业务排序都下推到口径外层", () => {
    const built = derivedRowsStatement("POSTGRES", DERIVED, {
      filters: [
        { column: "score", operator: "GT", value: 80 },
        { column: "status", operator: "EXISTS" },
      ],
      sort: [{ column: "score", direction: "DESC" }],
    }, 10);
    expect(built.statement).toContain('"t"."score" > $1');
    expect(built.statement).toContain('"t"."status" IS NOT NULL');
    expect(built.statement).toContain('ORDER BY "t"."score" DESC');
    expect(built.params).toEqual([80]);
  });

  it("只读闸门：写语句直接拒掉（口径不许带写操作）", () => {
    expect(() => derivedRowsStatement("POSTGRES", "DELETE FROM t_user", {}, 10)).toThrow(/只读/);
    expect(() => derivedCountStatement("POSTGRES", "DROP TABLE t_user", {})).toThrow(/只读/);
  });
});

describe("取数口径当来源：真库冒烟（PostgreSQL）", () => {
  it.skipIf(!url)("口径能去重、能过滤、能排序、能数总数", async () => {
    const ds = new DataSource({ type: "postgres", url });
    await ds.initialize();
    const runner = ds.createQueryRunner();
    try {
      const rows = derivedRowsStatement("POSTGRES", DERIVED, { columns: ["user_id", "user_name"], orderBy: ["user_id"] }, 10);
      const list = (await runner.query(rows.statement, rows.params)) as Record<string, unknown>[];
      expect(list.map((row) => row.user_id)).toEqual(["u1", "u2"]);
      expect(list[0].user_name).toBe("张三丰");

      const filtered = derivedRowsStatement("POSTGRES", DERIVED, { filters: [{ column: "user_id", operator: "EQ", value: "u2" }] }, 10);
      const only = (await runner.query(filtered.statement, filtered.params)) as Record<string, unknown>[];
      expect(only).toHaveLength(1);
      expect(only[0].user_name).toBe("李四");

      const counted = derivedCountStatement("POSTGRES", DERIVED, {});
      const total = (await runner.query(counted.statement, counted.params)) as Record<string, unknown>[];
      expect(Number(Object.values(total[0])[0])).toBe(2);
    } finally {
      await runner.release();
      await ds.destroy();
    }
  });
});
