import { describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { compileQuerySql, executeQueryDsl, parseQueryDsl, resolveQueryDsl } from "@/lib/query-dsl";

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 数据资源 = "99999999-9999-4999-8999-999999999999";
const 专线条数指标 = "66666666-6666-4666-8666-666666666666";
const 互联网专线条数指标 = "77777777-7777-4777-8777-777777777777";

function 定义(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [{
      id: 专线类,
      name: "专线产品用户",
      description: "开通了专线产品的用户",
      displayProperty: "地市编码",
      properties: [
        { name: "统计日期", dataType: "DATE", sourceField: "STATIS_DATE" },
        { name: "业务状态", dataType: "TEXT", sourceField: "STATS", enumValues: [{ value: "A", label: "状态正常" }] },
        { name: "产品名称", dataType: "TEXT", sourceField: "OFFER_NAME" },
        { name: "专线数率MB", dataType: "INTEGER", sourceField: "ZX_RATE" },
        { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
      ],
      sources: [{
        id: "primary",
        dataSourceId: 数据资源,
        schema: "GISTOOLS",
        view: "TB_MK_GRP_LINE_LIST_DAY",
        primaryKey: ["USER_ID"],
        titleField: "",
      }],
    }],
    metrics: [{
      id: 专线条数指标,
      name: "专线条数",
      description: "专线产品用户行数",
      entityTypeId: 专线类,
      aggregation: "COUNT",
      property: "",
      filters: [],
      dimensions: ["地市编码"],
      status: "draft",
    }, {
      id: 互联网专线条数指标,
      name: "互联网专线条数",
      description: "产品名包含互联网的专线行数",
      entityTypeId: 专线类,
      aggregation: "COUNT",
      property: "",
      filters: [{ property: "产品名称", operator: "CONTAINS", value: "互联网" }],
      dimensions: ["地市编码"],
      status: "verified",
    }],
  });
}

describe("query-dsl schema", () => {
  it("按 v1 补全根别名与默认行数", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户" },
      select: [{ field: { property: "统计日期" }, as: "统计日期" }],
    });

    expect(query.from.alias).toBe("root");
    expect(query.limit).toBe(100);
    expect(query.relationships).toEqual([]);
  });
});

describe("resolveQueryDsl", () => {
  it("拒绝本体里不存在的对象类型", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "不存在的类型" },
      select: [{ field: { property: "统计日期" }, as: "统计日期" }],
    });

    expect(() => resolveQueryDsl(定义(), query)).toThrowError(/本体里没有对象类型「不存在的类型」/);
  });

  it("拒绝对象类型里不存在的属性", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户" },
      select: [{ field: { property: "不存在的字段" }, as: "字段" }],
    });

    expect(() => resolveQueryDsl(定义(), query)).toThrowError(/没有属性「不存在的字段」/);
  });
});
describe("compileQuerySql", () => {
  it("把过滤与行数编译成参数化 SQL，不暴露物理表给模型", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户" },
      where: {
        and: [
          { field: { property: "业务状态" }, op: "eq", value: "A" },
          { field: { property: "专线数率MB" }, op: "gte", value: 100 },
        ],
      },
      select: [{ field: { property: "地市编码" }, as: "地市编码" }],
      order_by: [{ ref: "地市编码", direction: "asc" }],
      limit: 20,
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('FROM "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY"');
    expect(compiled.statement).toContain('"root"."STATS" = :p1');
    expect(compiled.statement).toContain('"root"."ZX_RATE" >= :p2');
    expect(compiled.statement).not.toContain("'A'");
    expect(compiled.parameters).toEqual({ p1: "A", p2: 100 });
    expect(compiled.limit).toBe(20);
  });
});
describe("compileQuerySql aggregate", () => {
  it("指标固定过滤编译成条件聚合，枚举标签先解析成码值", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "aggregate",
      from: { object_type: "专线产品用户" },
      where: {
        field: { property: "业务状态" },
        op: "enum_label",
        value: "状态正常",
      },
      select: [
        { field: { property: "地市编码" }, as: "地市编码" },
        { metric: "互联网专线条数", as: "条数" },
      ],
      group_by: [{ property: "地市编码" }],
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('COUNT(CASE WHEN "root"."OFFER_NAME" LIKE :p1');
    expect(compiled.statement).toContain("ESCAPE '\\'");
    expect(compiled.statement).toContain('"root"."STATS" = :p2');
    expect(compiled.parameters).toMatchObject({ p1: "%互联网%", p2: "A" });
    expect(compiled.statement).not.toContain("状态正常");
  });

  it("把已定义指标编译成聚合 SQL，并保留 draft 告警", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "aggregate",
      from: { object_type: "专线产品用户" },
      select: [
        { field: { property: "地市编码" }, as: "地市编码" },
        { metric: "专线条数", as: "条数" },
      ],
      group_by: [{ alias: "root", property: "地市编码" }],
      order_by: [{ ref: "条数", direction: "desc" }],
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('COUNT(*) AS "条数"');
    expect(compiled.statement).toContain('GROUP BY "root"."AREA_CODE"');
    expect(compiled.statement).toContain('ORDER BY "条数" DESC');
    expect(compiled.warnings.join("；")).toContain("指标「专线条数」状态为 draft");
  });
});
describe("executeQueryDsl", () => {
  it("通过连接器只读执行参数化 SQL，并返回列序稳定的结果", async () => {
    const calls: { sql: string; options?: { limit?: number; parameters?: Record<string, unknown> } }[] = [];
    const result = await executeQueryDsl(定义(), {
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户" },
      where: {
        field: { property: "业务状态" },
        op: "eq",
        value: { param: "status" },
      },
      select: [{ field: { property: "地市编码" }, as: "地市编码" }],
      limit: 20,
      parameters: { status: "A" },
    }, {
      getDataSource: async () => ({
        id: 数据资源,
        name: "测试数据资源",
        kind: "ORACLE",
        host: "localhost",
        port: 1521,
        database_name: "test",
        schema_name: "GISTOOLS",
        username: "u",
        credential_secret: "s",
        options: {},
        enabled: true,
        created_at: new Date(),
      }),
      openConnector: async () => ({
        test: vi.fn(),
        listViews: vi.fn(),
        describeView: vi.fn(),
        previewView: vi.fn(),
        runReadOnlyQuery: async (sql, options) => {
          calls.push({ sql, options });
          return {
            statement: sql,
            columns: ["地市编码"],
            rows: [{ "地市编码": "郑州" }],
            rowLimit: 20,
            truncated: false,
            readOnlyTransaction: true,
          };
        },
      }) as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('"root"."STATS" = :p1');
    expect(calls[0].options).toMatchObject({ limit: 20, parameters: { p1: "A" } });
    expect(result.columns).toEqual(["地市编码"]);
    expect(result.rows).toEqual([["郑州"]]);
    expect(result.data_source).toBe("测试数据资源");
  });
});