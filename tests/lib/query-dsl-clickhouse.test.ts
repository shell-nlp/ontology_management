import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { resolveQueryDsl } from "@/lib/query-dsl/resolve";
import { toQueryDsl } from "@/lib/query-dsl/sql-surface";
import { compileLogicalQueryForClickHouse } from "@/lib/framework/object-index/clickhouse/query-dsl";

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 地市类 = "33333333-3333-4333-8333-333333333333";
const 归属关系 = "44444444-4444-4444-8444-444444444444";
const 数据资源 = "99999999-9999-4999-8999-999999999999";

const definition: OntologyDefinition = ontologyDefinitionSchema.parse({
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
      }],
    },
  ],
  relationshipTypes: [{
    id: 归属关系,
    name: "归属地市",
    sourceEntityTypeId: 专线类,
    targetEntityTypeId: 地市类,
    cardinality: "MANY_TO_ONE",
    linkSource: { mode: "FOREIGN_KEY", dataSourceId: 数据资源, schema: "GISTOOLS", view: "", foreignKeySide: "SOURCE" },
    sourceKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
    targetKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
  }],
});

describe("Query DSL -> ClickHouse 对象索引", () => {
  it("单对象类型查询读 object_entries，不写物理表名", () => {
    const dsl = toQueryDsl(
      "SELECT 地市编码, COUNT(*) AS 条数 FROM 专线产品用户 WHERE 地市编码 = '410100' GROUP BY 地市编码",
      definition,
      {},
    );
    const compiled = compileLogicalQueryForClickHouse(resolveQueryDsl(definition, dsl), "target-1", "ontology_index");

    expect(compiled.statement).toContain('FROM ontology_index.object_entries AS "root" FINAL');
    expect(compiled.statement).toContain('JSONExtractString("root".properties');
    expect(compiled.statement).toContain("count()");
    expect(compiled.statement).toContain("LIMIT 101");
    expect(compiled.statement).not.toContain("GISTOOLS");
  });

  it("关系查询读 object_links，不依赖业务库连接表", () => {
    const dsl = toQueryDsl(
      "SELECT 地市.地市名称 AS 地市名称, COUNT(*) AS 条数 FROM 专线产品用户 LEFT JOIN 归属地市 AS 地市 GROUP BY 地市.地市名称",
      definition,
      {},
    );
    const compiled = compileLogicalQueryForClickHouse(resolveQueryDsl(definition, dsl), "target-1", "ontology_index");

    expect(compiled.statement).toContain('ontology_index.object_links AS "地市__link" FINAL');
    expect(compiled.statement).toContain('"地市__link".relationship_type =');
    expect(compiled.statement).toContain('"地市".object_key = "地市__link".target_key');
    expect(compiled.statement).not.toContain("GISTOOLS");
  });
});
