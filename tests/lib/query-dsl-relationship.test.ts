import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { compileQuerySql, parseQueryDsl, resolveQueryDsl } from "@/lib/query-dsl";

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 地市类 = "33333333-3333-4333-8333-333333333333";
const 归属关系 = "44444444-4444-4444-8444-444444444444";
const 数据资源 = "99999999-9999-4999-8999-999999999999";

function 定义(cardinality: "MANY_TO_ONE" | "ONE_TO_MANY" = "MANY_TO_ONE"): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [
      {
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
      },
      {
        id: 地市类,
        name: "地市",
        properties: [
          { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
          { name: "地市名称", dataType: "TEXT", sourceField: "AREA_NAME" },
        ],
        sources: [{
          id: "primary",
          dataSourceId: 数据资源,
          schema: "GISTOOLS",
          view: "TB_DIC_AREA_CODE",
          primaryKey: ["AREA_CODE"],
          titleField: "AREA_NAME",
        }],
      },
    ],
    relationshipTypes: [{
      id: 归属关系,
      name: "归属地市",
      sourceEntityTypeId: 专线类,
      targetEntityTypeId: 地市类,
      cardinality,
      linkSource: { mode: "FOREIGN_KEY", dataSourceId: 数据资源, schema: "GISTOOLS", view: "", foreignKeySide: "SOURCE" },
      sourceKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
      targetKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
    }],
  });
}

describe("query-dsl relationships", () => {
  it("按关系类型把外键式关系编译成受控 JOIN", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户", alias: "line" },
      relationships: [{ alias: "area", type: "归属地市", from: "line", direction: "forward", optional: false }],
      where: { field: { alias: "area", property: "地市名称" }, op: "eq", value: "郑州" },
      select: [
        { field: { alias: "line", property: "地市编码" }, as: "地市编码" },
        { field: { alias: "area", property: "地市名称" }, as: "地市名称" },
      ],
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('FROM "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY" "line"');
    expect(compiled.statement).toContain('JOIN "GISTOOLS"."TB_DIC_AREA_CODE" "area" ON "area"."AREA_CODE" = "line"."AREA_CODE"');
    expect(compiled.statement).toContain('"area"."AREA_NAME" = :p1');
  });

  it("中间表式关系编译成连接表 JOIN，不让模型写 ON 条件", () => {
    const base = 定义("MANY_TO_ONE");
    const relation = base.relationshipTypes[0];
    const definition: OntologyDefinition = {
      ...base,
      relationshipTypes: [{
        ...relation,
        linkSource: { mode: "JOIN_TABLE", dataSourceId: 数据资源, schema: "GISTOOLS", view: "TB_LINE_AREA", foreignKeySide: "SOURCE" },
        sourceKeyMappings: [{ linkProperty: "LINE_AREA_CODE", entityProperty: "地市编码" }],
        targetKeyMappings: [{ linkProperty: "AREA_CODE", entityProperty: "地市编码" }],
      }],
    };
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户", alias: "line" },
      relationships: [{ alias: "area", type: "归属地市", from: "line", direction: "forward" }],
      select: [{ field: { alias: "area", property: "地市名称" }, as: "地市名称" }],
    });

    const compiled = compileQuerySql(resolveQueryDsl(definition, query), "ORACLE");

    expect(compiled.statement).toContain('LEFT JOIN "GISTOOLS"."TB_LINE_AREA" "area__link" ON "area__link"."LINE_AREA_CODE" = "line"."AREA_CODE"');
    expect(compiled.statement).toContain('LEFT JOIN "GISTOOLS"."TB_DIC_AREA_CODE" "area" ON "area"."AREA_CODE" = "area__link"."AREA_CODE"');
  });
  it("支持 backward 方向，连接条件仍由关系规划决定", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "地市", alias: "area" },
      relationships: [{ alias: "line", type: "归属地市", from: "area", direction: "backward", optional: false }],
      where: { field: { alias: "area", property: "地市名称" }, op: "eq", value: "郑州" },
      select: [{ field: { alias: "line", property: "地市编码" }, as: "地市编码" }],
    });

    const compiled = compileQuerySql(resolveQueryDsl(定义(), query), "ORACLE");

    expect(compiled.statement).toContain('FROM "GISTOOLS"."TB_DIC_AREA_CODE" "area"');
    expect(compiled.statement).toContain('JOIN "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY" "line" ON "area"."AREA_CODE" = "line"."AREA_CODE"');
  });

  it("跨数据资源关系明确拒绝", () => {
    const base = 定义();
    const definition: OntologyDefinition = {
      ...base,
      entityTypes: base.entityTypes.map((entity) => entity.name === "地市"
        ? { ...entity, sources: [{ ...entity.sources[0], dataSourceId: "88888888-8888-4888-8888-888888888888" }] }
        : entity),
    };
    const query = parseQueryDsl({
      version: "1.0",
      kind: "records",
      from: { object_type: "专线产品用户", alias: "line" },
      relationships: [{ alias: "area", type: "归属地市", from: "line", direction: "forward" }],
      select: [{ field: { alias: "area", property: "地市名称" }, as: "地市名称" }],
    });

    expect(() => resolveQueryDsl(definition, query)).toThrowError(/跨数据资源/);
  });
  it("关系可能放大行数时拒绝聚合，不静默重复计数", () => {
    const query = parseQueryDsl({
      version: "1.0",
      kind: "aggregate",
      from: { object_type: "专线产品用户", alias: "line" },
      relationships: [{ alias: "area", type: "归属地市", from: "line", direction: "forward" }],
      select: [{ aggregate: "COUNT", as: "条数" }],
    });

    expect(() => resolveQueryDsl(定义("ONE_TO_MANY"), query)).toThrowError(/关系.*放大|基数|重复计数/);
  });
});