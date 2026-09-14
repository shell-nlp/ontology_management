"use client";

import { useEffect, useMemo, useRef } from "react";
import { ControlsContainer, SigmaContainer, useRegisterEvents, useSigma, ZoomControl } from "@react-sigma/core";
import Graph from "graphology";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import NoverlapLayoutSupervisor from "graphology-layout-noverlap/worker";
import { createNodeCompoundProgram, EdgeArrowProgram, NodeCircleProgram, type NodeLabelDrawingFunction } from "sigma/rendering";
import { newId } from "@/lib/ids";
import "@react-sigma/core/lib/style.css";

export type SigmaNode = {
  id: string;
  label: string;
  color: string;
  isHub: boolean;
  x?: number;
  y?: number;
};

export type SigmaEdge = { id: string; type: string; source: string; target: string };

/** 概念分组的框：一组一个，框里是这一组的节点。 */
export type SigmaGroupFrame = { id: string; name: string; color: string; nodeIds: string[] };

type Props = {
  nodes: SigmaNode[];
  edges: SigmaEdge[];
  /** 「按逻辑分组」布局下的分组框；不传或空数组就不画框。 */
  frames?: SigmaGroupFrame[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  connectionSourceId: string | null;
  draggable: boolean;
  layoutRequest: number;
  onNodeClick: (nodeId: string) => void;
  onEdgeClick: (edgeId: string) => void;
  onStageClick: () => void;
  onDragEnd: (nodeId: string, point: { x: number; y: number }) => void;
  onLayoutEnd: (positions: Record<string, { x: number; y: number }>) => void;
};

type NodeAttributes = { x: number; y: number; size: number; label: string; color: string; textColor?: string; selected?: boolean; dimmed?: boolean; forceLabel: boolean; zIndex: number; type: "internal" };
type EdgeAttributes = { label: string; relationshipType: string; color: string; size: number; type: "arrow"; hidden: boolean };

function initialPoint(index: number, total: number) {
  const ordinal = index + 1;
  const angle = ordinal * Math.PI * (3 - Math.sqrt(5));
  const radius = Math.sqrt(ordinal / Math.max(total, 1)) * Math.max(2.5, Math.sqrt(total) * 0.72);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

const drawInternalNodeLabel: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (context, data) => {
  if (!data.label) return;
  const fontSize = Math.max(9, Math.min(13, data.size / 2.2));
  const maxChars = Math.max(3, Math.min(7, Math.floor((data.size * 2) / fontSize)));
  const visible = data.label.length > maxChars * 2 ? `${data.label.slice(0, maxChars * 2 - 1)}...` : data.label;
  const lines = visible.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [];
  const lineHeight = fontSize * 1.18;
  context.save();
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.strokeStyle = data.dimmed ? "#f1f5f9" : "#ffffff";
  context.lineWidth = 3;
  context.stroke();
  if (data.selected) {
    context.beginPath();
    context.arc(data.x, data.y, data.size + 5, 0, Math.PI * 2);
    context.strokeStyle = "#93b4ff";
    context.lineWidth = 2;
    context.stroke();
  }
  context.fillStyle = data.dimmed ? "#94a3b8" : data.textColor ?? "#ffffff";
  context.font = `700 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, data.x, data.y + (index - (lines.length - 1) / 2) * lineHeight));
  context.restore();
};

const InternalLabelNodeProgram = createNodeCompoundProgram<NodeAttributes, EdgeAttributes>([NodeCircleProgram<NodeAttributes, EdgeAttributes>], undefined, drawInternalNodeLabel);

function pairKey(source: string, target: string) {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
}

function parallelEdgeOffsets(graph: Graph<NodeAttributes, EdgeAttributes>) {
  const groups = new Map<string, string[]>();
  graph.forEachEdge((edge, _attributes, source, target) => {
    if (source === target) return;
    const key = pairKey(source, target);
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  });
  const offsets = new Map<string, number>();
  groups.forEach((edges) => {
    if (edges.length < 2) return;
    edges.sort();
    edges.forEach((edge, index) => {
      const source = graph.source(edge);
      const target = graph.target(edge);
      // Use a stable pair direction so opposite relationships occupy opposite sides of the same connection.
      const direction = source < target ? 1 : -1;
      offsets.set(edge, (index - (edges.length - 1) / 2) * 26 * direction);
    });
  });
  return offsets;
}

function safeRefresh(sigma: ReturnType<typeof useSigma<NodeAttributes, EdgeAttributes>>) {
  try {
    sigma.refresh();
  } catch {
    // SigmaContainer 在 graph/settings 变化时于同一 commit 内 kill 旧实例并创建新实例，
    // 但 context 要等下一 commit 才更新：此刻拿到的仍是已 kill 的实例（nodePrograms 已清空），
    // refresh 会抛 "could not find a suitable program..."。新实例提交后相关 effect 会重新执行。
  }
}

function closestEdgeAt(sigma: ReturnType<typeof useSigma<NodeAttributes, EdgeAttributes>>, point: { x: number; y: number }) {
  let closest: string | null = null;
  let closestDistance = 9;
  const graph = sigma.getGraph();
  const offsets = parallelEdgeOffsets(graph);
  graph.forEachEdge((edge, _attributes, source, target) => {
    const sourcePoint = sigma.graphToViewport(graph.getNodeAttributes(source));
    const targetPoint = sigma.graphToViewport(graph.getNodeAttributes(target));
    if (source === target) {
      const radius = Math.max(16, (sigma.getNodeDisplayData(source)?.size ?? 18) * 0.55 + 8);
      const distance = Math.hypot(point.x - sourcePoint.x, point.y - sourcePoint.y);
      if (point.y < sourcePoint.y + radius * 0.2 && Math.abs(distance - radius * 1.35) < 12) {
        closest = edge;
        closestDistance = 0;
      }
      return;
    }
    const offset = offsets.get(edge);
    if (offset !== undefined) {
      const dx = targetPoint.x - sourcePoint.x;
      const dy = targetPoint.y - sourcePoint.y;
      const length = Math.hypot(dx, dy) || 1;
      const controlX = (sourcePoint.x + targetPoint.x) / 2 - dy / length * offset;
      const controlY = (sourcePoint.y + targetPoint.y) / 2 + dx / length * offset;
      for (let step = 0; step <= 12; step += 1) {
        const t = step / 12;
        const x = (1 - t) ** 2 * sourcePoint.x + 2 * (1 - t) * t * controlX + t ** 2 * targetPoint.x;
        const y = (1 - t) ** 2 * sourcePoint.y + 2 * (1 - t) * t * controlY + t ** 2 * targetPoint.y;
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance < closestDistance) { closest = edge; closestDistance = distance; }
      }
      return;
    }
    const dx = targetPoint.x - sourcePoint.x;
    const dy = targetPoint.y - sourcePoint.y;
    const lengthSquared = dx * dx + dy * dy;
    const progress = lengthSquared ? Math.max(0, Math.min(1, ((point.x - sourcePoint.x) * dx + (point.y - sourcePoint.y) * dy) / lengthSquared)) : 0;
    const distance = Math.hypot(point.x - (sourcePoint.x + progress * dx), point.y - (sourcePoint.y + progress * dy));
    if (distance < closestDistance) {
      closest = edge;
      closestDistance = distance;
    }
  });
  return closest;
}

function buildGraph(nodes: SigmaNode[], edges: SigmaEdge[]) {
  const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: true });
  const nodeSize = nodes.length > 400 ? 12 : nodes.length > 200 ? 16 : nodes.length > 120 ? 18 : nodes.length > 40 ? 22 : nodes.length > 20 ? 26 : 38;
  let nonHubIndex = 0;
  nodes.forEach((node) => {
    // The highest-degree node anchors the graph; all other nodes spread evenly around it.
    const fallback = node.isHub ? { x: 0, y: 0 } : initialPoint(nonHubIndex++, Math.max(nodes.length - 1, 1));
    graph.addNode(node.id, {
      x: Number.isFinite(node.x) ? node.x! : fallback.x,
      y: Number.isFinite(node.y) ? node.y! : fallback.y,
      size: node.isHub ? nodeSize + 6 : nodeSize,
      label: node.label,
      color: node.color,
      type: "internal",
      forceLabel: nodes.length <= 300,
      zIndex: node.isHub ? 2 : 1,
    });
  });
  const parallelIds = new Set<string>();
  const groups = new Map<string, SigmaEdge[]>();
  edges.forEach((edge) => {
    if (edge.source === edge.target) return;
    const key = pairKey(edge.source, edge.target);
    const group = groups.get(key) ?? [];
    group.push(edge);
    groups.set(key, group);
  });
  groups.forEach((group) => { if (group.length > 1) group.forEach((edge) => parallelIds.add(edge.id)); });
  edges.forEach((edge) => {
    if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
      const hidden = true;
      graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, { label: hidden ? "" : edge.type, relationshipType: edge.type, color: "#c3ccda", size: 0.8, type: "arrow", hidden });
    }
  });
  return graph;
}

/**
 * 概念分组框：按成员的屏幕包围盒画一个虚线圆角框，左上角写组名。
 *
 * 用和边线层同一套画法（sigma 的 graphToViewport 换算，afterRender 时重画），
 * 所以拖动节点、缩放镜头时框会跟着一起变。z-index 比边线层低，框永远在线和点下面。
 */
function GroupFrameLayer({ frames }: { frames: SigmaGroupFrame[] }) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();

  useEffect(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(namespace, "svg");
    layer.classList.add("sigma-group-frames");
    layer.setAttribute("aria-hidden", "true");
    sigma.getContainer().appendChild(layer);

    const append = (tag: string, attributes: Record<string, string>) => {
      const element = document.createElementNS(namespace, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
      layer.appendChild(element);
      return element;
    };

    const update = () => {
      const graph = sigma.getGraph();
      const dimensions = sigma.getDimensions();
      if (!layer.isConnected) sigma.getContainer().appendChild(layer);
      layer.setAttribute("width", String(dimensions.width));
      layer.setAttribute("height", String(dimensions.height));
      layer.replaceChildren();
      frames.forEach((frame) => {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const id of frame.nodeIds) {
          if (!graph.hasNode(id)) continue;
          const point = sigma.graphToViewport(graph.getNodeAttributes(id));
          const radius = Math.max(12, sigma.scaleSize(sigma.getNodeDisplayData(id)?.size ?? 18)) + 14;
          minX = Math.min(minX, point.x - radius);
          minY = Math.min(minY, point.y - radius);
          maxX = Math.max(maxX, point.x + radius);
          maxY = Math.max(maxY, point.y + radius);
        }
        if (!Number.isFinite(minX)) return;
        const width = Math.max(48, maxX - minX);
        const height = Math.max(48, maxY - minY);
        // 上面留出一行写组名，组名下面才是节点。
        append("rect", {
          x: String(minX), y: String(minY - 22), width: String(width), height: String(height + 22),
          rx: "14", fill: `${frame.color}0f`, stroke: frame.color, "stroke-width": "1.2", "stroke-dasharray": "6 5",
        });
        const label = append("text", { x: String(minX + 12), y: String(minY - 7), fill: frame.color, "font-size": "12", "font-weight": "700" });
        label.textContent = frame.name;
      });
    };
    update();
    sigma.on("afterRender", update);
    sigma.on("resize", update);
    sigma.getCamera().on("updated", update);
    return () => {
      sigma.off("afterRender", update);
      sigma.off("resize", update);
      sigma.getCamera().off("updated", update);
      layer.remove();
    };
  }, [frames, sigma]);
  return null;
}

function EdgeDecorationLayer({ selectedEdgeId, selectedNodeId }: { selectedEdgeId: string | null; selectedNodeId: string | null }) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();

  useEffect(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(namespace, "svg");
    const markerPrefix = `sigma-edge-arrow-${newId()}`;
    layer.classList.add("sigma-self-loops");
    layer.setAttribute("aria-hidden", "true");
    sigma.getContainer().appendChild(layer);

    const append = (parent: SVGElement, tag: string, attributes: Record<string, string>) => {
      const element = document.createElementNS(namespace, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
      parent.appendChild(element);
      return element;
    };
    const appendMarker = (defs: SVGElement, id: string, fill: string) => {
      const marker = append(defs, "marker", { id, viewBox: "0 0 8 8", refX: "6.2", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
      append(marker, "path", { d: "M 0 0 L 8 4 L 0 8 z", fill });
    };
    const appendEdgeLabel = (parent: SVGElement, x: number, y: number, text: string, color: string) => {
      const width = Math.max(36, text.length * 12 + 14);
      append(parent, "rect", { x: String(x - width / 2), y: String(y - 9), width: String(width), height: "18", rx: "9", fill: "#ffffff", stroke: color === "#1677ff" ? "#bfd2ff" : "#e2e8f0", "stroke-width": "1" });
      const label = append(parent, "text", { x: String(x), y: String(y + 4), fill: color === "#1677ff" ? "#1677ff" : "#526175", "text-anchor": "middle", "font-size": "11", "font-weight": "600" });
      label.textContent = text;
    };

    const update = () => {
      const graph = sigma.getGraph();
      const offsets = parallelEdgeOffsets(graph);
      const showAllRelationshipLabels = graph.size <= 40;
      const dimensions = sigma.getDimensions();
      if (!layer.isConnected) sigma.getContainer().appendChild(layer);
      layer.setAttribute("width", String(dimensions.width));
      layer.setAttribute("height", String(dimensions.height));
      layer.replaceChildren();
      const defs = append(layer, "defs", {});
      const markerBase = `${markerPrefix}-base`;
      const markerHighlight = `${markerPrefix}-highlight`;
      const markerDim = `${markerPrefix}-dim`;
      appendMarker(defs, markerBase, "#c3ccda");
      appendMarker(defs, markerHighlight, "#1677ff");
      appendMarker(defs, markerDim, "#e5eaf2");
      const markerFor = (color: string) => color === "#1677ff" ? markerHighlight : color === "#e5eaf2" ? markerDim : markerBase;

      graph.edges().forEach((edge) => {
        const [source, target] = graph.extremities(edge);
        const data = graph.getEdgeAttributes(edge);
        if (source === target) {
          const point = sigma.graphToViewport(graph.getNodeAttributes(source));
          const displayedSize = sigma.scaleSize(sigma.getNodeDisplayData(source)?.size ?? 18);
          const radius = Math.max(16, displayedSize * 0.55 + 8);
          const isRelated = selectedNodeId !== null && source === selectedNodeId;
          const color = edge === selectedEdgeId ? "#1677ff" : selectedNodeId !== null && !isRelated ? "#e5eaf2" : selectedNodeId !== null ? "#1677ff" : "#c3ccda";
          const topY = point.y - radius * 1.68;
          const group = append(layer, "g", { color });
          append(group, "path", { d: `M ${point.x - radius * 0.54} ${point.y - radius * 0.48} C ${point.x - radius * 1.55} ${topY}, ${point.x + radius * 0.05} ${topY}, ${point.x - radius * 0.08} ${point.y - radius * 0.76}`, fill: "none", stroke: color, "stroke-width": "1", "marker-end": `url(#${markerFor(color)})` });
          const labelText = showAllRelationshipLabels || edge === selectedEdgeId || isRelated ? (data as EdgeAttributes).relationshipType : "";
          if (labelText) appendEdgeLabel(group, point.x - radius * 0.9, topY - 4, labelText, color);
          return;
        }
        const sourcePoint = sigma.graphToViewport(graph.getNodeAttributes(source));
        const targetPoint = sigma.graphToViewport(graph.getNodeAttributes(target));
        const sourceRadius = Math.max(12, sigma.scaleSize(sigma.getNodeDisplayData(source)?.size ?? 18));
        const targetRadius = Math.max(12, sigma.scaleSize(sigma.getNodeDisplayData(target)?.size ?? 18));
        const dx = targetPoint.x - sourcePoint.x;
        const dy = targetPoint.y - sourcePoint.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        const startX = sourcePoint.x + ux * (sourceRadius + 1);
        const startY = sourcePoint.y + uy * (sourceRadius + 1);
        const endX = targetPoint.x - ux * (targetRadius + 3);
        const endY = targetPoint.y - uy * (targetRadius + 3);
        const offset = offsets.get(edge);
        const isRelated = selectedNodeId !== null && (source === selectedNodeId || target === selectedNodeId);
        const color = edge === selectedEdgeId ? "#1677ff" : selectedNodeId !== null && !isRelated ? "#e5eaf2" : selectedNodeId !== null ? "#1677ff" : "#c3ccda";
        const strokeWidth = edge === selectedEdgeId ? "1.8" : selectedNodeId !== null && !isRelated ? "0.7" : selectedNodeId !== null && isRelated ? "1.4" : "1";
        const group = append(layer, "g", { color });
        let labelX = (startX + endX) / 2;
        let labelY = (startY + endY) / 2 - 5;
        if (offset !== undefined) {
          const controlX = (sourcePoint.x + targetPoint.x) / 2 - uy * offset;
          const controlY = (sourcePoint.y + targetPoint.y) / 2 + ux * offset;
          append(group, "path", { d: `M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`, fill: "none", stroke: color, "stroke-width": strokeWidth, "marker-end": `url(#${markerFor(color)})` });
          labelX = (sourcePoint.x + 2 * controlX + targetPoint.x) / 4;
          labelY = (sourcePoint.y + 2 * controlY + targetPoint.y) / 4 - 5;
        } else {
          append(group, "path", { d: `M ${startX} ${startY} L ${endX} ${endY}`, fill: "none", stroke: color, "stroke-width": strokeWidth, "marker-end": `url(#${markerFor(color)})` });
        }
        const labelText = showAllRelationshipLabels || edge === selectedEdgeId || isRelated ? (data as EdgeAttributes).relationshipType : "";
        if (labelText) appendEdgeLabel(group, labelX, labelY, labelText, color);
      });
    };
    update();
    sigma.on("afterRender", update);
    sigma.on("resize", update);
    sigma.getCamera().on("updated", update);
    return () => {
      sigma.off("afterRender", update);
      sigma.off("resize", update);
      sigma.getCamera().off("updated", update);
      layer.remove();
    };
  }, [selectedEdgeId, selectedNodeId, sigma]);
  return null;
}

// 把图数据灌进已有实例，而不是换一个 graph 对象：SigmaContainer 只在 graph/settings 变化时重建实例，
// 而 React 的 effect 在同一 commit 里可能仍拿到已被 kill 的旧实例，那一帧排队的渲染会抛
// “could not find a suitable program for node type” 且不在我们的 try/catch 里。
function SigmaGraphLoader({ graph }: { graph: Graph<NodeAttributes, EdgeAttributes> }) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();
  useEffect(() => {
    const target = sigma.getGraph();
    if (target === graph) return;
    target.clear();
    target.import(graph);
    safeRefresh(sigma);
  }, [graph, sigma]);
  return null;
}

function SigmaScene({ selectedNodeId, selectedEdgeId, connectionSourceId, draggable, layoutRequest, nodes, edges, onNodeClick, onEdgeClick, onStageClick, onDragEnd, onLayoutEnd }: Props) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();
  const registerEvents = useRegisterEvents<NodeAttributes, EdgeAttributes>();
  const graph = sigma.getGraph();
  const draggedNodeRef = useRef<string | null>(null);
  const draggedOriginRef = useRef<{ x: number; y: number } | null>(null);
  const draggedNodeForceLabelRef = useRef(false);
  const layoutRef = useRef<FA2LayoutSupervisor | null>(null);
  const noverlapRef = useRef<NoverlapLayoutSupervisor | null>(null);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedLayoutRequestRef = useRef(0);
  const viewportBBoxRef = useRef<{ x: [number, number]; y: [number, number] } | null>(null);
  const viewportBBoxLockedRef = useRef(false);
  const selectedNeighborhood = useMemo(() => {
    // 用 props 计算而不是读 sigma 的图：图数据是在子组件 effect 里灌入的，渲染阶段读到的还是上一批内容。
    if (!selectedNodeId || !nodes.some((node) => node.id === selectedNodeId)) return null;
    const neighborhood = new Set<string>([selectedNodeId]);
    for (const edge of edges) {
      if (edge.source === selectedNodeId) neighborhood.add(edge.target);
      if (edge.target === selectedNodeId) neighborhood.add(edge.source);
    }
    return neighborhood;
  }, [edges, nodes, selectedNodeId]);

  useEffect(() => {
    try {
      sigma.setSettings({
        nodeReducer: (node, data) => {
          const isSelected = node === selectedNodeId;
          const isConnectionSource = node === connectionSourceId;
          const dimmed = selectedNeighborhood !== null && !selectedNeighborhood.has(node) && !isConnectionSource;
          return {
            ...data,
            selected: isSelected,
            dimmed,
            label: dimmed ? "" : data.label,
            color: isConnectionSource ? "#0f5fd7" : dimmed ? "#e5eaf2" : data.color,
            size: isSelected || isConnectionSource ? data.size + 3.5 : dimmed ? Math.max(10, data.size * 0.85) : data.size,
            textColor: dimmed ? "#94a3b8" : "#ffffff",
            zIndex: isSelected || isConnectionSource ? 4 : dimmed ? 0 : data.zIndex,
          };
        },
        edgeReducer: (edge, data) => {
          const [source, target] = graph.extremities(edge);
          const isSelectedEdge = edge === selectedEdgeId;
          const isRelated = selectedNodeId !== null && (source === selectedNodeId || target === selectedNodeId);
          const dimmed = selectedNeighborhood !== null && !isRelated && !isSelectedEdge;
          return {
            ...data,
            color: isSelectedEdge ? "#1677ff" : dimmed ? "#e5eaf2" : selectedNodeId !== null && isRelated ? "#1677ff" : data.color,
            size: isSelectedEdge ? 1.8 : dimmed ? 0.6 : selectedNodeId !== null && isRelated ? 1.2 : data.size,
            label: selectedNodeId !== null ? (isRelated ? data.relationshipType : "") : data.label,
          };
        },
      });
    } catch {
      // setSettings 内部会触发全量 refresh；当 SigmaContainer 在同一 commit 内替换实例时，
      // 这里的 sigma 是已被 kill 的旧实例，refresh 会对空 program 抛错。
      // 捕获后由下一 commit 的 effect 用新实例重新应用设置。
    }
  }, [connectionSourceId, graph, selectedEdgeId, selectedNeighborhood, selectedNodeId, sigma]);

  useEffect(() => {
    // 松手后收尾：只有真的移动过才锁包围盒、才回写位置——单击（下按与松开落在同一点）只是选中，
    // 否则点一下节点就会冻住视野，之后的重新布局不再适配。
    const finishDrag = (node: string) => {
      const point = sigma.getGraph().getNodeAttributes(node);
      const origin = draggedOriginRef.current;
      const moved = !origin || Math.hypot(point.x - origin.x, point.y - origin.y) > 0.5;
      // 先锁再渲染：safeRefresh 会同步触发 afterRender，此刻若还没锁，视野会跟着新位置重新适配。
      if (moved) viewportBBoxLockedRef.current = true;
      graph.setNodeAttribute(node, "forceLabel", draggedNodeForceLabelRef.current);
      draggedNodeRef.current = null;
      draggedOriginRef.current = null;
      safeRefresh(sigma);
      if (!moved) return;
      onDragEnd(node, { x: point.x, y: point.y });
    };
    registerEvents({
      clickNode: ({ node }) => onNodeClick(node),
      clickEdge: ({ edge }) => onEdgeClick(edge),
      clickStage: ({ event }) => {
        const edge = closestEdgeAt(sigma, event);
        if (edge) onEdgeClick(edge);
        else onStageClick();
      },
      downNode: ({ node, event }) => {
        if (!draggable) return;
        layoutRef.current?.kill();
        noverlapRef.current?.kill();
        draggedNodeRef.current = node;
        const origin = graph.getNodeAttributes(node);
        draggedOriginRef.current = { x: origin.x, y: origin.y };
        draggedNodeForceLabelRef.current = graph.getNodeAttribute(node, "forceLabel");
        graph.setNodeAttribute(node, "forceLabel", true);
        safeRefresh(sigma);
        event.preventSigmaDefault();
      },
      moveBody: ({ event }) => {
        const node = draggedNodeRef.current;
        if (!node) return;
        event.preventSigmaDefault();
        const point = sigma.viewportToGraph(event);
        sigma.getGraph().mergeNodeAttributes(node, point);
      },
      upNode: ({ event }) => {
        const node = draggedNodeRef.current;
        if (!node) return;
        event.preventSigmaDefault();
        finishDrag(node);
      },
      upStage: () => {
        const node = draggedNodeRef.current;
        if (!node) return;
        finishDrag(node);
      },
    });
  }, [draggable, graph, onDragEnd, onEdgeClick, onNodeClick, onStageClick, registerEvents, sigma]);

  useEffect(() => () => {
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    layoutRef.current?.kill();
    noverlapRef.current?.kill();
  }, []);

  // Sigma 默认把镜头缩放绑在当前所有节点的包围盒上：拖动节点一旦越出包围盒，整张图会跟着缩放，
  // 观感就是“节点和边一起整体变动”。这里在拖拽期间锁住包围盒，只有重新布局或重建画布时才重新跟随。
  useEffect(() => {
    viewportBBoxRef.current = null;
    viewportBBoxLockedRef.current = false;
    const followNodesExtent = () => {
      if (draggedNodeRef.current || viewportBBoxLockedRef.current || !graph.order) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      graph.forEachNode((_node, attributes) => {
        if (attributes.x < minX) minX = attributes.x;
        if (attributes.x > maxX) maxX = attributes.x;
        if (attributes.y < minY) minY = attributes.y;
        if (attributes.y > maxY) maxY = attributes.y;
      });
      const next = { x: [minX, maxX] as [number, number], y: [minY, maxY] as [number, number] };
      const current = viewportBBoxRef.current;
      if (current && current.x[0] === next.x[0] && current.x[1] === next.x[1] && current.y[0] === next.y[0] && current.y[1] === next.y[1]) return;
      viewportBBoxRef.current = next;
      sigma.setCustomBBox(next);
      safeRefresh(sigma);
    };
    sigma.on("afterRender", followNodesExtent);
    // 内容变化（换本体存储、改筛选、自动整理）后先对齐一次：新数据是在前一个子组件 effect 里灌进去的，
    // 那一帧的 afterRender 早于本监听器注册，只靠 afterRender 会漏掉这次适配。
    followNodesExtent();
    // “适应画布”会把镜头重置为铺满整张图的默认状态，此时放开包围盒，让视野重新包含被拖远的节点。
    const releaseLockOnFit = () => {
      const camera = sigma.getCamera().getState();
      if (camera.x === 0.5 && camera.y === 0.5 && camera.ratio === 1 && camera.angle === 0) viewportBBoxLockedRef.current = false;
    };
    sigma.getCamera().on("updated", releaseLockOnFit);
    return () => {
      sigma.off("afterRender", followNodesExtent);
      sigma.getCamera().off("updated", releaseLockOnFit);
    };
  }, [edges, graph, nodes, sigma]);

  useEffect(() => {
    if (!layoutRequest || graph.order < 2 || completedLayoutRequestRef.current === layoutRequest) return;
    completedLayoutRequestRef.current = layoutRequest;
    viewportBBoxLockedRef.current = false;
    layoutRef.current?.kill();
    noverlapRef.current?.kill();
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    const supervisor = new FA2LayoutSupervisor(graph, {
      settings: { barnesHutOptimize: graph.order > 500, adjustSizes: true, linLogMode: false, gravity: graph.order <= 80 ? 0.35 : graph.order > 150 ? 0.6 : 1, scalingRatio: graph.order <= 80 ? 30 : graph.order > 150 ? 18 : 12, slowDown: 8 },
    });
    layoutRef.current = supervisor;
    supervisor.start();
    layoutTimerRef.current = setTimeout(() => {
      supervisor.stop();
      if (layoutRef.current === supervisor) layoutRef.current = null;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        noverlap.stop();
        noverlap.kill();
        if (noverlapRef.current === noverlap) noverlapRef.current = null;
        const positions = Object.fromEntries(graph.nodes().map((id) => {
          const point = graph.getNodeAttributes(id);
          return [id, { x: point.x, y: point.y }];
        }));
        safeRefresh(sigma);
        onLayoutEnd(positions);
      };
      const noverlap = new NoverlapLayoutSupervisor(graph, {
        inputReducer: (_id, attributes) => ({ x: attributes.x, y: attributes.y, size: Math.max(8, attributes.size ?? 18) }),
        outputReducer: (_id, attributes) => ({ x: attributes.x, y: attributes.y }),
        onConverged: finish,
        settings: { gridSize: graph.order > 1000 ? 30 : 20, margin: 0.3, expansion: 1.15, ratio: 1, speed: 3 },
      });
      noverlapRef.current = noverlap;
      noverlap.start();
      layoutTimerRef.current = setTimeout(finish, Math.min(1600, Math.max(700, Math.round(420 + Math.sqrt(graph.order) * 24))));
    }, Math.min(1500, Math.max(650, Math.round(420 + Math.sqrt(graph.order) * 22))));
  }, [graph, layoutRequest, onLayoutEnd, sigma]);

  return <ControlsContainer position="bottom-left"><ZoomControl labels={{ zoomIn: "放大", zoomOut: "缩小", reset: "适应画布" }} /></ControlsContainer>;
}

export function SigmaGraph(props: Props) {
  // SigmaContainer 一旦收到不同的 graph 对象就会 kill 旧实例、新建一个；这里始终传同一个空图，
  // 数据由 SigmaGraphLoader 原地灌进当前实例，实例只创建一次（切筛选、切本体存储都不会再重建）。
  const containerGraph = useMemo(() => buildGraph([], []), []);
  const loadedGraph = useMemo(() => buildGraph(props.nodes, props.edges), [props.edges, props.nodes]);
  return (
    <SigmaContainer
      className="graph-sigma-canvas"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      graph={containerGraph}
      settings={{
        hideLabelsOnMove: false,
        hideEdgesOnMove: false,
        renderLabels: true,
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: props.nodes.length > 500 ? 6 : 0,
        labelDensity: props.nodes.length > 500 ? 0.5 : props.nodes.length > 200 ? 0.75 : 1,
        labelGridCellSize: props.nodes.length > 500 ? 180 : props.nodes.length > 200 ? 150 : 110,
        labelFont: "ui-sans-serif, system-ui, sans-serif",
        labelWeight: "600",
        labelSize: 10,
        labelColor: { color: "#274548" },
        edgeLabelColor: { color: "#536975" },
        edgeLabelSize: 10,
        stagePadding: 72,
        zIndex: true,
        enableEdgeEvents: true,
        minCameraRatio: 0.04,
        maxCameraRatio: 4,
        nodeProgramClasses: { internal: InternalLabelNodeProgram },
        edgeProgramClasses: { arrow: EdgeArrowProgram },
        defaultDrawNodeLabel: drawInternalNodeLabel,
        defaultDrawNodeHover: drawInternalNodeLabel,
      }}
    >
      <SigmaGraphLoader graph={loadedGraph} />
      <SigmaScene {...props} />
      {props.frames && props.frames.length > 0 && <GroupFrameLayer frames={props.frames} />}
      <EdgeDecorationLayer selectedEdgeId={props.selectedEdgeId} selectedNodeId={props.selectedNodeId} />
    </SigmaContainer>
  );
}
