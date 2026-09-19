import { describe, expect, it } from "vitest";
import { buildCanvasProjection, interfaceNodeId, isInterfaceNodeId } from "@/lib/ontology-canvas";
import type { Definition } from "@/lib/ontology-draft";

const 客户 = "11111111-1111-4111-8111-111111111111";
const 集团客户 = "22222222-2222-4222-8222-222222222222";
const 接口 = "33333333-3333-4333-8333-333333333333";
const 关系 = "44444444-4444-4444-8444-444444444444";

const property = { name: "名称", dataType: "TEXT" as const, required: false, unique: false, indexed: false };

function definition(overrides: Partial<Definition> = {}): Definition {
  return {
    groups: [],
    interfaces: [],
    entityTypes: [
      { id: 客户, name: "客户", description: "", properties: [property], sources: [] },
      { id: 集团客户, name: "集团客户", description: "", properties: [property], sources: [] },
    ],
    relationshipTypes: [{ id: 关系, name: "客户包含集团客户", sourceEntityTypeId: 客户, targetEntityTypeId: 集团客户, properties: [] }],
    actionTypes: [],
    rules: [],
    ...overrides,
  };
}

const base = { layout: "default" as const, layoutSeed: 0, positions: {}, showInterfaceLinks: false };

describe("buildCanvasProjection", () => {
  it("普通草稿：对象类型是节点，关系是实线", () => {
    const projection = buildCanvasProjection({ ...base, definition: definition() });
    expect(projection.nodes.map((node) => node.id).sort()).toEqual([客户, 集团客户].sort());
    expect(projection.edges).toEqual([{ id: 关系, type: "客户包含集团客户", source: 客户, target: 集团客户, kind: "relationship" }]);
    expect(projection.nodes.every((node) => node.kind === "entity")).toBe(true);
  });

  it("提取为接口后：影子对象类型不再画，接口节点一定画出来（2026-09-19 用户报的「转完就消失」）", () => {
    const converted = definition({
      interfaces: [{ id: 接口, name: "客户", description: "", promotedFromEntityTypeId: 客户, properties: [property], extends: [], linkConstraints: [] }],
    });
    const projection = buildCanvasProjection({ ...base, definition: converted });
    // 影子对象类型让位给接口节点
    expect(projection.nodes.some((node) => node.id === 客户)).toBe(false);
    const ifaceNode = projection.nodes.find((node) => node.id === interfaceNodeId(接口));
    expect(ifaceNode).toBeTruthy();
    expect(ifaceNode?.kind).toBe("interface");
    expect(isInterfaceNodeId(ifaceNode!.id)).toBe(true);
    // 承接的关系默认收起（影子上的那条原关系不再重复画）
    expect(projection.edges.some((edge) => edge.kind === "relationship")).toBe(false);
    expect(projection.edges.some((edge) => edge.kind === "interface-link")).toBe(false);
  });

  it("展开接口连接：关系以青绿色虚线的接口连接出现，端点还是对象类型", () => {
    const converted = definition({
      interfaces: [{ id: 接口, name: "客户", description: "", promotedFromEntityTypeId: 客户, properties: [property], extends: [], linkConstraints: [] }],
    });
    const projection = buildCanvasProjection({ ...base, definition: converted, showInterfaceLinks: true });
    expect(projection.edges).toContainEqual({ id: `interface-link:${接口}:${关系}`, type: "客户包含集团客户", source: interfaceNodeId(接口), target: 集团客户, kind: "interface-link" });
  });

  it("选中接口节点时也展开它的关系连接", () => {
    const converted = definition({
      interfaces: [{ id: 接口, name: "客户", description: "", promotedFromEntityTypeId: 客户, properties: [property], extends: [], linkConstraints: [] }],
    });
    const projection = buildCanvasProjection({ ...base, definition: converted, selectedInterfaceId: 接口 });
    expect(projection.edges.some((edge) => edge.kind === "interface-link")).toBe(true);
  });

  it("转成接口的节点留在原地：接口接手影子对象类型的位置（不会跳到别处）", () => {
    const before = buildCanvasProjection({ ...base, definition: definition() });
    const after = buildCanvasProjection({
      ...base,
      definition: definition({
        interfaces: [{ id: 接口, name: "客户", description: "", promotedFromEntityTypeId: 客户, properties: [property], extends: [], linkConstraints: [] }],
      }),
    });
    const beforeNode = before.nodes.find((node) => node.id === 客户);
    const afterNode = after.nodes.find((node) => node.id === interfaceNodeId(接口));
    expect(afterNode?.x).toBe(beforeNode?.x);
    expect(afterNode?.y).toBe(beforeNode?.y);
    // 手工摆过的位置也算数：转成接口后拖着它走，位置记在接口节点自己的 id 上。
    const dragged = buildCanvasProjection({
      ...base,
      positions: { [interfaceNodeId(接口)]: { x: 42, y: 24 } },
      definition: definition({
        interfaces: [{ id: 接口, name: "客户", description: "", promotedFromEntityTypeId: 客户, properties: [property], extends: [], linkConstraints: [] }],
      }),
    });
    expect(dragged.nodes.find((node) => node.id === interfaceNodeId(接口))).toMatchObject({ x: 42, y: 24 });
  });

  it("实现接口的画紫色虚线，普通接口没有实现方也照常出现在画布上", () => {
    const withImplementation = definition({
      interfaces: [{ id: 接口, name: "可服务对象", description: "", properties: [property], extends: [], linkConstraints: [] }],
      entityTypes: [
        { id: 客户, name: "客户", description: "", properties: [property], implements: [接口], sources: [] },
        { id: 集团客户, name: "集团客户", description: "", properties: [property], sources: [] },
      ],
    });
    const projection = buildCanvasProjection({ ...base, definition: withImplementation });
    expect(projection.nodes.find((node) => node.id === interfaceNodeId(接口))?.kind).toBe("interface");
    expect(projection.edges).toContainEqual({ id: `implements:${客户}:${接口}`, type: "实现接口", source: 客户, target: interfaceNodeId(接口), kind: "implementation" });
  });

  it("端点没落定的关系类型照旧进「待补全」，孤悬对象类型也算出来", () => {
    const broken = definition({
      entityTypes: [
        { id: 客户, name: "客户", description: "", properties: [property], sources: [] },
        { id: 集团客户, name: "集团客户", description: "", properties: [property], sources: [] },
      ],
      relationshipTypes: [{ id: 关系, name: "悬空关系", sourceEntityTypeId: 客户, targetEntityTypeId: "", properties: [] }],
    });
    const projection = buildCanvasProjection({ ...base, definition: broken });
    expect(projection.unresolvedRelations.map((relation) => relation.name)).toEqual(["悬空关系"]);
    expect(projection.orphanEntities.map((entity) => entity.name).sort()).toEqual(["客户", "集团客户"]);
  });
});
