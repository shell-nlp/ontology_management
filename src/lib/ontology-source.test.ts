import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { validateEntitySources } from "@/lib/ontology-sources";

const entityId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const otherSourceId = "33333333-3333-4333-8333-333333333333";

describe("类的数据来源绑定", () => {
  it("一个类挂多份来源时，来源、连接键与属性映射都能原样存下来", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "客户",
        properties: [
          { name: "名称", dataType: "TEXT", sourceField: "CUST_NAME", sourceId: "primary" },
          { name: "信用分", dataType: "INTEGER", sourceField: "SCORE", sourceId: "credit" },
          { name: "编号", dataType: "TEXT" },
        ],
        sources: [
          { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" },
          { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID", "AREA_CODE"], titleField: "" },
        ],
      }],
      relationshipTypes: [],
      actionTypes: [],
      rules: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([
      { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" },
      { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID", "AREA_CODE"], titleField: "" },
    ]);
    expect(parsed.entityTypes[0].properties[0]).toMatchObject({ sourceField: "CUST_NAME", sourceId: "primary" });
    expect(parsed.entityTypes[0].properties[1]).toMatchObject({ sourceField: "SCORE", sourceId: "credit" });
    expect(parsed.entityTypes[0].properties[2].sourceField).toBeUndefined();
  });

  it("加多来源之前存下来的单来源草稿，读出来就是主来源", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "客户",
        properties: [{ name: "名称", dataType: "TEXT", sourceField: "CUST_NAME" }],
        source: { dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "CUST_NAME" },
      }],
      relationshipTypes: [],
      actionTypes: [],
      rules: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([
      { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "CUST_NAME" },
    ]);
  });

  it("没接过来源的草稿读出来是空清单，不会报错", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{ id: entityId, name: "客户", properties: [] }],
      relationshipTypes: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([]);
  });
});

describe("来源绑定的自检", () => {
  const primary = { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "" };

  it("还没配完只提示，不拦发布", () => {
    const issues = validateEntitySources({ name: "客户", sources: [{ ...primary, view: "", primaryKey: [] }], properties: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("WARN");
  });

  it("补充来源没填连接键时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [primary, { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: [""], titleField: "" }],
      properties: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBeUndefined();
    expect(issues[0].message).toContain("连接键");
  });

  it("连接键列数和主键对不上时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [
        { ...primary, primaryKey: ["ID", "AREA_CODE"] },
        { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID"], titleField: "" },
      ],
      properties: [],
    });
    expect(issues.some((issue) => issue.message.includes("两边要对齐"))).toBe(true);
  });

  it("属性指向一份已经不存在的来源时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [primary],
      properties: [{ name: "信用分", sourceField: "SCORE", sourceId: "gone" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("信用分");
  });
});
