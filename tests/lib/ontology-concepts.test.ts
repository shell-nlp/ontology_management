import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { conceptsOfDefinition, ONTOLOGY_CONCEPT_KINDS } from "@/lib/ontology/concepts";

/**
 * 定义 -> 概念清单（`ontology_concepts` 表的内容就是它算出来的）。
 *
 * 这层是**纯函数**：不连库、不认识 TypeORM，所以这里不需要数据库 —— `pnpm test` 就会跑。
 */
const GROUP = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const GROUP_CUSTOMER = "33333333-3333-4333-8333-333333333333";
const IFACE = "44444444-4444-4444-8444-444444444444";
const REL = "55555555-5555-4555-8555-555555555555";
const ACTION = "66666666-6666-4666-8666-666666666666";
const RULE = "77777777-7777-4777-8777-777777777777";
const METRIC = "88888888-8888-4888-8888-888888888888";

const definition = ontologyDefinitionSchema.parse({
  groups: [{ id: GROUP, name: "客户域" }],
  interfaces: [{
    id: IFACE,
    name: "客户",
    description: "能被同一套应用消费的客户契约",
    properties: [{ name: "customer_id", dataType: "TEXT" }],
  }],
  metrics: [{
    id: METRIC,
    name: "短彩信欠费金额",
    description: "按账单产品大类统计的欠费金额",
    entityTypeId: CUSTOMER,
    aggregation: "SUM",
    property: "u_type",
    filters: [{ property: "u_type", operator: "EQ", value: "1" }],
    dimensions: ["customer_id"],
    unit: "分",
    tags: ["账务"],
    status: "verified",
  }],
  entityTypes: [
    {
      id: CUSTOMER,
      name: "客户",
      description: "订购业务的主体",
      groupId: GROUP,
      implements: [IFACE],
      properties: [
        { name: "customer_id", dataType: "TEXT", description: "客户编号" },
        { name: "u_type", dataType: "TEXT", description: "用户类型", enumValues: [{ value: "1", label: "全球通" }] },
      ],
      sources: [{ id: "primary", schema: "GISTOOLS", view: "TB_MK_CUST", primaryKey: ["customer_id"], titleField: "customer_name" }],
    },
    { id: GROUP_CUSTOMER, name: "集团客户", description: "实现了客户接口", implements: [IFACE], properties: [] },
  ],
  relationshipTypes: [{
    id: REL,
    name: "客户拥有账户",
    description: "一个客户可以有多个账户",
    sourceEntityTypeId: CUSTOMER,
    targetEntityTypeId: GROUP_CUSTOMER,
    cardinality: "ONE_TO_MANY",
  }],
  actionTypes: [{
    id: ACTION,
    name: "登记欠费",
    code: "register_owe",
    description: "把欠费登记到账户上",
    scopeEntityTypeId: CUSTOMER,
    params: [{ code: "amount", name: "欠费金额", kind: "VALUE", dataType: "DECIMAL" }],
  }],
  rules: [{
    id: RULE,
    name: "欠费必须为正",
    effect: "BLOCK",
    actionId: ACTION,
    message: "欠费金额必须大于 0",
  }],
});

const concepts = conceptsOfDefinition(definition);
const find = (kind: string, name: string) => concepts.find((item) => item.kind === kind && item.name === name);

describe("定义 -> 概念清单", () => {
  it("八种概念都产出", () => {
    const kinds = new Set(concepts.map((item) => item.kind));
    expect([...kinds].sort()).toEqual([...ONTOLOGY_CONCEPT_KINDS].sort());
    expect(ONTOLOGY_CONCEPT_KINDS).toHaveLength(8);
  });

  it("属性用「对象类型.属性名」命名，落点是它自己的对象类型", () => {
    const property = find("PROPERTY", "客户.customer_id");
    expect(property).toBeTruthy();
    expect(property?.objectType).toBe("客户");
    expect(property?.text).toContain("客户编号");
  });

  it("枚举值（码值 + 中文）进检索文本", () => {
    expect(find("PROPERTY", "客户.u_type")?.text).toContain("全球通");
  });

  it("对象类型的检索文本带分组、实现的接口与绑定的表", () => {
    const customer = find("OBJECT_TYPE", "客户");
    expect(customer?.text).toContain("分组 客户域");
    expect(customer?.text).toContain("实现接口 客户");
    expect(customer?.text).toContain("TB_MK_CUST");
  });

  it("关系类型的 objectType 是「起点 ↔ 终点」", () => {
    expect(find("RELATION_TYPE", "客户拥有账户")?.objectType).toBe("客户 ↔ 集团客户");
  });

  it("接口带上实现方，动作带上作用类型与入参，规则带上挂的动作", () => {
    expect(find("INTERFACE", "客户")?.text).toContain("实现方 客户、集团客户");
    expect(find("ACTION", "登记欠费")?.text).toContain("register_owe");
    expect(find("ACTION", "登记欠费")?.objectType).toBe("客户");
    expect(find("RULE", "欠费必须为正")?.text).toContain("欠费金额必须大于 0");
    expect(find("RULE", "欠费必须为正")?.objectType).toBe("登记欠费");
  });

  it("指标带上聚合、单位、维度与口径过滤值", () => {
    const metric = find("METRIC", "短彩信欠费金额");
    expect(metric?.text).toContain("SUM(u_type)");
    expect(metric?.text).toContain("单位 分");
    expect(metric?.text).toContain("维度 customer_id");
    expect(metric?.text).toContain("u_typeEQ1");
  });

  it("每条概念的检索文本都非空且没有连续空白（存进库里要稳定可比）", () => {
    for (const concept of concepts) {
      expect(concept.text.trim(), concept.kind + " / " + concept.name).not.toBe("");
      expect(concept.text).not.toMatch(/\s{2,}/);
      expect(concept.text.startsWith(concept.name)).toBe(true);
    }
  });
});
