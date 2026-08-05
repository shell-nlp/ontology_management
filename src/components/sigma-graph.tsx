"use client";

import { useEffect, useMemo, useRef } from "react";
import { ControlsContainer, SigmaContainer, useRegisterEvents, useSigma, ZoomControl } from "@react-sigma/core";
import Graph from "graphology";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker";
import NoverlapLayoutSupervisor from "graphology-layout-noverlap/worker";
import { createNodeCompoundProgram, EdgeArrowProgram, NodeCircleProgram, type NodeLabelDrawingFunction } from "sigma/rendering";
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

type Props = {
  nodes: SigmaNode[];
  edges: SigmaEdge[];
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

type NodeAttributes = { x: number; y: number; size: number; label: string; color: string; forceLabel: boolean; zIndex: number; type: "internal" };
type EdgeAttributes = { label: string; relationshipType: string; color: string; size: number; type: "arrow"; hidden: boolean };

function initialPoint(index: number, total: number) {
  const ordinal = index + 1;
  const angle = ordinal * Math.PI * (3 - Math.sqrt(5));
  const radius = Math.sqrt(ordinal / Math.max(total, 1)) * Math.max(2.5, Math.sqrt(total) * 0.72);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

const drawInternalNodeLabel: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (context, data) => {
  if (!data.label) return;
  const fontSize = Math.max(8, Math.min(10, data.size / 3));
  const maxChars = Math.max(3, Math.floor((data.size * 1.85) / fontSize));
  const visible = data.label.length > maxChars * 2 ? `${data.label.slice(0, maxChars * 2 - 1)}...` : data.label;
  const lines = visible.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [];
  const lineHeight = fontSize * 1.18;
  context.save();
  context.fillStyle = "#183234";
  context.font = `800 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, data.x, data.y + (index - (lines.length - 1) / 2) * lineHeight));
  context.restore();
};

const InternalLabelNodeProgram = createNodeCompoundProgram<NodeAttributes, EdgeAttributes>([NodeCircleProgram<NodeAttributes, EdgeAttributes>], undefined, drawInternalNodeLabel);

function nodeFillColor(color: string) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const lighten = (channel: number) => Math.round(channel * 0.24 + 255 * 0.76).toString(16).padStart(2, "0");
  return `#${lighten(red)}${lighten(green)}${lighten(blue)}`;
}

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
  const nodeSize = nodes.length > 150 ? 13 : nodes.length > 80 ? 18 : 30;
  let nonHubIndex = 0;
  nodes.forEach((node) => {
    // The highest-degree node anchors the graph; all other nodes spread evenly around it.
    const fallback = node.isHub ? { x: 0, y: 0 } : initialPoint(nonHubIndex++, Math.max(nodes.length - 1, 1));
    graph.addNode(node.id, {
      x: Number.isFinite(node.x) ? node.x! : fallback.x,
      y: Number.isFinite(node.y) ? node.y! : fallback.y,
      size: node.isHub ? nodeSize + 6 : nodeSize,
      label: node.label,
      color: nodeFillColor(node.color),
      type: "internal",
      forceLabel: nodes.length <= 120,
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
      const hidden = edge.source === edge.target || parallelIds.has(edge.id);
      graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, { label: hidden ? "" : edge.type, relationshipType: edge.type, color: "#718692", size: 1.2, type: "arrow", hidden });
    }
  });
  return graph;
}

function EdgeDecorationLayer({ selectedEdgeId }: { selectedEdgeId: string | null }) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();

  useEffect(() => {
    const namespace = "http://www.w3.org/2000/svg";
    const layer = document.createElementNS(namespace, "svg");
    const markerId = `sigma-edge-arrow-${crypto.randomUUID()}`;
    layer.classList.add("sigma-self-loops");
    layer.setAttribute("aria-hidden", "true");
    sigma.getContainer().appendChild(layer);

    const append = (parent: SVGElement, tag: string, attributes: Record<string, string>) => {
      const element = document.createElementNS(namespace, tag);
      Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
      parent.appendChild(element);
      return element;
    };

    const update = () => {
      const graph = sigma.getGraph();
      const offsets = parallelEdgeOffsets(graph);
      const dimensions = sigma.getDimensions();
      if (!layer.isConnected) sigma.getContainer().appendChild(layer);
      layer.setAttribute("width", String(dimensions.width));
      layer.setAttribute("height", String(dimensions.height));
      layer.replaceChildren();
      const defs = append(layer, "defs", {});
      const marker = append(defs, "marker", { id: markerId, viewBox: "0 0 8 8", refX: "6.2", refY: "4", markerWidth: "6", markerHeight: "6", orient: "auto" });
      append(marker, "path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "#718692" });

      graph.edges().forEach((edge) => {
        const [source, target] = graph.extremities(edge);
        if (source !== target) return;
        const point = sigma.graphToViewport(graph.getNodeAttributes(source));
        const radius = Math.max(16, (sigma.getNodeDisplayData(source)?.size ?? 18) * 0.55 + 8);
        const data = graph.getEdgeAttributes(edge);
        const color = edge === selectedEdgeId ? "#c89137" : "#718692";
        const startX = point.x - radius * 0.54;
        const startY = point.y - radius * 0.48;
        const endX = point.x - radius * 0.08;
        const endY = point.y - radius * 0.76;
        const topY = point.y - radius * 1.68;
        const group = append(layer, "g", { color });
        append(group, "path", { d: `M ${startX} ${startY} C ${point.x - radius * 1.55} ${topY}, ${point.x + radius * 0.05} ${topY}, ${endX} ${endY}`, fill: "none", stroke: color, "stroke-width": "1.5", "marker-end": `url(#${markerId})` });
        const label = append(group, "text", { x: String(point.x - radius * 0.9), y: String(topY - 4), fill: color, "text-anchor": "middle" });
        label.textContent = (data as EdgeAttributes).relationshipType;
      });

      graph.edges().forEach((edge) => {
        const offset = offsets.get(edge);
        if (offset === undefined) return;
        const [source, target] = graph.extremities(edge);
        const sourcePoint = sigma.graphToViewport(graph.getNodeAttributes(source));
        const targetPoint = sigma.graphToViewport(graph.getNodeAttributes(target));
        const dx = targetPoint.x - sourcePoint.x;
        const dy = targetPoint.y - sourcePoint.y;
        const length = Math.hypot(dx, dy) || 1;
        const controlX = (sourcePoint.x + targetPoint.x) / 2 - dy / length * offset;
        const controlY = (sourcePoint.y + targetPoint.y) / 2 + dx / length * offset;
        const data = graph.getEdgeAttributes(edge);
        const color = edge === selectedEdgeId ? "#c89137" : "#718692";
        const labelX = (sourcePoint.x + 2 * controlX + targetPoint.x) / 4;
        const labelY = (sourcePoint.y + 2 * controlY + targetPoint.y) / 4;
        const group = append(layer, "g", { color });
        append(group, "path", { d: `M ${sourcePoint.x} ${sourcePoint.y} Q ${controlX} ${controlY} ${targetPoint.x} ${targetPoint.y}`, fill: "none", stroke: color, "stroke-width": "1.35", "marker-end": `url(#${markerId})` });
        const label = append(group, "text", { x: String(labelX), y: String(labelY - 5), fill: color, "text-anchor": "middle" });
        label.textContent = (data as EdgeAttributes).relationshipType;
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
  }, [selectedEdgeId, sigma]);
  return null;
}

function SigmaScene({ graph, selectedNodeId, selectedEdgeId, connectionSourceId, draggable, layoutRequest, onNodeClick, onEdgeClick, onStageClick, onDragEnd, onLayoutEnd }: Props & { graph: Graph<NodeAttributes, EdgeAttributes> }) {
  const sigma = useSigma<NodeAttributes, EdgeAttributes>();
  const registerEvents = useRegisterEvents<NodeAttributes, EdgeAttributes>();
  const draggedNodeRef = useRef<string | null>(null);
  const draggedNodeForceLabelRef = useRef(false);
  const layoutRef = useRef<FA2LayoutSupervisor | null>(null);
  const noverlapRef = useRef<NoverlapLayoutSupervisor | null>(null);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completedLayoutRequestRef = useRef(0);

  useEffect(() => {
    sigma.setSettings({
      nodeReducer: (node, data) => ({
        ...data,
        color: node === connectionSourceId ? "#b9e8d7" : node === selectedNodeId ? "#f4d99f" : data.color,
        size: node === selectedNodeId || node === connectionSourceId ? data.size + 2.8 : data.size,
        zIndex: node === selectedNodeId || node === connectionSourceId ? 4 : data.zIndex,
      }),
      edgeReducer: (edge, data) => ({ ...data, color: edge === selectedEdgeId ? "#c89137" : data.color, size: edge === selectedEdgeId ? 2.5 : data.size }),
    });
    sigma.refresh();
  }, [connectionSourceId, selectedEdgeId, selectedNodeId, sigma]);

  useEffect(() => {
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
        draggedNodeForceLabelRef.current = graph.getNodeAttribute(node, "forceLabel");
        graph.setNodeAttribute(node, "forceLabel", true);
        sigma.refresh();
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
        const point = sigma.getGraph().getNodeAttributes(node);
        graph.setNodeAttribute(node, "forceLabel", draggedNodeForceLabelRef.current);
        draggedNodeRef.current = null;
        sigma.refresh();
        onDragEnd(node, { x: point.x, y: point.y });
      },
      upStage: () => {
        const node = draggedNodeRef.current;
        if (!node) return;
        const point = sigma.getGraph().getNodeAttributes(node);
        graph.setNodeAttribute(node, "forceLabel", draggedNodeForceLabelRef.current);
        draggedNodeRef.current = null;
        sigma.refresh();
        onDragEnd(node, { x: point.x, y: point.y });
      },
    });
  }, [draggable, graph, onDragEnd, onEdgeClick, onNodeClick, onStageClick, registerEvents, sigma]);

  useEffect(() => () => {
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    layoutRef.current?.kill();
    noverlapRef.current?.kill();
  }, []);

  useEffect(() => {
    if (!layoutRequest || graph.order < 2 || completedLayoutRequestRef.current === layoutRequest) return;
    completedLayoutRequestRef.current = layoutRequest;
    layoutRef.current?.kill();
    noverlapRef.current?.kill();
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    const supervisor = new FA2LayoutSupervisor(graph, {
      settings: { barnesHutOptimize: graph.order > 500, adjustSizes: false, linLogMode: false, gravity: 1, scalingRatio: 12, slowDown: 8 },
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
        sigma.refresh();
        onLayoutEnd(positions);
      };
      const noverlap = new NoverlapLayoutSupervisor(graph, {
        inputReducer: (_id, attributes) => ({ x: attributes.x, y: attributes.y, size: 0.25 }),
        outputReducer: (_id, attributes) => ({ x: attributes.x, y: attributes.y }),
        onConverged: finish,
        settings: { gridSize: graph.order > 1000 ? 30 : 20, margin: 0.08, expansion: 1.04, ratio: 1, speed: 2 },
      });
      noverlapRef.current = noverlap;
      noverlap.start();
      layoutTimerRef.current = setTimeout(finish, Math.min(1600, Math.max(700, Math.round(420 + Math.sqrt(graph.order) * 24))));
    }, Math.min(1500, Math.max(650, Math.round(420 + Math.sqrt(graph.order) * 22))));
  }, [graph, layoutRequest, onLayoutEnd, sigma]);

  return <ControlsContainer position="bottom-left"><ZoomControl labels={{ zoomIn: "放大", zoomOut: "缩小", reset: "适应画布" }} /></ControlsContainer>;
}

export function SigmaGraph(props: Props) {
  const graph = useMemo(() => buildGraph(props.nodes, props.edges), [props.edges, props.nodes]);
  return (
    <SigmaContainer
      className="graph-sigma-canvas"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      graph={graph}
      settings={{
        hideLabelsOnMove: false,
        hideEdgesOnMove: false,
        renderLabels: true,
        renderEdgeLabels: props.nodes.length < 180,
        labelRenderedSizeThreshold: props.nodes.length > 150 ? 1 : 8,
        labelDensity: props.nodes.length > 500 ? 0.5 : props.nodes.length > 150 ? 1 : 0.8,
        labelGridCellSize: props.nodes.length > 500 ? 180 : props.nodes.length > 150 ? 160 : 100,
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
      <SigmaScene {...props} graph={graph} />
      <EdgeDecorationLayer selectedEdgeId={props.selectedEdgeId} />
    </SigmaContainer>
  );
}
