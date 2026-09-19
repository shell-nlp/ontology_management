import { describe, expect, it } from "vitest";
import { graphFromSnapshot, listSnapshotEntities, validateVersionSnapshot, type VersionSnapshot } from "@/lib/version-snapshot";

const customerTypeId = "11111111-1111-4111-8111-111111111111";
const orderTypeId = "22222222-2222-4222-8222-222222222222";
const relationshipTypeId = "33333333-3333-4333-8333-333333333333";
const customerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orderId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const relationshipId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function validSnapshot(): VersionSnapshot {
  return {
    definition: {
      groups: [],
      interfaces: [],
      entityTypes: [
        { id: customerTypeId, name: "客户", description: "", displayProperty: "名称", groupId: "", implements: [], properties: [{ name: "名称", displayName: "名称", description: "", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
        { id: orderTypeId, name: "订单", description: "", displayProperty: "编号", groupId: "", implements: [], properties: [{ name: "编号", displayName: "编号", description: "", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
      ],
      relationshipTypes: [
        { id: relationshipTypeId, name: "下单", description: "", sourceEntityTypeId: customerTypeId, targetEntityTypeId: orderTypeId, properties: [] },
      ],
      actionTypes: [],
      rules: [],
    },
    nodes: [
      { id: customerId, labels: ["客户"], properties: { 名称: "商客", fx: 12, fy: 30 } },
      { id: orderId, labels: ["订单"], properties: { 编号: "SO-001" } },
    ],
    relationships: [
      { id: relationshipId, sourceId: customerId, targetId: orderId, type: "下单", properties: {} },
    ],
  };
}

describe("version snapshot", () => {
  it("builds graph data with stable snapshot ids", () => {
    const graph = graphFromSnapshot(validSnapshot());
    expect(graph.nodes.map((node) => node.id)).toEqual([customerId, orderId]);
    expect(graph.relationships[0]).toMatchObject({ id: relationshipId, source: customerId, target: orderId, type: "下单" });
  });

  it("accepts a coherent snapshot and ignores layout metadata", () => {
    expect(validateVersionSnapshot(validSnapshot())).toEqual([]);
  });

  it("blocks duplicate unique values, invalid endpoints and unknown types", () => {
    const snapshot = validSnapshot();
    snapshot.nodes.push({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", labels: ["客户"], properties: { 名称: "商客" } });
    snapshot.relationships[0].targetId = customerId;
    snapshot.relationships.push({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sourceId: customerId, targetId: orderId, type: "不存在", properties: {} });
    const messages = validateVersionSnapshot(snapshot).map((violation) => violation.message);
    expect(messages).toContain("唯一属性存在重复值。");
    expect(messages).toContain("关系端点不符合草稿中的对象类型契约。");
    expect(messages).toContain("关系使用了草稿中不存在的关系类型。");
  });

  it("flags unique values that are too large to be a unique key", () => {
    const snapshot = validSnapshot();
    const oversized = "汉".repeat(2800);
    snapshot.nodes[0].properties.名称 = oversized;
    const violations = validateVersionSnapshot(snapshot);
    const match = violations.find((violation) => violation.message.includes("不适合当唯一键"));
    expect(match).toBeDefined();
    expect(match!.rule).toBe("客户.名称");
    expect(match!.count).toBe(1);
  });

  it("关系类型的键映射指到不存在的属性时挡发布，指到主键上则放行", () => {
    const ok = validSnapshot();
    ok.definition.relationshipTypes[0] = {
      ...ok.definition.relationshipTypes[0],
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "名称" }],
      targetKeyMappings: [{ linkProperty: "ORDER_NO", entityProperty: "编号" }],
    };
    expect(validateVersionSnapshot(ok)).toEqual([]);

    const broken = validSnapshot();
    broken.definition.relationshipTypes[0] = {
      ...broken.definition.relationshipTypes[0],
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "没有这个属性" }],
    };
    const violations = validateVersionSnapshot(broken);
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain("不存在的属性「没有这个属性」");
    expect(violations[0].severity).toBeUndefined();
  });
});

describe("按对象类型筛：字面匹配（类之间没有继承）", () => {
  const 用户类 = "11111111-1111-4111-8111-111111111111";
  const 专线类 = "22222222-2222-4222-8222-222222222222";
  const 用户对象 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const 专线对象 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function twoTypesSnapshot(): VersionSnapshot {
    return {
      definition: {
        groups: [],
        interfaces: [],
        entityTypes: [
          { id: 用户类, name: "用户", description: "", displayProperty: "姓名", groupId: "", implements: [], properties: [{ name: "姓名", displayName: "姓名", description: "", dataType: "TEXT", required: false, unique: false, indexed: false }], sources: [] },
          { id: 专线类, name: "专线产品用户", description: "", displayProperty: "姓名", groupId: "", implements: [], properties: [], sources: [] },
        ],
        relationshipTypes: [],
        actionTypes: [],
        rules: [],
      },
      nodes: [
        { id: 用户对象, labels: ["用户"], properties: { 姓名: "张三" } },
        { id: 专线对象, labels: ["专线产品用户"], properties: { 姓名: "李四" } },
      ],
      relationships: [],
    };
  }

  // 2026-09-16 起类之间没有父子关系：按某个类筛，就是筛这个类自己的对象。
  it("按某个类筛，只有这个类的对象", () => {
    expect(listSnapshotEntities(twoTypesSnapshot(), { label: "用户" }).map((row) => row.id)).toEqual([用户对象]);
    expect(listSnapshotEntities(twoTypesSnapshot(), { label: "专线产品用户" }).map((row) => row.id)).toEqual([专线对象]);
  });

  it("图谱筛选也是字面匹配", () => {
    expect(graphFromSnapshot(twoTypesSnapshot(), { labels: ["用户"] }).nodes.map((node) => node.id)).toEqual([用户对象]);
  });
  it("传了不存在的标签时不会误伤：只匹配真实存在的类名", () => {
    const rows = listSnapshotEntities(twoTypesSnapshot(), { label: "订单" });
    expect(rows).toEqual([]);
  });
});

// 2026-09-16：发布前校验补上接口那一段（原先只在接口页提示，发布路径漏了）。
describe("发布前校验：接口实现", () => {
  const 接口id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const 约束id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const 客户类id = "11111111-1111-4111-8111-111111111111";
  const 用户类id = "22222222-2222-4222-8222-222222222222";
  const 归属关系id = "33333333-3333-4333-8333-333333333333";

  function 带接口的({ 有属性, 有关系 }: { 有属性: boolean; 有关系: boolean }): VersionSnapshot {
    return {
      definition: {
        groups: [],
        interfaces: [{
          id: 接口id, name: "可服务对象", description: "",
          properties: [{ name: "服务号码", displayName: "", description: "", dataType: "TEXT", required: true, unique: false, indexed: false }],
          extends: [],
          linkConstraints: [{ id: 约束id, name: "归属", description: "", targetKind: "OBJECT_TYPE", targetId: 客户类id, cardinality: "ONE", required: true }],
        }],
        entityTypes: [
          { id: 客户类id, name: "客户", description: "", displayProperty: "", groupId: "", implements: [], properties: [], sources: [] },
          {
            id: 用户类id, name: "用户", description: "", displayProperty: "", groupId: "", implements: [接口id], sources: [],
            properties: 有属性 ? [{ name: "服务号码", displayName: "", description: "", dataType: "TEXT", required: false, unique: false, indexed: false }] : [],
          },
        ],
        relationshipTypes: 有关系 ? [{ id: 归属关系id, name: "用户归属客户", description: "", sourceEntityTypeId: 用户类id, targetEntityTypeId: 客户类id, properties: [] }] : [],
        actionTypes: [],
        rules: [],
      },
      nodes: [],
      relationships: [],
    };
  }

  it("实现接口但缺必填属性 / 缺必填关系时会被拦下", () => {
    const rules = validateVersionSnapshot(带接口的({ 有属性: false, 有关系: false })).map((item) => item.rule);
    expect(rules).toContain("INTERFACE_PROPERTY_MISSING");
    expect(rules).toContain("INTERFACE_LINK_MISSING");
  });

  it("满足了同名属性与方向正确的关系就不拦", () => {
    expect(validateVersionSnapshot(带接口的({ 有属性: true, 有关系: true }))).toEqual([]);
  });
});
