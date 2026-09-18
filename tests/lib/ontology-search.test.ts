import { describe, expect, it } from "vitest";
import { searchOntologyDefinition } from "@/lib/ontology-search";
import type { Definition } from "@/lib/ontology-draft";

const definition = {
  groups: [{ id: "group", name: "客户域" }],
  interfaces: [],
  entityTypes: [
    { id: "customer", name: "客户", description: "客户档案", groupId: "group", properties: [{ name: "CUST_ID", displayName: "客户编号" }] },
    { id: "order", name: "订单", description: "", properties: [] },
  ],
  relationshipTypes: [{ id: "owns", name: "客户下单", sourceEntityTypeId: "customer", targetEntityTypeId: "order", properties: [{ name: "ORDER_DATE" }] }],
  actionTypes: [], rules: [],
} as Definition;

describe("searchOntologyDefinition", () => {
  it("按对象类型与属性显示名查找，不把概念分组混进结果", () => {
    expect(searchOntologyDefinition(definition, "客户").map((item) => item.id)).toEqual(["customer", "owns"]);
    expect(searchOntologyDefinition(definition, "客户域")).toEqual([]);
    expect(searchOntologyDefinition(definition, "客户编号")[0]).toMatchObject({ id: "customer", reason: "属性 · 客户编号" });
  });

  it("支持关系类型与属性机器名，并忽略空查询", () => {
    expect(searchOntologyDefinition(definition, "ORDER_DATE")[0]?.id).toBe("owns");
    expect(searchOntologyDefinition(definition, "  ")).toEqual([]);
  });
});
