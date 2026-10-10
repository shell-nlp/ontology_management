import { describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { compareQueryDslWithSql } from "@/lib/query-dsl";

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 数据资源 = "99999999-9999-4999-8999-999999999999";

function 定义(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [{
      id: 专线类,
      name: "专线产品用户",
      properties: [
        { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
        { name: "专线数率MB", dataType: "INTEGER", sourceField: "ZX_RATE" },
      ],
      sources: [{
        id: "primary",
        dataSourceId: 数据资源,
        schema: "GISTOOLS",
        view: "TB_MK_GRP_LINE_LIST_DAY",
        primaryKey: ["AREA_CODE"],
        titleField: "",
      }],
    }],
  });
}

describe("query-dsl shadow compare", () => {
  it("同一数据源执行 DSL 与参考 SQL，并逐列逐行报告差异", async () => {
    const calls: string[] = [];
    const result = await compareQueryDslWithSql(
      定义(),
      {
        version: "1.0",
        kind: "records",
        from: { object_type: "专线产品用户", alias: "line" },
        where: { field: { alias: "line", property: "专线数率MB" }, op: "gte", value: 100 },
        select: [{ field: { alias: "line", property: "地市编码" }, as: "地市编码" }],
      },
      'SELECT AREA_CODE AS "地市编码" FROM GISTOOLS.TB_MK_GRP_LINE_LIST_DAY',
      {
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
          runReadOnlyQuery: async (sql) => {
            calls.push(sql);
            const dsl = sql.includes(':p1');
            return {
              statement: sql,
              columns: ["地市编码"],
              rows: [{ "地市编码": dsl ? "郑州" : "洛阳" }],
              rowLimit: 100,
              truncated: false,
              readOnlyTransaction: true,
            };
          },
        }) as never,
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"line"."ZX_RATE" >= :p1');
    expect(result.equal).toBe(false);
    expect(result.differences).toEqual([{ row: 0, column: "地市编码", dsl: "郑州", reference: "洛阳" }]);
  });
});