import { describe, expect, it } from "vitest";
import { keyMappingLabel, keyMappingRows, primaryKeyPropertyNames, relationshipKeyViolations } from "@/lib/relationship-keys";

const 客户 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const 订单 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** 绑了来源的对象类型：主键是列，属性用 sourceField 指回来。 */
const 客户类型 = {
  id: 客户,
  name: "客户",
  properties: [
    { name: "客户标识", sourceField: "CUST_ID", required: true, unique: true },
    { name: "客户名称", sourceField: "CUST_NAME", required: true },
  ],
  sources: [{ id: "primary", primaryKey: ["CUST_ID"] }],
};
/** 没绑来源的类型：主键按导入约定记成"必填 + 唯一"。 */
const 订单类型 = {
  id: 订单,
  name: "订单",
  properties: [
    { name: "订单号", required: true, unique: true },
    { name: "金额", required: false },
  ],
  sources: [],
};

function model(relation: Record<string, unknown>) {
  return {
    entityTypes: [客户类型, 订单类型],
    relationshipTypes: [{ name: "下单", sourceEntityTypeId: 客户, targetEntityTypeId: 订单, ...relation }],
  };
}

describe("关系类型的键映射", () => {
  it("没配映射时不报任何问题（纯类型层建模可以不填）", () => {
    expect(relationshipKeyViolations(model({}))).toEqual([]);
    expect(relationshipKeyViolations(model({ sourceKeyMappings: [], targetKeyMappings: [] }))).toEqual([]);
  });

  it("全空的行被丢掉，剩下的按连接属性 → 对象类型属性读出", () => {
    expect(keyMappingRows([{ linkProperty: " CUST_ID ", entityProperty: " 客户标识 " }, { linkProperty: "", entityProperty: "" }])).toEqual([{ linkProperty: "CUST_ID", entityProperty: "客户标识" }]);
  });

  it("主键属性：绑了来源按主键列反查，没绑来源按必填 + 唯一", () => {
    expect(primaryKeyPropertyNames(客户类型)).toEqual(["客户标识"]);
    expect(primaryKeyPropertyNames(订单类型)).toEqual(["订单号"]);
    expect(primaryKeyPropertyNames(null)).toEqual([]);
  });

  it("映射到主键上：通过", () => {
    expect(relationshipKeyViolations(model({
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "客户标识" }],
      targetKeyMappings: [{ linkProperty: "ORDER_ID", entityProperty: "订单号" }],
    }))).toEqual([]);
  });

  it("映射到不存在的属性：挡发布（不给 severity）", () => {
    const violations = relationshipKeyViolations(model({ sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "不存在的属性" }] }));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBeUndefined();
    expect(violations[0].message).toContain("不存在的属性「不存在的属性」");
    expect(violations[0].message).toContain("现有属性：客户标识、客户名称");
  });

  it("映射到非主键属性、同一侧重复映射：只提醒", () => {
    const notPrimary = relationshipKeyViolations(model({ sourceKeyMappings: [{ linkProperty: "CUST_NAME", entityProperty: "客户名称" }] }));
    expect(notPrimary).toHaveLength(1);
    expect(notPrimary[0].severity).toBe("WARN");
    expect(notPrimary[0].message).toContain("不是对象类型「客户」的主键");

    const duplicated = relationshipKeyViolations(model({
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "客户标识" }, { linkProperty: "CUST_ID_2", entityProperty: "客户标识" }],
    }));
    expect(duplicated.map((item) => item.message).join()).toContain("映射了两次");
  });

  it("只写了连接属性、没选属性：提醒补上", () => {
    const violations = relationshipKeyViolations(model({ sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "" }] }));
    expect(violations).toHaveLength(1);
    expect(violations[0].severity).toBe("WARN");
    expect(violations[0].message).toContain("没选对象类型「客户」上的属性");
  });

  it("外键式（两侧连接属性都留空）条数对不齐：提醒", () => {
    const violations = relationshipKeyViolations(model({
      sourceKeyMappings: [{ entityProperty: "客户标识" }],
      targetKeyMappings: [{ entityProperty: "订单号" }, { entityProperty: "金额" }],
    }));
    expect(violations.map((item) => item.message).join()).toContain("两侧条数不一样");
  });

  it("端点没选时不重复报映射的问题（端点缺失已由别处报）", () => {
    expect(relationshipKeyViolations({
      entityTypes: [客户类型],
      relationshipTypes: [{ name: "悬空", sourceEntityTypeId: "", targetEntityTypeId: "", sourceKeyMappings: [{ entityProperty: "客户标识" }] }],
    })).toEqual([]);
  });

  it("映射写成一行给人看的文字", () => {
    expect(keyMappingLabel({ linkProperty: "CUST_ID", entityProperty: "客户标识" })).toBe("CUST_ID → 客户标识");
    expect(keyMappingLabel({ entityProperty: "CUST_ID" })).toBe("外键 CUST_ID");
    expect(keyMappingLabel({ linkProperty: "CUST_ID" })).toBe("CUST_ID → ?");
    expect(keyMappingLabel({})).toBe("");
  });
});
