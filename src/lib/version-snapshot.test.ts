import { describe, expect, it } from "vitest";
import { graphFromSnapshot, validateVersionSnapshot, type VersionSnapshot } from "@/lib/version-snapshot";

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
        { id: customerTypeId, name: "客户", description: "", displayProperty: "名称", properties: [{ name: "名称", dataType: "TEXT", required: true, unique: true, indexed: false }] },
        { id: orderTypeId, name: "订单", description: "", displayProperty: "编号", properties: [{ name: "编号", dataType: "TEXT", required: true, unique: true, indexed: false }] },
      ],
      relationshipTypes: [
        { id: relationshipTypeId, name: "下单", sourceEntityTypeId: customerTypeId, targetEntityTypeId: orderTypeId, properties: [] },
      ],
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

  it("flags unique values that exceed the index size limit", () => {
    const snapshot = validSnapshot();
    const oversized = "汉".repeat(2800);
    snapshot.nodes[0].properties.名称 = oversized;
    const violations = validateVersionSnapshot(snapshot);
    const match = violations.find((violation) => violation.message.includes("超过 Neo4j 索引大小限制"));
    expect(match).toBeDefined();
    expect(match!.rule).toBe("客户.名称");
    expect(match!.count).toBe(1);
  });
});
