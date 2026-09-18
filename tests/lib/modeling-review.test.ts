import { describe, expect, it } from "vitest";
import {
  reviewOntologyModel,
  summarizeModelingReview,
  type ReviewableAction,
  type ReviewableDefinition,
  type ReviewableEntityType,
  type ReviewableGroup,
  type ReviewableInterface,
  type ReviewableProperty,
  type ReviewableRelationshipType,
  type ReviewableRule,
} from "@/lib/modeling-review";

/**
 * 建模体检的规则。
 *
 * 这一层**不挡发布**（挡发布的是 `validateVersionSnapshot`），所以测试的重点是两件事：
 * 1. 该报的报出来 —— 每加一条规则就钉一个用例；
 * 2. **不该报的不报** —— 一个建得规矩的本体必须零结论，否则规则一多就会变成噪音。
 */

/**
 * 用例里要就地改字段（`model.entityTypes[0] = …`），而 `ReviewableDefinition` 的数组是只读的 ——
 * 所以测试内部用这个可写版本；它天然满足只读的入参类型。
 */
type MutableModel = {
  groups?: ReviewableGroup[];
  interfaces?: ReviewableInterface[];
  entityTypes: ReviewableEntityType[];
  relationshipTypes: ReviewableRelationshipType[];
  actionTypes?: ReviewableAction[];
  rules?: ReviewableRule[];
};

function property(patch: Partial<ReviewableProperty> & { name: string }): ReviewableProperty {
  return { dataType: "TEXT", ...patch };
}

function entity(patch: Partial<ReviewableEntityType> & { id: string; name: string }): ReviewableEntityType {
  return { properties: [], sources: [], ...patch };
}

function relation(patch: Partial<ReviewableRelationshipType> & { id: string; name: string }): ReviewableRelationshipType {
  return { description: "说明", ...patch };
}

/** 一个"建得规矩"的最小本体：两个对象类型、一条关系、都绑了表并映射到列。 */
function healthy(): MutableModel {
  const customer = entity({
    id: "e-customer",
    name: "客户",
    description: "签约主体",
    displayProperty: "客户名称",
    groupId: "g-1",
    properties: [
      property({ name: "客户编号", dataType: "TEXT", required: true, sourceField: "CUST_ID" }),
      property({ name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" }),
    ],
    sources: [{ id: "s-1", dataSourceId: "11111111-1111-4111-8111-111111111111", view: "TB_CUST", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" }],
  });
  const order = entity({
    id: "e-order",
    name: "订单",
    description: "客户下的单",
    displayProperty: "订单编号",
    groupId: "g-1",
    properties: [
      property({ name: "订单编号", dataType: "TEXT", required: true, sourceField: "ORDER_ID" }),
      property({ name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" }),
    ],
    sources: [{ id: "s-1", dataSourceId: "11111111-1111-4111-8111-111111111111", view: "TB_ORDER", primaryKey: ["ORDER_ID"], titleField: "ORDER_ID" }],
  });
  return {
    groups: [{ id: "g-1", name: "客户域" }],
    interfaces: [],
    entityTypes: [customer, order],
    relationshipTypes: [relation({ id: "r-1", name: "下单", sourceEntityTypeId: "e-customer", targetEntityTypeId: "e-order" })],
    actionTypes: [],
    rules: [],
  };
}

function codes(model: ReviewableDefinition) {
  return reviewOntologyModel(model).map((item) => item.code);
}

describe("reviewOntologyModel：建得规矩的本体不该被挑出问题", () => {
  it("健康本体零结论", () => {
    expect(reviewOntologyModel(healthy())).toEqual([]);
  });
});

describe("reviewOntologyModel：对象类型", () => {
  it("空壳对象类型（一个属性都没有）", () => {
    const model = healthy();
    model.entityTypes = [...model.entityTypes, entity({ id: "e-empty", name: "空壳" })];
    const finding = reviewOntologyModel(model).find((item) => item.code === "ENTITY_NO_PROPERTIES");
    expect(finding?.level).toBe("WARN");
    expect(finding?.subject).toBe("空壳");
  });

  it("展示属性指向了不存在的属性", () => {
    const model = healthy();
    model.entityTypes[0] = { ...model.entityTypes[0], displayProperty: "不存在的属性" };
    expect(codes(model)).toContain("ENTITY_DISPLAY_PROPERTY_MISSING");
  });

  it("有属性但没指定展示属性", () => {
    const model = healthy();
    model.entityTypes[0] = { ...model.entityTypes[0], displayProperty: "" };
    const finding = reviewOntologyModel(model).find((item) => item.code === "ENTITY_NO_DISPLAY_PROPERTY");
    expect(finding?.level).toBe("INFO");
  });

  it("孤悬类型：没绑数据、不连关系、没有动作", () => {
    const model = healthy();
    model.entityTypes = [...model.entityTypes, entity({ id: "e-orphan", name: "孤悬", properties: [property({ name: "编号" })] })];
    expect(codes(model)).toContain("ENTITY_ORPHAN");
  });

  it("接进网络之后就不再算孤悬", () => {
    const model = healthy();
    model.entityTypes = [...model.entityTypes, entity({ id: "e-orphan", name: "孤悬", properties: [property({ name: "编号" })] })];
    model.relationshipTypes = [...model.relationshipTypes, relation({ id: "r-2", name: "引用", sourceEntityTypeId: "e-order", targetEntityTypeId: "e-orphan" })];
    expect(codes(model)).not.toContain("ENTITY_ORPHAN");
  });

  it("绑了表但一个属性都没映射到列", () => {
    const model = healthy();
    model.entityTypes[0] = { ...model.entityTypes[0], properties: [property({ name: "客户编号" }), property({ name: "客户名称" })] };
    expect(codes(model)).toContain("ENTITY_SOURCE_UNMAPPED");
  });

  it("主键列没有属性映射过去", () => {
    const model = healthy();
    model.entityTypes[0] = { ...model.entityTypes[0], properties: [property({ name: "客户名称", sourceField: "CUST_NAME" })] };
    const finding = reviewOntologyModel(model).find((item) => item.code === "ENTITY_PRIMARY_KEY_UNMAPPED");
    expect(finding?.level).toBe("WARN");
    expect(finding?.message).toContain("CUST_ID");
  });

  it("必填属性没有映射列", () => {
    const model = healthy();
    model.entityTypes[0] = {
      ...model.entityTypes[0],
      properties: [property({ name: "客户编号", sourceField: "CUST_ID" }), property({ name: "客户名称", required: true })],
    };
    const finding = reviewOntologyModel(model).find((item) => item.code === "ENTITY_REQUIRED_PROPERTY_UNMAPPED");
    expect(finding?.message).toContain("客户名称");
  });
});

describe("reviewOntologyModel：命名与属性一致性", () => {
  it("名称只是大小写不同也算重名", () => {
    const model = healthy();
    model.entityTypes = [...model.entityTypes, entity({ id: "e-dup", name: "客户 ", properties: [property({ name: "编号" })] })];
    expect(codes(model).filter((code) => code === "ENTITY_DUPLICATE_NAME")).toHaveLength(2);
  });

  it("对象类型够多、命名风格混着来时才提示", () => {
    const model = healthy();
    model.entityTypes = [
      ...model.entityTypes,
      entity({ id: "e-1", name: "customer_profile", properties: [property({ name: "编号" })], sources: [{ id: "s", dataSourceId: "d", view: "t", primaryKey: ["c"] }] }),
      entity({ id: "e-2", name: "OrderItem", properties: [property({ name: "编号" })], sources: [{ id: "s", dataSourceId: "d", view: "t", primaryKey: ["c"] }] }),
    ];
    model.relationshipTypes = [
      ...model.relationshipTypes,
      relation({ id: "r-3", name: "关联", sourceEntityTypeId: "e-1", targetEntityTypeId: "e-2" }),
    ];
    expect(codes(model)).toContain("NAMING_MIXED_STYLE");

    // 只有两三个名字时不说"风格不统一"：样本太少，说了是噪音。
    const small = healthy();
    small.entityTypes = [small.entityTypes[0], { ...small.entityTypes[1], name: "customer_order" }];
    expect(codes(small)).not.toContain("NAMING_MIXED_STYLE");
  });

  it("同名属性在不同对象类型里类型不一致，且消息里点名是哪个属性", () => {
    const model = healthy();
    model.entityTypes[1] = {
      ...model.entityTypes[1],
      properties: [property({ name: "订单编号", required: true, sourceField: "ORDER_ID" }), property({ name: "客户编号", dataType: "INTEGER", sourceField: "CUST_ID" })],
    };
    const finding = reviewOntologyModel(model).find((item) => item.code === "PROPERTY_TYPE_CONFLICT");
    expect(finding?.level).toBe("INFO");
    expect(finding?.message).toContain("客户编号");
    expect(finding?.message).toContain("TEXT");
    expect(finding?.message).toContain("INTEGER");
  });
});

describe("reviewOntologyModel：关系类型", () => {
  it("端点没选", () => {
    const model = healthy();
    model.relationshipTypes = [relation({ id: "r-1", name: "下单", sourceEntityTypeId: "e-customer" })];
    const finding = reviewOntologyModel(model).find((item) => item.code === "RELATION_ENDPOINT_MISSING");
    expect(finding?.message).toContain("终点");
  });

  it("自环只是提示，不是错误", () => {
    const model = healthy();
    model.relationshipTypes = [relation({ id: "r-1", name: "上级", sourceEntityTypeId: "e-customer", targetEntityTypeId: "e-customer" })];
    const finding = reviewOntologyModel(model).find((item) => item.code === "RELATION_SELF_LOOP");
    expect(finding?.level).toBe("INFO");
  });

  it("同一对端点多条关系类型", () => {
    const model = healthy();
    model.relationshipTypes = [
      ...model.relationshipTypes,
      relation({ id: "r-2", name: "创建", sourceEntityTypeId: "e-customer", targetEntityTypeId: "e-order" }),
    ];
    expect(codes(model).filter((code) => code === "RELATION_DUPLICATE_PAIR")).toHaveLength(2);
  });

  it("关系类型和对象类型同名", () => {
    const model = healthy();
    model.relationshipTypes = [relation({ id: "r-1", name: "客户", sourceEntityTypeId: "e-customer", targetEntityTypeId: "e-order" })];
    expect(codes(model)).toContain("RELATION_NAME_COLLIDES");
  });

  it("没写说明", () => {
    const model = healthy();
    model.relationshipTypes = [relation({ id: "r-1", name: "下单", description: "  ", sourceEntityTypeId: "e-customer", targetEntityTypeId: "e-order" })];
    expect(codes(model)).toContain("RELATION_NO_DESCRIPTION");
  });
});

describe("reviewOntologyModel：接口、分组、动作与规则", () => {
  it("空接口 + 没人实现", () => {
    const model = healthy();
    model.interfaces = [{ id: "i-1", name: "主体", properties: [], linkConstraints: [] }];
    const found = codes(model);
    expect(found).toContain("INTERFACE_EMPTY");
    expect(found).toContain("INTERFACE_UNUSED");
  });

  it("被实现、且有属性的接口不再提示", () => {
    const model = healthy();
    model.interfaces = [{ id: "i-1", name: "主体", properties: [property({ name: "客户编号", required: true })], linkConstraints: [] }];
    model.entityTypes[0] = { ...model.entityTypes[0], implements: ["i-1"] };
    const found = codes(model);
    expect(found).not.toContain("INTERFACE_EMPTY");
    expect(found).not.toContain("INTERFACE_UNUSED");
  });

  it("空分组与指向不存在分组的对象类型", () => {
    const model = healthy();
    model.groups = [...(model.groups ?? []), { id: "g-2", name: "空域" }];
    model.entityTypes[1] = { ...model.entityTypes[1], groupId: "g-404" };
    const found = codes(model);
    expect(found).toContain("GROUP_EMPTY");
    expect(found).toContain("ENTITY_GROUP_MISSING");
  });

  it("动作标识重复、动作没有写操作", () => {
    const model = healthy();
    model.actionTypes = [
      { id: "a-1", name: "改状态", code: "update_status", description: "改", scopeEntityTypeId: "e-order", edits: [{}] },
      { id: "a-2", name: "改状态副本", code: "update_status", description: "改", scopeEntityTypeId: "e-order", edits: [{}] },
      { id: "a-3", name: "空动作", code: "noop", description: "空", scopeEntityTypeId: "e-order", edits: [] },
    ];
    const found = codes(model);
    expect(found.filter((code) => code === "ACTION_DUPLICATE_CODE")).toHaveLength(2);
    expect(found).toContain("ACTION_WITHOUT_EDIT");
  });

  it("规则：没条件、没提示语、指向不存在的动作", () => {
    const model = healthy();
    model.rules = [
      { id: "ru-1", name: "全拦", effect: "BLOCK", enabled: true, actionId: "a-404", conditions: [], message: "" },
    ];
    const found = codes(model);
    expect(found).toContain("RULE_WITHOUT_CONDITION");
    expect(found).toContain("RULE_EMPTY_MESSAGE");
    expect(found).toContain("RULE_ACTION_MISSING");
  });

  it("停用的规则不体检", () => {
    const model = healthy();
    model.rules = [{ id: "ru-1", name: "停用", effect: "BLOCK", enabled: false, actionId: "", conditions: [], message: "" }];
    expect(codes(model)).not.toContain("RULE_WITHOUT_CONDITION");
  });
});

describe("summarizeModelingReview", () => {
  it("数出两档条数并给一句话", () => {
    const model = healthy();
    model.entityTypes[0] = { ...model.entityTypes[0], displayProperty: "" };
    model.entityTypes[1] = { ...model.entityTypes[1], displayProperty: "不存在的属性" };
    const summary = summarizeModelingReview(reviewOntologyModel(model));
    expect(summary.warn).toBe(1);
    expect(summary.info).toBe(1);
    expect(summary.total).toBe(2);
    expect(summary.headline).toContain("1 项该改");
    expect(summary.byScope.some((item) => item.scope === "OBJECT_TYPE" && item.count === 2)).toBe(true);
  });

  it("没问题时说没问题", () => {
    expect(summarizeModelingReview([]).headline).toContain("没有发现问题");
  });
});