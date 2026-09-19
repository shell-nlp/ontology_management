"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { CircleDot, Eye, EyeOff, Link2, LocateFixed, Network, Pencil, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { PropertyEditor } from "@/components/property-editor";
import { LayoutSwitcher, useLayoutMode } from "@/components/layout-switcher";
import { buildGroupFrames, circleLayout, groupedLayoutPositions } from "@/lib/concept-groups";
import type { SigmaEdge, SigmaNode } from "@/components/sigma-graph";
import type { PropertyDefinition } from "@/lib/instance-property-editor";
import type { GraphData, GraphNode, GraphRelationship, RuntimeTypeSet } from "@/lib/graph/types";
import { compactGraphLabel, graphColor } from "@/lib/graph-palette";
import { readStoredPositions, writeStoredPositions, type NodePositions } from "@/lib/local-layout";
import "./graph-canvas.css";

const SigmaGraph = dynamic(() => import("@/components/sigma-graph").then((module) => module.SigmaGraph), { ssr: false });

type User = { role: "ADMIN" | "VIEWER" } | null;

type OntologyPropertyDefinition = PropertyDefinition & { unique?: boolean; indexed?: boolean };

type ManagedDefinition = {
  entityTypes: { id?: string; name: string; description?: string; displayProperty?: string; groupId?: string; properties: OntologyPropertyDefinition[] }[];
  relationshipTypes: { id?: string; name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string; properties: OntologyPropertyDefinition[] }[];
  /** 概念分组：只影响「查看本体」这一页怎么摆、怎么画框。 */
  groups?: { id: string; name: string; color?: string }[];
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function graphLabel(node: GraphNode, displayProps?: Map<string, string>) {
  if (displayProps) {
    for (const label of node.labels) {
      const key = displayProps.get(label);
      if (key) {
        const value = node.properties[key];
        if (typeof value === "string" || typeof value === "number") return String(value);
      }
    }
  }
  const preferred = ["name", "名称", "title", "id"].map((key) => node.properties[key]).find((value) => typeof value === "string" || typeof value === "number");
  return String(preferred ?? node.labels[0] ?? "节点");
}

function propertyValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const REPRESENTATIVE_NODE_LIMIT = 30;
const REPRESENTATIVE_MIN_PER_LABEL = 2;

type RepresentativeGraph = {
  graph: GraphData;
  hiddenBoundaryRelationships: number;
  hiddenNodes: number;
  hiddenRelationships: number;
};

function buildRepresentativeSubgraph(graph: GraphData): RepresentativeGraph {
  if (graph.nodes.length <= REPRESENTATIVE_NODE_LIMIT) {
    return { graph, hiddenBoundaryRelationships: 0, hiddenNodes: 0, hiddenRelationships: 0 };
  }

  const degree = new Map<string, number>();
  graph.nodes.forEach((node) => degree.set(node.id, 0));
  graph.relationships.forEach((relationship) => {
    degree.set(relationship.source, (degree.get(relationship.source) ?? 0) + 1);
    degree.set(relationship.target, (degree.get(relationship.target) ?? 0) + 1);
  });
  const byDegree = [...graph.nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id));
  const byLabel = new Map<string, GraphNode[]>();
  byDegree.forEach((node) => {
    const label = node.labels[0] ?? "未标注";
    const list = byLabel.get(label) ?? [];
    list.push(node);
    byLabel.set(label, list);
  });

  const selected = new Set<string>();
  for (const nodes of byLabel.values()) {
    for (const node of nodes.slice(0, REPRESENTATIVE_MIN_PER_LABEL)) {
      selected.add(node.id);
      if (selected.size >= REPRESENTATIVE_NODE_LIMIT) break;
    }
    if (selected.size >= REPRESENTATIVE_NODE_LIMIT) break;
  }
  for (const node of byDegree) {
    if (selected.size >= REPRESENTATIVE_NODE_LIMIT) break;
    selected.add(node.id);
  }

  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const relationships = graph.relationships.filter((relationship) => selected.has(relationship.source) && selected.has(relationship.target));
  const hiddenBoundaryRelationships = graph.relationships.filter((relationship) => selected.has(relationship.source) !== selected.has(relationship.target)).length;
  return {
    graph: { nodes, relationships },
    hiddenBoundaryRelationships,
    hiddenNodes: graph.nodes.length - nodes.length,
    hiddenRelationships: graph.relationships.length - relationships.length,
  };
}

function storedLayoutIsUsable(nodes: GraphNode[]) {
  const points = nodes.map((node) => storedPosition(node)).filter((point): point is { x: number; y: number } => point !== null);
  if (!nodes.length || points.length / nodes.length < 0.8) return false;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const minWidth = Math.max(120, Math.sqrt(nodes.length) * 40);
  const minHeight = Math.max(100, Math.sqrt(nodes.length) * 30);
  return width >= minWidth && height >= minHeight;
}

function computeStableNodePositions(nodes: SigmaNode[], edges: SigmaEdge[], seed = 0) {
  const positions = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return positions;
  if (nodes.length === 1) {
    positions.set(nodes[0].id, { x: 0, y: 0 });
    return positions;
  }

  const degree = new Map(nodes.map((node) => [node.id, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  });
  const ordered = [...nodes].sort((left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id));
  const initialRadius = Math.max(70, Math.min(280, 36 + nodes.length * 7));
  const rotation = (seed % 12) * (Math.PI / 6);
  ordered.forEach((node, index) => {
    if (index === 0) {
      positions.set(node.id, { x: 0, y: 0 });
      return;
    }
    const angle = rotation + index * Math.PI * (3 - Math.sqrt(5));
    const radius = initialRadius * Math.sqrt(index / (nodes.length - 1));
    positions.set(node.id, { x: Math.cos(angle) * radius * 1.3, y: Math.sin(angle) * radius });
  });

  const clampX = 340;
  const clampY = 245;
  const minDistance = 86;
  const idealEdgeLength = Math.max(120, Math.min(220, 90 + nodes.length * 3));
  const velocity = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
  const clampPoint = (point: { x: number; y: number }) => {
    point.x = Math.max(-clampX, Math.min(clampX, point.x));
    point.y = Math.max(-clampY, Math.min(clampY, point.y));
  };

  for (let iteration = 0; iteration < 160; iteration += 1) {
    for (let left = 0; left < ordered.length; left += 1) {
      const a = positions.get(ordered[left].id)!;
      const velocityA = velocity.get(ordered[left].id)!;
      for (let right = left + 1; right < ordered.length; right += 1) {
        const b = positions.get(ordered[right].id)!;
        const velocityB = velocity.get(ordered[right].id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        if (distance < minDistance * 2.1) {
          const push = (minDistance * 2.1 - distance) * 0.016;
          dx /= distance;
          dy /= distance;
          velocityA.x -= dx * push;
          velocityA.y -= dy * push;
          velocityB.x += dx * push;
          velocityB.y += dy * push;
        }
      }
    }
    edges.forEach((edge) => {
      const source = positions.get(edge.source);
      const target = positions.get(edge.target);
      if (!source || !target) return;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 0.001;
      const force = (distance - idealEdgeLength) * 0.008;
      dx /= distance;
      dy /= distance;
      const sourceVelocity = velocity.get(edge.source)!;
      const targetVelocity = velocity.get(edge.target)!;
      sourceVelocity.x += dx * force;
      sourceVelocity.y += dy * force;
      targetVelocity.x -= dx * force;
      targetVelocity.y -= dy * force;
    });
    ordered.forEach((node) => {
      const point = positions.get(node.id)!;
      const nodeVelocity = velocity.get(node.id)!;
      nodeVelocity.x -= point.x * 0.0035;
      nodeVelocity.y -= point.y * 0.0035;
      point.x += nodeVelocity.x;
      point.y += nodeVelocity.y;
      nodeVelocity.x *= 0.82;
      nodeVelocity.y *= 0.82;
      clampPoint(point);
    });
  }

  for (let iteration = 0; iteration < 80; iteration += 1) {
    let moved = false;
    for (let left = 0; left < ordered.length; left += 1) {
      const a = positions.get(ordered[left].id)!;
      for (let right = left + 1; right < ordered.length; right += 1) {
        const b = positions.get(ordered[right].id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.001;
        if (distance >= minDistance) continue;
        const push = (minDistance - distance) / 2;
        dx /= distance;
        dy /= distance;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
        clampPoint(a);
        clampPoint(b);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return positions;
}

function OntologyPropertyList({ properties }: { properties: OntologyPropertyDefinition[] }) {
  if (!properties.length) return <small>此类型未定义属性。</small>;
  return <div className="ontology-property-list">{properties.map((property) => {
    const constraints = [property.required ? "必填" : "可选", property.unique ? "唯一" : "", property.indexed ? "索引" : ""].filter(Boolean).join(" · ");
    return <div className="ontology-property-rule" key={property.name}><b>{property.name}</b><span>{property.dataType}</span><small>{constraints}</small></div>;
  })}</div>;
}

function storedPosition(node: GraphNode) {
  const x = node.properties.fx;
  const y = node.properties.fy;
  if (typeof x === "number" && typeof y === "number") return { x, y };
  return null;
}

function buildAdjacency(relationships: GraphRelationship[]) {
  const adjacency = new Map<string, string[]>();
  for (const relationship of relationships) {
    let sourceList = adjacency.get(relationship.source);
    if (!sourceList) adjacency.set(relationship.source, sourceList = []);
    sourceList.push(relationship.target);
    let targetList = adjacency.get(relationship.target);
    if (!targetList) adjacency.set(relationship.target, targetList = []);
    targetList.push(relationship.source);
  }
  return adjacency;
}

function hubNodeId(nodes: GraphNode[], relationships: GraphRelationship[]) {
  if (!nodes.length) return null;
  const adjacency = buildAdjacency(relationships);
  let hubId: string | null = null;
  let maxDegree = -1;
  for (const node of nodes) {
    const degree = adjacency.get(node.id)?.length ?? 0;
    if (degree > maxDegree || (degree === maxDegree && (hubId === null || node.id < hubId))) { maxDegree = degree; hubId = node.id; }
  }
  return hubId ?? nodes[0].id;
}

type EditTarget = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

export function GraphCanvas({
  graph,
  targetId,
  versionId,
  user,
  editable = false,
  definition = null,
  viewMode = "instance",
  runtimeTypes,
  onExpand,
  onRefresh,
  onTypeFilterChange,
  notify,
  fail,
}: {
  graph: GraphData;
  targetId?: string;
  versionId?: string;
  user?: User;
  editable?: boolean;
  definition?: ManagedDefinition | null;
  viewMode?: "instance" | "ontology";
  runtimeTypes?: RuntimeTypeSet;
  onExpand?: (nodeId: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  onTypeFilterChange?: (filters: { labels: string[]; relationshipTypes: string[] }) => void;
  notify?: (text: string) => void;
  fail?: (reason: unknown) => void;
}) {
  const admin = editable && user?.role === "ADMIN" && Boolean(targetId) && Boolean(versionId);
  const [search, setSearch] = useState("");
  const [activeLabels, setActiveLabels] = useState<string[]>([]);
  const [activeRelationshipTypes, setActiveRelationshipTypes] = useState<string[]>([]);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [pendingConnection, setPendingConnection] = useState<{ source: string; target: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [layoutRequest, setLayoutRequest] = useState(0);
  const [layoutSeed, setLayoutSeed] = useState(0);
  const persistLayoutRef = useRef(false);
  // 有草稿可写时摆放位置进快照；只读浏览发布数据、看本体骨架时只记在本机浏览器。
  const persistsPositions = admin && Boolean(targetId) && Boolean(versionId) && viewMode !== "ontology";
  const localLayoutKey = targetId && !persistsPositions ? `${viewMode === "ontology" ? "ontology" : "instance"}-layout:${targetId}` : null;
  // 「查看本体」才有布局可选：分组是对象类型这一层的东西，实例图谱不看它。
  const [layout, setLayout] = useLayoutMode(viewMode === "ontology" && targetId ? `ontology-layout-mode:${targetId}` : null);
  /*
   * 本机记的摆放位置**按布局分开**：默认布局沿用老键，圆形 / 按逻辑分组各用各的。
   * 拖过的节点是"覆盖"，压在算出来的坐标上面 —— 分组框按节点实时位置画，所以框会跟着一起收放。
   */
  const layoutOverrideKey = localLayoutKey && layout !== "default" ? `${localLayoutKey}:${layout}` : localLayoutKey;
  const frameGroups = useMemo(() => (definition?.groups ?? []).map((group) => ({ id: group.id, name: group.name, color: group.color ?? "" })), [definition]);
  const frameTypes = useMemo(() => (definition?.entityTypes ?? []).map((item) => ({ id: item.id ?? item.name, name: item.name, groupId: item.groupId ?? "" })), [definition]);
  const [showAllForGraph, setShowAllForGraph] = useState<GraphData | null>(null);
  const showAllGraph = showAllForGraph === graph;
  const representative = useMemo(
    () => showAllGraph ? { graph, hiddenBoundaryRelationships: 0, hiddenNodes: 0, hiddenRelationships: 0 } : buildRepresentativeSubgraph(graph),
    [graph, showAllGraph],
  );
  const displayGraph = representative.graph;

  // Run a display-only layout on first load when the graph has no saved positions.
  // Manual "自动整理" still persists the resulting positions through onLayoutEnd.
  useEffect(() => {
    if (graph.nodes.length < 2) return;
    if (graph.nodes.length <= 60) return;
    if (graph.nodes.every((node) => storedPosition(node))) return;
    const timer = window.setTimeout(() => setLayoutRequest((request) => request + 1), 0);
    return () => window.clearTimeout(timer);
  }, [graph]);

  const nodeTypes = useMemo(() => {
    const types = new Map((runtimeTypes?.labels ?? []).map((item) => [item.name, item.count]));
    for (const node of displayGraph.nodes) for (const label of node.labels) if (!types.has(label)) types.set(label, 0);
    return [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [displayGraph.nodes, runtimeTypes?.labels]);
  const relationshipTypes = useMemo(() => {
    const types = new Map((runtimeTypes?.relationshipTypes ?? []).map((item) => [item.name, item.count]));
    for (const relationship of displayGraph.relationships) if (!types.has(relationship.type)) types.set(relationship.type, 0);
    return [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [displayGraph.relationships, runtimeTypes?.relationshipTypes]);
  const totalNodeCount = runtimeTypes ? runtimeTypes.labels.reduce((total, item) => total + item.count, 0) : graph.nodes.length;
  const totalRelationshipCount = runtimeTypes ? runtimeTypes.relationshipTypes.reduce((total, item) => total + item.count, 0) : graph.relationships.length;
  const displayProps = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of definition?.entityTypes ?? []) {
      if (item.displayProperty) map.set(item.name, item.displayProperty);
    }
    return map;
  }, [definition]);
  const visibleNodeIds = useMemo(() => new Set(displayGraph.nodes.filter((node) => {
    const haystack = `${graphLabel(node, displayProps)} ${node.labels.join(" ")} ${Object.values(node.properties).map(propertyValue).join(" ")}`.toLocaleLowerCase();
    const labelMatches = !activeLabels.length || node.labels.some((label) => activeLabels.includes(label));
    return labelMatches && haystack.includes(search.trim().toLocaleLowerCase());
  }).map((node) => node.id)), [activeLabels, displayProps, displayGraph.nodes, search]);
  const visibleRelationships = useMemo(() => displayGraph.relationships.filter((relationship) => {
    return visibleNodeIds.has(relationship.source)
      && visibleNodeIds.has(relationship.target)
      && (!activeRelationshipTypes.length || activeRelationshipTypes.includes(relationship.type));
  }), [activeRelationshipTypes, displayGraph.relationships, visibleNodeIds]);

  const selectedNode = editTarget?.kind === "node" ? displayGraph.nodes.find((node) => node.id === editTarget.id) ?? null : null;
  const selectedEdge = editTarget?.kind === "edge" ? displayGraph.relationships.find((relationship) => relationship.id === editTarget.id) ?? null : null;

  const nodeDefinitions = selectedNode ? (definition?.entityTypes.find((item) => selectedNode.labels.includes(item.name))?.properties ?? null) : null;
  const edgeDefinitions = selectedEdge ? (definition?.relationshipTypes.find((item) => item.name === selectedEdge.type)?.properties ?? null) : null;
  const ontologyEntity = viewMode === "ontology" && selectedNode ? definition?.entityTypes.find((item) => item.id === selectedNode.id || item.name === graphLabel(selectedNode) || selectedNode.labels.includes(item.name)) ?? null : null;
  const ontologyRelationship = viewMode === "ontology" && selectedEdge ? definition?.relationshipTypes.find((item) => item.id === selectedEdge.id || item.name === selectedEdge.type) ?? null : null;
  const ontologySource = ontologyRelationship ? definition?.entityTypes.find((item) => item.id === ontologyRelationship.sourceEntityTypeId) ?? null : null;
  const ontologyTarget = ontologyRelationship ? definition?.entityTypes.find((item) => item.id === ontologyRelationship.targetEntityTypeId) ?? null : null;
  const graphSource = selectedEdge ? displayGraph.nodes.find((item) => item.id === selectedEdge.source) ?? null : null;
  const graphTarget = selectedEdge ? displayGraph.nodes.find((item) => item.id === selectedEdge.target) ?? null : null;

  // 本体骨架的节点 id 由后端临时分配，用类型名做键；实例节点直接用图数据库的节点 id。
  const localPositionKey = useCallback((node: GraphNode) => (viewMode === "ontology" ? graphLabel(node, displayProps) : node.id), [displayProps, viewMode]);

  const graphData = useMemo(() => {
    const hubId = hubNodeId(displayGraph.nodes, displayGraph.relationships);
    const positionedNodeCount = displayGraph.nodes.filter((node) => storedPosition(node)).length;
    // A partially persisted legacy layout mixes unrelated coordinate systems and creates sparse, uneven graphs.
    const useStoredPositions = displayGraph.nodes.length > 0 && positionedNodeCount / displayGraph.nodes.length >= 0.8 && storedLayoutIsUsable(displayGraph.nodes);
    const localPositions = layoutOverrideKey ? readStoredPositions(layoutOverrideKey) : {};
    const manuallyPlaced = new Set<string>();
    const nodes: SigmaNode[] = displayGraph.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => {
      const position = useStoredPositions ? storedPosition(node) : null;
      const override = localPositions[localPositionKey(node)];
      if (override) manuallyPlaced.add(node.id);
      return { id: node.id, label: compactGraphLabel(graphLabel(node, displayProps)), color: graphColor(viewMode === "ontology" ? graphLabel(node, displayProps) : node.labels[0] ?? "未标注"), isHub: node.id === hubId, x: override?.x ?? position?.x, y: override?.y ?? position?.y };
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges: SigmaEdge[] = visibleRelationships.filter((relationship) => nodeIds.has(relationship.source) && nodeIds.has(relationship.target)).map((relationship) => ({ id: relationship.id, type: relationship.type, source: relationship.source, target: relationship.target }));
    if (!useStoredPositions && nodes.length <= 60) {
      const stablePositions = computeStableNodePositions(nodes, edges, layoutSeed);
      nodes.forEach((node) => {
        if (manuallyPlaced.has(node.id)) return;
        const position = stablePositions.get(node.id);
        if (position) {
          node.x = position.x;
          node.y = position.y;
        }
      });
    }
    /*
     * 圆形布局与按逻辑分组由分组/布局算出来，但**手工拖过的节点优先**：
     * 点位的来源是"覆盖 > 算出来的"，所以拖动不会被下一次重算冲掉，分组框也会跟着节点实时收放。
     */
    if (viewMode === "ontology" && (layout === "circle" || layout === "grouped")) {
      const frames = layout === "grouped"
        ? buildGroupFrames(frameGroups, frameTypes, displayGraph.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => ({ id: node.id, name: graphLabel(node, displayProps) })))
        : [];
      const described = layout === "grouped"
        ? groupedLayoutPositions(frames, nodes.filter((node) => !frames.some((frame) => frame.nodeIds.includes(node.id))).map((node) => node.id), edges, layoutSeed)
        : circleLayout(nodes.map((node) => node.id), layoutSeed);
      nodes.forEach((node) => {
        if (manuallyPlaced.has(node.id)) return;
        const point = described.get(node.id);
        if (point) { node.x = point.x; node.y = point.y; }
      });
      return { nodes, edges, frames };
    }
    return { nodes, edges, frames: [] };
  }, [displayGraph.nodes, displayGraph.relationships, displayProps, frameGroups, frameTypes, layout, layoutOverrideKey, layoutSeed, localPositionKey, viewMode, visibleNodeIds, visibleRelationships]);

  const toggleLabel = (label: string) => {
    const labels = activeLabels.includes(label) ? activeLabels.filter((item) => item !== label) : [...activeLabels, label];
    setActiveLabels(labels);
    setActiveRelationshipTypes([]);
    onTypeFilterChange?.({ labels, relationshipTypes: [] });
  };
  const toggleRelationshipType = (type: string) => {
    const relationshipTypes = activeRelationshipTypes.includes(type) ? activeRelationshipTypes.filter((item) => item !== type) : [...activeRelationshipTypes, type];
    setActiveRelationshipTypes(relationshipTypes);
    setActiveLabels([]);
    onTypeFilterChange?.({ labels: [], relationshipTypes });
  };

  const refresh = async () => {
    setEditTarget(null);
    setEditing(false);
    if (onRefresh) await onRefresh();
  };

  const openEdit = (kind: "node" | "edge", id: string) => {
    const element = kind === "node" ? displayGraph.nodes.find((node) => node.id === id) : displayGraph.relationships.find((relationship) => relationship.id === id);
    if (!element) return;
    setDraftProps(Object.fromEntries(Object.entries(element.properties).filter(([key]) => key !== "fx" && key !== "fy")));
    setEditTarget({ kind, id });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!editTarget) return;
    const endpoint = editTarget.kind === "node" ? "entities" : "relationships";
    try {
      setBusy(true);
      await api(`/api/instances/${endpoint}/${encodeURIComponent(editTarget.id)}?targetId=${targetId}&versionId=${versionId}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) });
      notify?.("属性已保存到草稿快照。");
      await refresh();
    } catch (reason) {
      fail?.(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteEdit = async () => {
    if (!editTarget) return;
    const endpoint = editTarget.kind === "node" ? "entities" : "relationships";
    const confirmText = editTarget.kind === "node" ? "删除该节点及其所有关系？" : "删除该关系？";
    if (!window.confirm(confirmText)) return;
    try {
      setBusy(true);
      await api(`/api/instances/${endpoint}/${encodeURIComponent(editTarget.id)}?targetId=${targetId}&versionId=${versionId}`, { method: "DELETE" });
      notify?.("已从草稿快照删除。");
      await refresh();
    } catch (reason) {
      fail?.(reason);
    } finally {
      setBusy(false);
    }
  };

  const savePositions = (positions: Record<string, { x: number; y: number }>) => {
    if (!admin || !targetId || !versionId) return;
    const items = Object.entries(positions).filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y)).map(([elementId, point]) => ({ elementId, x: point.x, y: point.y }));
    if (items.length) void api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, versionId, items }) }).catch(() => {});
  };

  // 自动整理的坐标以节点 id 产出，写本机存储前先换成该视图的稳定键（本体用类型名）。
  const localPositionEntries = (positions: Record<string, { x: number; y: number }>) => {
    const next: NodePositions = localLayoutKey ? { ...readStoredPositions(localLayoutKey) } : {};
    for (const [nodeId, point] of Object.entries(positions)) {
      const node = displayGraph.nodes.find((item) => item.id === nodeId);
      if (node) next[localPositionKey(node)] = point;
    }
    return next;
  };

  // 有草稿写快照，否则（只读浏览、本体骨架）只记在本机浏览器，不碰图数据库。
  // 骨架页按布局分开记（layoutOverrideKey），所以"默认布局拖过的"和"按逻辑分组拖过的"互不影响。
  const saveNodePositions = (positions: Record<string, { x: number; y: number }>) => {
    if (persistsPositions) {
      savePositions(positions);
      return;
    }
    if (layoutOverrideKey) writeStoredPositions(layoutOverrideKey, { ...readStoredPositions(layoutOverrideKey), ...localPositionEntries(positions) });
  };

  const handleNodeClick = (nodeId: string) => {
    if (admin && connectionSourceId) {
      if (nodeId !== connectionSourceId) setPendingConnection({ source: connectionSourceId, target: nodeId });
      setConnectionSourceId(null);
      return;
    }
    setEditTarget({ kind: "node", id: nodeId });
    setEditing(false);
  };

  const expand = async () => {
    if (!selectedNode || !onExpand) return;
    try { setBusy(true); await onExpand(selectedNode.id); } catch (reason) { fail?.(reason); } finally { setBusy(false); }
  };

  const organize = () => {
    if (!graph.nodes.length) return;
    // 「自动整理」= 忘掉手工拖过的位置，回到算出来的（分组布局下就是换个 seed 重新铺）。
    if (layoutOverrideKey) writeStoredPositions(layoutOverrideKey, {});
    if (layout !== "default") { setLayoutSeed((seed) => seed + 1); return; }
    if (graphData.nodes.length <= 60) {
      const arranged = Object.fromEntries(computeStableNodePositions(graphData.nodes, graphData.edges, layoutSeed + 1));
      saveNodePositions(arranged);
      setLayoutSeed((seed) => seed + 1);
      return;
    }
    persistLayoutRef.current = true;
    setLayoutRequest((request) => request + 1);
  };

  const showAll = () => {
    setShowAllForGraph(graph);
    setLayoutSeed((seed) => seed + 1);
    if (graph.nodes.length > 60) setLayoutRequest((request) => request + 1);
  };

  const showRepresentative = () => {
    setShowAllForGraph(null);
    setLayoutSeed((seed) => seed + 1);
  };

  if (!graph.nodes.length) return <div className="graph-empty"><Network size={27} /><b>画布上没有可绘制的节点</b><span>运行返回节点、关系或路径的 SPARQL 后即可切换图谱视图；在“实例图谱”页可管理现有图数据。</span></div>;

  return (
    <div className="graph-canvas">
      <SigmaGraph
        nodes={graphData.nodes}
        edges={graphData.edges}
        frames={graphData.frames}
        selectedNodeId={editTarget?.kind === "node" ? editTarget.id : null}
        selectedEdgeId={editTarget?.kind === "edge" ? editTarget.id : null}
        connectionSourceId={connectionSourceId}
        draggable
        layoutRequest={graphData.nodes.length <= 60 ? 0 : layoutRequest}
        onNodeClick={handleNodeClick}
        onEdgeClick={(edgeId) => { setEditTarget({ kind: "edge", id: edgeId }); setEditing(false); }}
        onStageClick={() => { setEditTarget(null); setEditing(false); setConnectionSourceId(null); }}
        onDragEnd={(nodeId, point) => saveNodePositions({ [nodeId]: point })}
        onLayoutEnd={(positions) => {
          if (!persistLayoutRef.current) return;
          persistLayoutRef.current = false;
          saveNodePositions(positions);
          notify?.("已按关系重新整理布局。");
        }}
      />
      <div className="graph-explorer-toolbar">
        <label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、标签或属性" /></label>
        <span>{visibleNodeIds.size}/{totalNodeCount} 个节点 · {visibleRelationships.length}/{totalRelationshipCount} 条关系{representative.hiddenNodes > 0 ? ` · 已隐藏 ${representative.hiddenNodes} 节点 / ${representative.hiddenRelationships} 关系（边界 ${representative.hiddenBoundaryRelationships}）` : ""}</span>
        {viewMode === "ontology" && <LayoutSwitcher value={layout} onChange={setLayout} />}
        {representative.hiddenNodes > 0 && <button className="graph-tool-action" onClick={showAll} title="显示全部节点与关系"><Eye size={14} />显示全部</button>}
        {showAllGraph && graph.nodes.length > REPRESENTATIVE_NODE_LIMIT && <button className="graph-tool-action" onClick={showRepresentative} title="恢复有代表性的精简视图"><EyeOff size={14} />恢复精简</button>}
        {graph.nodes.length > 1 && <button className="graph-tool-action" onClick={() => void organize()} title="以关联最多的节点为中心重新排列，其余节点分层环绕"><Wand2 size={14} />自动整理</button>}
        {admin && <button className="graph-tool-action" onClick={() => setCreateOpen(true)}><Plus size={14} />新增节点</button>}
      </div>
      <div className="graph-legend" aria-label="图谱类型筛选">
        <section className="graph-filter-group" aria-label="节点类型筛选">
          <b>节点 ({visibleNodeIds.size}/{totalNodeCount})</b>
          <div>{nodeTypes.map((item) => <button key={item.name} className={activeLabels.includes(item.name) ? "active" : ""} onClick={() => toggleLabel(item.name)} title={`${item.name}：全图 ${item.count} 个节点`}><i style={{ background: graphColor(item.name) }} />{item.name}</button>)}</div>
        </section>
        <section className="graph-filter-group" aria-label="关系类型筛选">
          <b>关系 ({visibleRelationships.length}/{totalRelationshipCount})</b>
          <div>{relationshipTypes.map((item) => <button key={item.name} className={activeRelationshipTypes.includes(item.name) ? "active" : ""} onClick={() => toggleRelationshipType(item.name)} title={`${item.name}：全图 ${item.count} 条关系`}><i className="relationship-mark" />{item.name}</button>)}</div>
        </section>
      </div>

      <aside className="graph-inspector open">
        {selectedNode && (
          <div className="graph-inspector-body">
            <div className="graph-inspector-head"><div><span style={{ background: graphColor(ontologyEntity ? ontologyEntity.name : selectedNode.labels[0] ?? "未标注") }} />{viewMode === "ontology" ? "对象类型" : "节点事实"}</div><button aria-label="关闭详情" onClick={() => setEditTarget(null)}><X size={15} /></button></div>
            <h3>{graphLabel(selectedNode, displayProps)}</h3>
            <p>{viewMode === "ontology" ? ontologyEntity?.description || "数据库架构中已存在的对象类型" : selectedNode.labels.join(" · ") || "未标注类型"}</p>
            {viewMode !== "ontology" && <code className="graph-element-id">{selectedNode.id}</code>}
                {viewMode === "ontology" ? (
                  ontologyEntity ? <><p className="ontology-property-title">属性定义（{ontologyEntity.properties.length}）</p><OntologyPropertyList properties={ontologyEntity.properties} /></> : <p className="ontology-missing-definition">已发布本体尚未定义该对象类型的属性。</p>
                ) : admin && editing ? (
                  <>
                    <PropertyEditor key={selectedNode.id} definitions={nodeDefinitions ?? []} values={selectedNode.properties} mode={nodeDefinitions ? "managed" : "raw"} onChange={setDraftProps} />
                    <div className="graph-inspector-actions">
                      <button className="graph-action primary" disabled={busy} onClick={() => void saveEdit()}>保存属性</button>
                      <button className="graph-action" onClick={() => setEditing(false)}>取消</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="graph-properties">{Object.entries(selectedNode.properties).filter(([key]) => key !== "fx" && key !== "fy").length ? Object.entries(selectedNode.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b title={propertyValue(value)}>{propertyValue(value)}</b></div>) : <small>该节点没有可显示的属性。</small>}</div>
                    {admin && <button className="graph-action" onClick={() => openEdit("node", selectedNode.id)}><Pencil size={14} />编辑属性</button>}
                    {admin && <button className={connectionSourceId === selectedNode.id ? "graph-action primary" : "graph-action"} title="从此节点创建关系" onClick={() => setConnectionSourceId(selectedNode.id)}><Link2 size={14} />新建关系</button>}
                  </>
                )}
            {onExpand && <button className="graph-expand" disabled={busy} onClick={() => void expand()}><LocateFixed size={15} />{busy ? "正在扩展…" : "扩展一度邻居"}</button>}
            {admin && <button className="graph-action danger" disabled={busy} onClick={() => void deleteEdit()}><Trash2 size={14} />删除节点</button>}
          </div>
        )}
        {selectedEdge && (
          <div className="graph-inspector-body">
            <div className="graph-inspector-head"><div><span style={{ background: "#7a8f8c" }} />{viewMode === "ontology" ? "关系类型" : "关系事实"}</div><button aria-label="关闭详情" onClick={() => setEditTarget(null)}><X size={15} /></button></div>
            <h3>{selectedEdge.type}</h3>
            <p>{viewMode === "ontology" ? <><span>起点对象类型</span> {ontologySource?.name ?? (graphSource ? graphLabel(graphSource) : "未定义")}<br /><span>终点对象类型</span> {ontologyTarget?.name ?? (graphTarget ? graphLabel(graphTarget) : "未定义")}</> : <><span>起始</span> {selectedEdge.source}<br /><span>终止</span> {selectedEdge.target}</>}</p>
            {viewMode !== "ontology" && <code className="graph-element-id">{selectedEdge.id}</code>}
            {viewMode === "ontology" ? (
              ontologyRelationship ? <><p className="ontology-property-title">属性定义（{ontologyRelationship.properties.length}）</p><OntologyPropertyList properties={ontologyRelationship.properties} /></> : <p className="ontology-missing-definition">已发布本体尚未定义该关系类型的属性。</p>
            ) : admin && editing ? (
              <>
                <PropertyEditor key={selectedEdge.id} definitions={edgeDefinitions ?? []} values={selectedEdge.properties} mode={edgeDefinitions ? "managed" : "raw"} onChange={setDraftProps} />
                <div className="graph-inspector-actions">
                  <button className="graph-action primary" disabled={busy} onClick={() => void saveEdit()}>保存属性</button>
                  <button className="graph-action" onClick={() => setEditing(false)}>取消</button>
                </div>
              </>
            ) : (
              <>
                <div className="graph-properties">{Object.entries(selectedEdge.properties).length ? Object.entries(selectedEdge.properties).map(([key, value]) => <div key={key}><span>{key}</span><b title={propertyValue(value)}>{propertyValue(value)}</b></div>) : <small>该关系没有属性。</small>}</div>
                {admin && <button className="graph-action" onClick={() => openEdit("edge", selectedEdge.id)}><Pencil size={14} />编辑属性</button>}
              </>
            )}
            {admin && <button className="graph-action danger" disabled={busy} onClick={() => void deleteEdit()}><Trash2 size={14} />删除关系</button>}
          </div>
        )}
        {!selectedNode && !selectedEdge && (
          <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一个元素</b><span>{viewMode === "ontology" ? "点击对象类型或关系类型，查看端点契约与属性定义。拖拽节点可调整摆放，位置只记在本机；需要复原时点“自动整理”。" : <>点击节点或连线查看与编辑属性。{admin ? "拖拽节点可保存位置；从节点详情发起新建关系后选择目标节点。" : "拖拽节点可调整摆放（只记在本机）；查看节点属性，或在查询结果中继续扩展。"}</>}</span></div>
        )}
      </aside>

      {admin && pendingConnection && <RelationshipDialog typeOptions={relationshipTypeOptions(runtimeTypes, definition)} definition={definition} onClose={() => setPendingConnection(null)} onCreate={async (type, properties) => { try { setBusy(true); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId, versionId, relationshipType: type, sourceId: pendingConnection.source, targetIdValue: pendingConnection.target, properties }) }); notify?.("关系已加入草稿快照。"); setPendingConnection(null); await refresh(); } catch (reason) { fail?.(reason); } finally { setBusy(false); } }} />}
      {admin && createOpen && <NodeDialog labelOptions={labelOptions(runtimeTypes, definition)} definition={definition} onClose={() => setCreateOpen(false)} onCreate={async (label, properties) => { try { setBusy(true); await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId, versionId, entityType: label, properties }) }); notify?.("节点已加入草稿快照。"); setCreateOpen(false); await refresh(); } catch (reason) { fail?.(reason); } finally { setBusy(false); } }} />}
    </div>
  );
}

function relationshipTypeOptions(runtimeTypes?: RuntimeTypeSet, definition?: ManagedDefinition | null) {
  const fromRuntime = runtimeTypes?.relationshipTypes.map((item) => item.name) ?? [];
  const fromDefinition = definition?.relationshipTypes.map((item) => item.name) ?? [];
  return [...new Set([...fromDefinition, ...fromRuntime])];
}

function labelOptions(runtimeTypes?: RuntimeTypeSet, definition?: ManagedDefinition | null) {
  const fromRuntime = runtimeTypes?.labels.map((item) => item.name) ?? [];
  const fromDefinition = definition?.entityTypes.map((item) => item.name) ?? [];
  return [...new Set([...fromDefinition, ...fromRuntime])];
}

function RelationshipDialog({ typeOptions, definition, onClose, onCreate }: { typeOptions: string[]; definition?: ManagedDefinition | null; onClose: () => void; onCreate: (type: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [type, setType] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const definitions = definition?.relationshipTypes.find((item) => item.name === type)?.properties ?? [];
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!type.trim()) return; setBusy(true); void onCreate(type.trim(), properties).finally(() => setBusy(false)); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><Link2 size={22} /></div>
        <span className="eyebrow">新建关系</span>
        <h2>选择关系类型</h2>
        <p>在已选择的两个节点之间创建一条关系。</p>
        <label>关系类型
          <select value={type} onChange={(event) => setType(event.target.value)} required>
            <option value="">选择对象类型</option>
            {typeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <PropertyEditor definitions={definitions} values={properties} mode="managed" onChange={setProperties} />
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!type.trim() || busy}>{busy ? "创建中…" : "创建关系"}</button>
        </div>
      </form>
    </div>
  );
}

function NodeDialog({ labelOptions, definition, onClose, onCreate }: { labelOptions: string[]; definition?: ManagedDefinition | null; onClose: () => void; onCreate: (label: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const definitions = definition?.entityTypes.find((item) => item.name === label)?.properties ?? [];
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!label.trim()) return; setBusy(true); void onCreate(label.trim(), properties).finally(() => setBusy(false)); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><CircleDot size={22} /></div>
        <span className="eyebrow">新建节点</span>
        <h2>选择节点标签</h2>
        <p>只能选择已发布本体或运行时已有的标签，并填写属性。</p>
        <label>标签
          <select value={label} onChange={(event) => setLabel(event.target.value)} required>
            <option value="">选择标签</option>
            {labelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <PropertyEditor definitions={definitions} values={properties} mode="managed" onChange={setProperties} />
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!label.trim() || busy}>{busy ? "创建中…" : "创建节点"}</button>
        </div>
      </form>
    </div>
  );
}
