import { describe, expect, it } from "vitest";
import { getTarget } from "@/lib/platform/targets";
import { listVersionRecords } from "@/lib/versioning/snapshot";
import { executeOntologySql, toQueryDsl } from "@/lib/query-dsl";
import { entitySources } from "@/lib/ontology/sources";

/**
 * 本体 SQL 的**真库契约**（默认跳过）。
 *
 * 单测里的执行链用的是假连接器；这一份跑在**真实本体 + 真实数据资源**上：
 * 从库里捞出已发布版本，挑一个"绑了数据源、且有属性映射到列"的对象类型，
 * 用本体 SQL 查几行真数据回来 —— 证明"表层 SQL → 绑定 → 编译 → 只读执行"整条路是通的。
 *
 * 跑法：
 *   QUERY_SQL_CONTRACT_TARGET=<targetId> node --env-file=.env.local ./node_modules/vitest/vitest.mjs \
 *     run tests/lib/query-dsl/ontology-sql.contract.test.ts
 * 只读：这里只发 SELECT。
 */
const TARGET = process.env.QUERY_SQL_CONTRACT_TARGET ?? "";
const enabled = Boolean(TARGET && process.env.DATABASE_URL);

describe.runIf(enabled)("本体 SQL：真库契约（真实本体 + 真实数据资源）", () => {
  it("挑一个绑了数据源的对象类型，写一句本体 SQL 就能查回真实数据", async () => {
    const target = await getTarget(TARGET);
    expect(target, "本体存储不存在").toBeTruthy();
    const records = await listVersionRecords(TARGET);
    const published = records.find((item) => item.status === "PUBLISHED") ?? records[0];
    expect(published, "这个本体还没有版本").toBeTruthy();

    // 主来源（sources[0]）必须真的绑到资源与表 / 口径上 —— 二级来源绑了不算，resolve 只查主来源。
    const entity = published!.definition.entityTypes.find((type) => {
      const primary = entitySources(type)[0];
      return Boolean(primary?.dataSourceId && (primary.view || primary.sql))
        && type.properties.some((property) => (property.sourceField ?? "").trim());
    });
    expect(entity, "这个本体里没有绑了数据源的对象类型").toBeTruthy();
    const property = entity!.properties.find((item) => (item.sourceField ?? "").trim())!;

    const sql = `SELECT ${property.name} AS 值 FROM ${entity!.name} LIMIT 3`;
    // 绑定这一层先把"这句 SQL 认成了什么"摊开，出错时能一眼看出是解析还是执行的问题。
    const query = toQueryDsl(sql, published!.definition);
    expect(query.kind).toBe("records");
    expect(query.limit).toBe(3);

    const result = await executeOntologySql(published!.definition, sql);
    expect(result.statement.toUpperCase()).toContain("SELECT");
    expect(result.columns).toEqual(["值"]);
    expect(result.returned).toBeLessThanOrEqual(3);
    expect(result.row_limit).toBe(3);
    // 只读：这条路上不存在写语句的可能，语句里不许出现 DML 关键字。
    expect(/insert|update|delete|drop|truncate/i.test(result.statement)).toBe(false);
  }, 120_000);

  it("认不出的属性在真本体上同样被拦住（带候选）", async () => {
    const records = await listVersionRecords(TARGET);
    const published = records.find((item) => item.status === "PUBLISHED") ?? records[0];
    const entity = published!.definition.entityTypes.find((type) => {
      const primary = entitySources(type)[0];
      return Boolean(primary?.dataSourceId && (primary.view || primary.sql));
    })!;
    await expect(executeOntologySql(published!.definition, `SELECT 不存在的属性 FROM ${entity.name}`)).rejects.toThrow(/认不出「不存在的属性」/);
  }, 120_000);
});
