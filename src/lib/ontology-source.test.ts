import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const entityId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";

describe("类的数据来源绑定", () => {
  it("来源、主键与属性映射都能原样存下来", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "客户",
        properties: [
          { name: "名称", dataType: "TEXT", sourceField: "CUST_NAME" },
          { name: "编号", dataType: "TEXT" },
        ],
        source: { dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" },
      }],
      relationshipTypes: [],
      actionTypes: [],
      rules: [],
    });
    expect(parsed.entityTypes[0].source).toEqual({ dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" });
    expect(parsed.entityTypes[0].properties[0].sourceField).toBe("CUST_NAME");
    expect(parsed.entityTypes[0].properties[1].sourceField).toBeUndefined();
  });

  it("加字段之前存下来的草稿读出来是空绑定，不会报错", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{ id: entityId, name: "客户", properties: [] }],
      relationshipTypes: [],
    });
    expect(parsed.entityTypes[0].source).toEqual({ dataSourceId: "", schema: "", view: "", primaryKey: [], titleField: "" });
  });
});
