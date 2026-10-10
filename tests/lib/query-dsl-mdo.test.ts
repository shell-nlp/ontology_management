import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { compileQuerySql, parseQueryDsl, resolveQueryDsl } from "@/lib/query-dsl";

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 数据资源 = "99999999-9999-4999-8999-999999999999";

function 定义(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [{
      id: 专线类,
      name: "专线产品用户",
      properties: [
        { name: "专线编码", dataType: "TEXT", sourceField: "LINE_ID" },
        { name: "税后收入", dataType: "DECIMAL", sourceField: "INCOME", sourceId: "revenue" },
      ],
      sources: [
        {
          id: "primary",
          dataSourceId: 数据资源,
          schema: "GISTOOLS",
          view: "TB_MK_GRP_LINE_LIST_DAY",
          primaryKey: ["LINE_ID"],
          titleField: "LINE_ID",
        },
        {
          id: "revenue",
          dataSourceId: 数据资源,
          schema: "GISTOOLS",
          view: "TB_MK_GRP_LINE_REVENUE",
          primaryKey: ["LINE_ID"],
          titleField: "",
        },
      ],
    }],
  });
}

describe("query-dsl MDO", () => {
  it("补充来源按主键对齐编译成 LEFT JOIN，属性落到补充来源列", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户", alias: "line" },
      where: { field: { alias: "line", property: "税后收入" }, op: "gt", value: 0 },
      select: [
        { field: { alias: "line", property: "专线编码" }, as: "专线编码" },
        { field: { alias: "line", property: "税后收入" }, as: "税后收入" },
      ],
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('LEFT JOIN "GISTOOLS"."TB_MK_GRP_LINE_REVENUE" "line__src1" ON "line__src1"."LINE_ID" = "line"."LINE_ID"');
    expect(compiled.statement).toContain('"line__src1"."INCOME" AS "税后收入"');
    expect(compiled.statement).toContain('"line__src1"."INCOME" > :p1');
  });
});