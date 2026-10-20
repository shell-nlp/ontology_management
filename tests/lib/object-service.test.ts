import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { rowProperties, sourceColumns, sourceRowProperties, titleOf } from "@/lib/instance/object-service/data-source";
import { resolveReadOrigin } from "@/lib/instance/object-service";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "客户",
      displayProperty: "客户名称",
      properties: [
        { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
        { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
        { name: "信用分", dataType: "INTEGER", sourceField: "SCORE", sourceId: "extra" },
      ],
      sources: [
        { id: "primary", schema: "GISTOOLS", view: "TB_CUST", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" },
        { id: "extra", schema: "GISTOOLS", view: "TB_CUST_SCORE", primaryKey: ["CUST_ID"] },
      ],
    },
  ],
  relationshipTypes: [],
});

const customer = definition.entityTypes[0];

describe("sourceColumns", () => {
  it("主来源：只取归属它的属性列 + 主键列 + 标题列，不带上补充来源的列", () => {
    expect(sourceColumns(customer, "primary").sort()).toEqual(["CUST_ID", "CUST_NAME"]);
  });

  it("补充来源只取它自己的列（属性用 sourceId 指定归属）", () => {
    expect(sourceColumns(customer, "extra").sort()).toEqual(["CUST_ID", "SCORE"]);
  });
});

describe("rowProperties", () => {
  it("列名大小写由库决定（Oracle 返回大写），仍能按 sourceField 对上", () => {
    const properties = rowProperties(customer, { CUST_ID: "1001", CUST_NAME: "张三", SCORE: 88 });
    expect(properties).toEqual({ 客户编号: "1001", 客户名称: "张三", 信用分: 88 });
  });

  it("库里没返回的列不会凭空造出属性", () => {
    expect(rowProperties(customer, { CUST_ID: "1001" })).toEqual({ 客户编号: "1001" });
  });

  it("按来源映射时不会把补充来源的同名列串到主来源", () => {
    expect(sourceRowProperties(customer, "primary", { CUST_ID: "1001", CUST_NAME: "张三", SCORE: 88 }))
      .toEqual({ 客户编号: "1001", 客户名称: "张三" });
    expect(sourceRowProperties(customer, "extra", { CUST_ID: "1001", CUST_NAME: "张三", SCORE: 88 }))
      .toEqual({ 信用分: 88 });
  });
});

describe("titleOf", () => {
  it("优先展示属性，其次 name，再退回主键值", () => {
    expect(titleOf(customer, { 客户名称: "张三" }, { CUST_ID: "1001" })).toBe("张三");
    expect(titleOf(customer, { name: "李四" }, { CUST_ID: "1001" })).toBe("李四");
    expect(titleOf(customer, {}, { CUST_ID: "1001" })).toBe("1001");
  });
});

describe("虚拟查询优先策略", () => {
  it("新对象类型未显式配置时默认 FEDERATED", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{ id: "11111111-1111-4111-8111-111111111111", name: "客户", properties: [] }],
      relationshipTypes: [],
    });
    expect(parsed.entityTypes[0].indexPolicy).toBe("FEDERATED");
  });

  it("FEDERATED 永远回源，忽略临时选择索引", () => {
    expect(resolveReadOrigin("FEDERATED", "index")).toBe("source");
  });

  it("AUTO 的旧 index 请求也统一虚拟读取", () => {
    expect(resolveReadOrigin("AUTO", "auto")).toBe("source");
    expect(resolveReadOrigin("AUTO", undefined)).toBe("source");
    expect(resolveReadOrigin("AUTO", "index")).toBe("source");
  });

  it("旧 INDEXED 配置不再要求物化", () => {
    expect(resolveReadOrigin("INDEXED", "source")).toBe("source");
  });
});
