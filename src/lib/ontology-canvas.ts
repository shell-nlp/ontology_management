import { buildGroupFrames, circleLayout, groupedLayoutPositions, type LayoutMode } from "@/lib/concept-groups";
import { compactGraphLabel, graphColor } from "@/lib/graph-palette";
import type { Definition, EntityType, RelationType } from "@/lib/ontology-draft";

/**
 * 可视化建模画布的**投影**：把一份草稿定义算成"画什么点、画什么线"。
 *
 * 为什么单独一层：画布上看到的不等于草稿里存的全集。
 * - **被提取成接口的对象类型**（`interfaces[].promotedFromEntityTypeId`）在画布上由接口节点代表，
 *   影子对象类型本身不画 —— 但它的定义与关系仍然留在草稿里，不动数据映射。
 * - **接口**都画（紫色，标签带 ◇），实现它的对象类型用紫色虚线连过去。
 * - **接口承接的关系**（由影子类型的关系推出来）默认不画：接口关系一多就会糊成一片。
 *   打开「接口连接」开关、或选中接口 / 它的实现方时才展开，用青绿色虚线区分。
 *
 * 纯函数：不读 localStorage、不碰 React，位置由调用方传进来（画布手动摆过的坐标）。
 */
export type CanvasEdgeKind = "relationship" | "implementation" | "interface-link";

export type CanvasNode = {
  id: string;
  label: string;
  color: string;
  isHub: boolean;
  kind: "entity" | "interface";
  x?: number;
  y?: number;
};

export type CanvasEdge = { id: string; type: string; source: string; target: string; kind: CanvasEdgeKind };

export type CanvasFrame = { id: string; name: string; color: string; nodeIds: string[] };

export type CanvasProjectionInput = {
  definition: Definition;
  layout: LayoutMode;
  layoutSeed: number;
  /** 画布上手动摆过的坐标，按节点 id 存。 */
  positions: Record<string, { x: number; y: number }>;
  selectedEntityId?: string | null;
  selectedInterfaceId?: string | null;
  /** 「接口连接」开关：打开后接口承接的关系也画出来。 */
  showInterfaceLinks: boolean;
};

export type CanvasProjection = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  frames: CanvasFrame[];
  /** 既没接关系、也没实现接口的对象类型（发布前待补全里提示用）。 */
  orphanEntities: EntityType[];
  /** 端点没落定的关系类型。 */
  unresolvedRelations: RelationType[];
};

/** 接口节点的 id：草稿里接口与对象类型是两个集合，画布上一律加前缀区分。 */
export function interfaceNodeId(interfaceId: string) {
  return `interface:${interfaceId}`;
}

export function isInterfaceNodeId(nodeId: string) {
  return nodeId.startsWith("interface:");
}

export function interfaceIdFromNodeId(nodeId: string) {
  return isInterfaceNodeId(nodeId) ? nodeId.slice("interface:".length) : "";
}

/**
 * 画布上还有两类"不是草稿里的关系类型"的连线，各有自己的 id 规则：
 * 紫色虚线 = 对象类型实现接口，青绿实线 = 接口承接的关系。
 * 点中它们也必须落到一个能编辑的东西上（接口 / 那条关系类型），不能点了没反应。
 */
export function implementationEdgeId(entityId: string, interfaceId: string) {
  return `implements:${entityId}:${interfaceId}`;
}

export function parseImplementationEdgeId(edgeId: string): { entityId: string; interfaceId: string } | null {
  if (!edgeId.startsWith("implements:")) return null;
  const [, entityId, interfaceId] = edgeId.split(":");
  return entityId && interfaceId ? { entityId, interfaceId } : null;
}

export function interfaceLinkEdgeId(interfaceId: string, relationId: string) {
  return `interface-link:${interfaceId}:${relationId}`;
}

export function parseInterfaceLinkEdgeId(edgeId: string): { interfaceId: string; relationId: string } | null {
  if (!edgeId.startsWith("interface-link:")) return null;
  const [, interfaceId, relationId] = edgeId.split(":");
  return interfaceId && relationId ? { interfaceId, relationId } : null;
}

/**
 * 没被手动摆放过的对象类型：度数最高的那个居中，其余绕成一圈。
 * 换一个 seed 就是绕轴转一圈，所以「自动整理」看得见变化，布局本身仍是确定的。
 */
export function radialLayout(entities: readonly { id: string }[], edges: readonly { source: string; target: string }[], seed: number) {
  const positions = new Map<string, { x: number; y: number }>();
  if (!entities.length) return positions;
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  let hub = entities[0];
  for (const entity of entities) if ((degree.get(entity.id) ?? 0) > (degree.get(hub.id) ?? 0)) hub = entity;
  positions.set(hub.id, { x: 0, y: 0 });
  const rest = entities.filter((entity) => entity.id !== hub.id);
  const radius = Math.max(150, 58 * Math.ceil(Math.sqrt(rest.length)));
  rest.forEach((entity, index) => {
    // 从 0° 起绕圈：两个端点会左右分列，正好铺满宽画布；seed 让「自动整理」看得见变化。
    const angle = seed * 0.7 + (index / rest.length) * Math.PI * 2;
    positions.set(entity.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  });
  return positions;
}

export function buildCanvasProjection(input: CanvasProjectionInput): CanvasProjection {
  const { definition, layout, layoutSeed, positions, showInterfaceLinks } = input;
  const selectedEntityId = input.selectedEntityId ?? null;
  const selectedInterfaceId = input.selectedInterfaceId ?? null;

  const entityById = new Map(definition.entityTypes.map((entity) => [entity.id, entity]));
  /** 被提取成接口的对象类型：画布上用接口节点代表，这份影子不再单独画。 */
  const promotedByEntityId = new Map(definition.interfaces.filter((item) => item.promotedFromEntityTypeId).map((item) => [item.promotedFromEntityTypeId as string, item]));
  const visibleEntities = definition.entityTypes.filter((entity) => !promotedByEntityId.has(entity.id));
  const visibleEntityIds = new Set(visibleEntities.map((entity) => entity.id));
  const selectedImplementationIds = selectedEntityId ? entityById.get(selectedEntityId)?.implements ?? [] : [];

  const drawnEdges: CanvasEdge[] = [];
  const unresolved: RelationType[] = [];
  for (const relation of definition.relationshipTypes) {
    if (!entityById.has(relation.sourceEntityTypeId) || !entityById.has(relation.targetEntityTypeId)) { unresolved.push(relation); continue; }
    // 影子对象类型上的关系不在默认视图重复画：它们由接口连接（虚线）表达。
    if (!visibleEntityIds.has(relation.sourceEntityTypeId) || !visibleEntityIds.has(relation.targetEntityTypeId)) continue;
    drawnEdges.push({ id: relation.id, type: relation.name, source: relation.sourceEntityTypeId, target: relation.targetEntityTypeId, kind: "relationship" });
  }

  const connected = new Set<string>();
  const degree = new Map<string, number>();
  for (const edge of drawnEdges) {
    connected.add(edge.source);
    connected.add(edge.target);
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  // 实现接口：紫色虚线，永远显示 —— 这是用户最需要看到的结构关系。
  for (const entity of visibleEntities) {
    for (const interfaceId of entity.implements ?? []) {
      if (!definition.interfaces.some((item) => item.id === interfaceId)) continue;
      connected.add(entity.id);
      drawnEdges.push({ id: implementationEdgeId(entity.id, interfaceId), type: "实现接口", source: entity.id, target: interfaceNodeId(interfaceId), kind: "implementation" });
    }
  }

  // 接口承接的关系默认收起：接口 / 实现方被选中，或开关打开时才画。
  const expandedInterfaces = definition.interfaces.filter((item) => showInterfaceLinks || item.id === selectedInterfaceId || selectedImplementationIds.includes(item.id));
  for (const iface of expandedInterfaces) {
    const shadowId = iface.promotedFromEntityTypeId;
    if (!shadowId) continue;
    for (const relation of definition.relationshipTypes) {
      const counterpart = relation.sourceEntityTypeId === shadowId ? relation.targetEntityTypeId : relation.targetEntityTypeId === shadowId ? relation.sourceEntityTypeId : "";
      if (!counterpart || !visibleEntityIds.has(counterpart)) continue;
      drawnEdges.push({ id: interfaceLinkEdgeId(iface.id, relation.id), type: relation.name, source: interfaceNodeId(iface.id), target: counterpart, kind: "interface-link" });
    }
  }

  let hubId: string | null = null;
  let hubDegree = -1;
  for (const entity of visibleEntities) {
    const value = degree.get(entity.id) ?? 0;
    if (value > hubDegree) { hubDegree = value; hubId = entity.id; }
  }

  /*
   * 画布上的"节点位"。
   *
   * 顺序刻意与 `definition.entityTypes` 一致：被提取成接口的对象类型由**接口接手它原来的位置**，
   * 所以转成接口之后节点不会换地方（2026-09-19 用户报的「转完就消失」，实际是它跳到了别处）。
   * 手工摆过的坐标仍然按节点 id 覆盖在上面。
   */
  const layoutNodes: { id: string; name: string; groupId?: string }[] = [];
  for (const entity of definition.entityTypes) {
    const promoted = promotedByEntityId.get(entity.id);
    layoutNodes.push(promoted
      ? { id: interfaceNodeId(promoted.id), name: entity.name, groupId: entity.groupId }
      : { id: entity.id, name: entity.name, groupId: entity.groupId });
  }
  for (const iface of definition.interfaces) {
    // 被提取出来的接口已经占了影子类型的位置；其余接口排在最后。
    if (iface.promotedFromEntityTypeId && entityById.has(iface.promotedFromEntityTypeId)) continue;
    layoutNodes.push({ id: interfaceNodeId(iface.id), name: iface.name, groupId: "" });
  }

  const fallback = radialLayout(layoutNodes, drawnEdges, layoutSeed);
  // 概念分组的框与坐标只在「按逻辑分组」下算：另外两种布局不看分组，也不画框。
  const frames = buildGroupFrames(definition.groups, layoutNodes, layoutNodes.map((node) => ({ id: node.id, name: node.name })));
  const described = layout === "grouped"
    ? groupedLayoutPositions(frames, layoutNodes.filter((node) => !frames.some((frame) => frame.nodeIds.includes(node.id))).map((node) => node.id), drawnEdges, layoutSeed)
    : layout === "circle" ? circleLayout(layoutNodes.map((node) => node.id), layoutSeed) : null;
  const placed = (nodeId: string) => positions[nodeId] ?? described?.get(nodeId) ?? fallback.get(nodeId);

  const entityNodes: CanvasNode[] = visibleEntities.map((entity) => ({
    id: entity.id,
    label: compactGraphLabel(entity.name),
    color: graphColor(entity.name),
    isHub: entity.id === hubId,
    kind: "entity",
    x: placed(entity.id)?.x,
    y: placed(entity.id)?.y,
  }));
  const interfaceNodes: CanvasNode[] = definition.interfaces.map((iface) => {
    const id = interfaceNodeId(iface.id);
    // 转成接口前手工拖过的位置也算数：影子对象类型那一份坐标直接让接口接手。
    const inherited = iface.promotedFromEntityTypeId ? positions[iface.promotedFromEntityTypeId] : undefined;
    const point = positions[id] ?? inherited ?? placed(id);
    return { id, label: `◇ ${compactGraphLabel(iface.name)}`, color: "#7c3aed", isHub: false, kind: "interface", x: point?.x, y: point?.y };
  });

  return {
    nodes: [...entityNodes, ...interfaceNodes],
    edges: drawnEdges,
    frames: layout === "grouped" ? frames : [],
    orphanEntities: visibleEntities.filter((entity) => !connected.has(entity.id)),
    unresolvedRelations: unresolved,
  };
}
