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
      entityTypes: [
        { id: customerTypeId, name: "客户", description: "", displayProperty: "名称", parents: [], properties: [{ name: "名称", displayName: "名称", description: "", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
        { id: orderTypeId, name: "订单", description: "", displayProperty: "编号", parents: [], properties: [{ name: "编号", displayName: "编号", description: "", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
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
});

describe("类型传播：按父类筛子类的对象", () => {
  const 用户类 = "11111111-1111-4111-8111-111111111111";
  const 专线类 = "22222222-2222-4222-8222-222222222222";
  const 用户对象 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const 专线对象 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function hierarchySnapshot(): VersionSnapshot {
    return {
      definition: {
        entityTypes: [
          { id: 用户类, name: "用户", description: "", displayProperty: "姓名", parents: [], properties: [{ name: "姓名", displayName: "姓名", description: "", dataType: "TEXT", required: false, unique: false, indexed: false }], sources: [] },
          { id: 专线类, name: "专线产品用户", description: "", displayProperty: "姓名", parents: [用户类], properties: [], sources: [] },
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

  it("按父类筛对象，子类的对象也算", () => {
    const rows = listSnapshotEntities(hierarchySnapshot(), { label: "用户" });
    expect(rows.map((row) => row.id)).toEqual([用户对象, 专线对象]);
  });

  it("按子类筛不会把父类的对象带出来", () => {
    const rows = listSnapshotEntities(hierarchySnapshot(), { label: "专线产品用户" });
    expect(rows.map((row) => row.id)).toEqual([专线对象]);
  });

  it("图谱筛选走同一份类型传播", () => {
    const graph = graphFromSnapshot(hierarchySnapshot(), { labels: ["用户"] });
    expect(graph.nodes.map((node) => node.id)).toEqual([用户对象, 专线对象]);
  });

  it("传了不存在的标签时不会误伤：只匹配真实存在的类名", () => {
    const rows = listSnapshotEntities(hierarchySnapshot(), { label: "订单" });
    expect(rows).toEqual([]);
  });
});
