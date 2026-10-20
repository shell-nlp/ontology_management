import { describe, expect, it } from "vitest";
import { compileQuerySql, parseOntologySql, resolveQueryDsl, toQueryDsl } from "@/lib/query-dsl";
import { caseDefinition, telecomCaseSql } from "./query-dsl-case.fixture";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const definition = caseDefinition();
const resolve = (sql: string, parameters = {}) => resolveQueryDsl(definition, toQueryDsl(sql, definition, parameters));
describe("CASE 条件聚合共享内核", () => {
  it("用户原 SQL 五个指标完整解析，三个源库编译器均保留条件与列顺序", () => {
    const plan = resolve(telecomCaseSql);
    expect(plan.select).toHaveLength(5);
    for (const kind of ["POSTGRES", "ORACLE", "MYSQL"] as const) {
      const result = compileQuerySql(plan, kind);
      expect(result.columns).toEqual(["状态正常用户数", "状态正常专线条数", "订购集团单位数", "数据专线用户数", "数据专线条数"]);
      expect(result.statement).toContain("COUNT(DISTINCT CASE WHEN");
      expect(result.statement).toContain("SUM(CASE WHEN");
      expect(result.statement).toContain("NOT IN");
      expect(Object.values(result.parameters)).toContain("2026-09-13");
      expect(Object.values(result.parameters)).toContain(0);
    }
  });
  it("多 WHEN 顺序、复合条件、ELSE 参数与负数均保留", () => {
    const plan = resolve("SELECT SUM(CASE WHEN ZX_FLAG = '1' AND ZX_COUNT > :min THEN ZX_COUNT WHEN ZX_FLAG IN ('2','3') THEN -1 ELSE :fallback END) AS N FROM 专线产品用户", { min: 1, fallback: 0 });
    const item = plan.select[0];
    expect(item.kind === "aggregate" && item.case?.branches).toHaveLength(2);
    const sql = compileQuerySql(plan, "POSTGRES");
    expect(sql.statement).toContain(" AND ");
    expect(Object.values(sql.parameters)).toContain(-1);
  });
  it("省略 ELSE 明确按 NULL，允许 COUNT / DISTINCT / SUM / AVG / MIN / MAX", () => {
    for (const aggregate of ["COUNT", "COUNT DISTINCT", "SUM", "AVG", "MIN", "MAX"]) {
      const call = aggregate === "COUNT DISTINCT" ? "COUNT(DISTINCT CASE WHEN ZX_FLAG = '1' THEN ZX_COUNT END)" : `${aggregate}(CASE WHEN ZX_FLAG = '1' THEN ZX_COUNT END)`;
      const plan = resolve(`SELECT ${call} AS N FROM 专线产品用户`);
      expect(plan.select[0]).toMatchObject({ case: { otherwise: { kind: "literal", value: null } } });
      expect(compileQuerySql(plan, "POSTGRES").statement).toContain("ELSE NULL END");
    }
  });
  it("分支属性、类型、参数仍走统一语义校验", () => {
    expect(() => resolve("SELECT SUM(CASE WHEN ZX_FLAG = '1' THEN missing END) AS N FROM 专线产品用户")).toThrow(/没有属性/);
    expect(() => resolve("SELECT SUM(CASE WHEN ZX_FLAG = '1' THEN USER_ID END) AS N FROM 专线产品用户")).toThrow(/SUM.*TEXT/);
    expect(() => resolve("SELECT COUNT(CASE WHEN ZX_FLAG = '1' THEN USER_ID ELSE 0 END) AS N FROM 专线产品用户")).toThrow(/类型不兼容/);
    expect(() => resolve("SELECT COUNT(CASE WHEN ZX_FLAG = '1' THEN :missing END) AS N FROM 专线产品用户")).toThrow(/没有在 parameters/);
  });
  it("分支值绑定参数，不把字符串拼进物理 SQL", () => {
    const payload = "'; DROP TABLE secrets; --";
    const compiled = compileQuerySql(resolve("SELECT COUNT(DISTINCT CASE WHEN ZX_FLAG = '1' THEN :label ELSE 'other' END) AS N FROM 专线产品用户", { label: payload }), "POSTGRES");
    expect(compiled.statement).not.toContain(payload);
    expect(Object.values(compiled.parameters)).toContain(payload);
  });
  it("聚合外、嵌套与简单 CASE 必须明确拒绝", () => {
    expect(() => parseOntologySql("SELECT CASE WHEN ZX_FLAG='1' THEN 1 END AS N FROM 专线产品用户")).toThrow(/只允许/);
    expect(() => parseOntologySql("SELECT SUM(CASE ZX_FLAG WHEN '1' THEN ZX_COUNT END) AS N FROM 专线产品用户")).toThrow(/简单式/);
    expect(() => parseOntologySql("SELECT SUM(CASE WHEN ZX_FLAG='1' THEN CASE WHEN STATS='0' THEN 1 END END) AS N FROM 专线产品用户")).toThrow(/不支持嵌套/);
    expect(() => parseOntologySql("SELECT SUM(CASE WHEN ZX_FLAG='1' THEN END) AS N FROM 专线产品用户")).toThrow(/缺少返回值/);
  });
  it("CASE 涉及关系别名时继续执行基数保护", () => {
    const model = caseDefinition();
    const group = { ...structuredClone(model.entityTypes[0]), id: "22222222-2222-4222-8222-222222222222", name: "集团", properties: [{ ...model.entityTypes[0].properties[2], primaryKey: true }], sources: [{ ...model.entityTypes[0].sources[0], view: "GROUPS", primaryKey: ["CUST_ID"] }] };
    model.entityTypes.push(group);
    const sql = "SELECT SUM(CASE WHEN g.CUST_ID IS NOT NULL THEN l.ZX_COUNT ELSE 0 END) AS N FROM 专线产品用户 AS l JOIN 归属 AS g";
    // 保留其余 schema 默认值，避免测试与关系模型字段约定分叉。
    const relation = { id: "33333333-3333-4333-8333-333333333333", name: "归属", sourceEntityTypeId: model.entityTypes[0].id, targetEntityTypeId: group.id, cardinality: "ONE_TO_MANY", sourceKeyMappings: [{ entityProperty: "CUST_ID", linkProperty: "" }], targetKeyMappings: [{ entityProperty: "CUST_ID", linkProperty: "" }] };
    const parsed = ontologyDefinitionSchema.parse({ ...model, relationshipTypes: [relation] });
    expect(() => resolveQueryDsl(parsed, toQueryDsl(sql, parsed))).toThrow(/放大行数/);
    parsed.relationshipTypes[0].cardinality = "MANY_TO_ONE";
    expect(compileQuerySql(resolveQueryDsl(parsed, toQueryDsl(sql, parsed)), "POSTGRES").statement).toContain('"g"."CUST_ID" IS NOT NULL');
  });
});
