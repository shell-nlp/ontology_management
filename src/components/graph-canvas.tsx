"use client";

import { useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { CircleDot, Link2, LocateFixed, Network, Pencil, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum } from "d3-force";
import { PropertyEditor } from "@/components/property-editor";
import type { PropertyDefinition } from "@/lib/instance-property-editor";
import type { GraphData, GraphNode, GraphRelationship } from "@/lib/neo4j";
import type { RuntimeTypeSet } from "@/lib/instances";
import "@xyflow/react/dist/style.css";
import "./graph-canvas.css";

type User = { role: "ADMIN" | "VIEWER" } | null;

type SimNode = { id: string; x: number; y: number; fx?: number | null; fy?: number | null };
type LinkDatum = SimulationLinkDatum<SimNode>;

type ManagedDefinition = {
  entityTypes: { name: string; properties: PropertyDefinition[] }[];
  relationshipTypes: { name: string; properties: PropertyDefinition[] }[];
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}

function graphLabel(node: GraphNode) {
  const preferred = ["name", "名称", "title", "id"].map((key) => node.properties[key]).find((value) => typeof value === "string" || typeof value === "number");
  return String(preferred ?? node.labels[0] ?? "节点");
}

const graphPalette = ["#2e9b8f", "#d97757", "#5b8def", "#a47acb", "#c89137", "#4b9f69"];

function graphColor(label: string) {
  let hash = 0;
  for (const character of label) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return graphPalette[Math.abs(hash) % graphPalette.length];
}

function propertyValue(value: unknown) {
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function forceLayout(nodes: GraphNode[], relationships: GraphRelationship[]) {
  if (!nodes.length) return {};
  const width = 1600;
  const height = 1000;
  const cx = width / 2;
  const cy = height / 2;
  const nodeIds = new Set(nodes.map((node) => node.id));
  const simNodes: SimNode[] = nodes.map((node, index) => {
    const stored = storedPosition(node);
    if (stored) return { id: node.id, x: stored.x, y: stored.y };
    const angle = (2 * Math.PI * index) / Math.max(nodes.length, 1) - Math.PI / 2;
    const radius = Math.max(280, Math.min(560, nodes.length * 22));
    return { id: node.id, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
  const links = relationships
    .filter((relationship) => nodeIds.has(relationship.source) && nodeIds.has(relationship.target))
    .map((relationship) => ({ source: relationship.source, target: relationship.target }));
  const simulation = forceSimulation<SimNode>(simNodes)
    .force("link", forceLink<SimNode, LinkDatum>().id((datum) => datum.id).distance(260).strength(0.56).links(links))
    .force("charge", forceManyBody<SimNode>().strength(-1150).distanceMax(1000))
    .force("collide", forceCollide<SimNode>(68).strength(0.95))
    .force("x", forceX<SimNode>(cx).strength(0.018))
    .force("y", forceY<SimNode>(cy).strength(0.018))
    .stop();
  const iterations = Math.min(190, Math.max(45, Math.ceil(9000 / nodes.length)));
  for (let index = 0; index < iterations; index++) simulation.tick();
  return Object.fromEntries(simNodes.map((node) => [node.id, { x: Math.round(node.x), y: Math.round(node.y) }]));
}

type EditTarget = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

export function GraphCanvas({
  graph,
  targetId,
  user,
  editable = false,
  definition = null,
  runtimeTypes,
  onExpand,
  onRefresh,
  notify,
  fail,
}: {
  graph: GraphData;
  targetId?: string;
  user?: User;
  editable?: boolean;
  definition?: ManagedDefinition | null;
  runtimeTypes?: RuntimeTypeSet;
  onExpand?: (nodeId: string) => Promise<void>;
  onRefresh?: () => Promise<void>;
  notify?: (text: string) => void;
  fail?: (reason: unknown) => void;
}) {
  const admin = editable && user?.role === "ADMIN" && Boolean(targetId);
  const [search, setSearch] = useState("");
  const [activeLabels, setActiveLabels] = useState<string[]>([]);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [pendingConnection, setPendingConnection] = useState<{ source: string; target: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const { layoutPositions, hubId } = useMemo(() => {
    if (!graph.nodes.length) return { layoutPositions: null, hubId: null };
    return { layoutPositions: forceLayout(graph.nodes, graph.relationships), hubId: hubNodeId(graph.nodes, graph.relationships) };
  }, [graph.nodes, graph.relationships]);

  const labels = useMemo(() => [...new Set(graph.nodes.flatMap((node) => node.labels))].sort((a, b) => a.localeCompare(b, "zh-CN")), [graph.nodes]);
  const visibleNodeIds = useMemo(() => new Set(graph.nodes.filter((node) => {
    const haystack = `${graphLabel(node)} ${node.labels.join(" ")} ${Object.values(node.properties).map(propertyValue).join(" ")}`.toLocaleLowerCase();
    const labelMatches = !activeLabels.length || node.labels.some((label) => activeLabels.includes(label));
    return labelMatches && haystack.includes(search.trim().toLocaleLowerCase());
  }).map((node) => node.id)), [activeLabels, graph.nodes, search]);

  const selectedNode = editTarget?.kind === "node" ? graph.nodes.find((node) => node.id === editTarget.id) ?? null : null;
  const selectedEdge = editTarget?.kind === "edge" ? graph.relationships.find((relationship) => relationship.id === editTarget.id) ?? null : null;

  const nodeDefinitions = selectedNode ? (definition?.entityTypes.find((item) => selectedNode.labels.includes(item.name))?.properties ?? null) : null;
  const edgeDefinitions = selectedEdge ? (definition?.relationshipTypes.find((item) => item.name === selectedEdge.type)?.properties ?? null) : null;

  const nodes = useMemo<Node[]>(() => graph.nodes.map((node) => {
    const color = graphColor(node.labels[0] ?? "未标注");
    const selected = editTarget?.kind === "node" && node.id === editTarget.id;
    const isHub = hubId !== null && node.id === hubId;
    const shadow = selected ? `0 0 0 4px ${color}33, 0 12px 28px rgba(19, 57, 55, .20)` : isHub ? "0 0 0 3px rgba(200, 145, 55, .55), 0 8px 20px rgba(19, 57, 55, .16)" : "0 5px 15px rgba(19, 57, 55, .11)";
    return {
      id: node.id,
      position: moved[node.id] ?? layoutPositions?.[node.id] ?? storedPosition(node) ?? { x: 390 + Math.cos((Math.PI * 2 * graph.nodes.indexOf(node)) / graph.nodes.length) * 300, y: 275 + Math.sin((Math.PI * 2 * graph.nodes.indexOf(node)) / graph.nodes.length) * 300 },
      data: { label: <div className="graph-node-label"><b>{graphLabel(node)}</b>{isHub && <small>· 中心</small>}</div> },
      hidden: !visibleNodeIds.has(node.id),
      style: { width: isHub ? 116 : 96, height: isHub ? 116 : 96, borderRadius: "50%", border: `2.5px solid ${isHub ? "#c89137" : color}`, background: isHub ? "#fffaf0" : "#ffffff", color: "#173536", display: "grid", placeItems: "center", textAlign: "center", padding: "12px", boxShadow: shadow, transition: "box-shadow .18s ease, transform .18s ease" },
      draggable: true,
      selectable: false,
    };
  }), [editTarget, graph.nodes, hubId, layoutPositions, moved, visibleNodeIds]);

  const edges = useMemo<Edge[]>(() => graph.relationships.filter((relationship) => visibleNodeIds.has(relationship.source) && visibleNodeIds.has(relationship.target)).map((relationship) => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    label: relationship.type,
    type: "straight",
    markerEnd: { type: MarkerType.ArrowClosed, color: "#6f8292" },
    style: { stroke: "#6f8292", strokeWidth: 1.5 },
    labelStyle: { fill: "#4a5d6d", fontSize: 10, fontWeight: 650 },
    labelBgStyle: { fill: "#f8fafb", fillOpacity: 0.96 },
    labelBgPadding: [4, 3],
    labelBgBorderRadius: 3,
  })), [graph.relationships, visibleNodeIds]);
  const flowKey = useMemo(() => `${graph.nodes.map((node) => node.id).join("|")}:${graph.relationships.map((relationship) => relationship.id).join("|")}:${search}:${activeLabels.join("|")}`, [activeLabels, graph.nodes, graph.relationships, search]);

  const toggleLabel = (label: string) => setActiveLabels((current) => current.includes(label) ? current.filter((item) => item !== label) : [...current, label]);

  const refresh = async () => {
    setEditTarget(null);
    setEditing(false);
    if (onRefresh) await onRefresh();
  };

  const openEdit = (kind: "node" | "edge", id: string) => {
    const element = kind === "node" ? graph.nodes.find((node) => node.id === id) : graph.relationships.find((relationship) => relationship.id === id);
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
      await api(`/api/instances/${endpoint}/${encodeURIComponent(editTarget.id)}?targetId=${targetId}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) });
      notify?.("属性已保存到 Neo4j。");
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
      await api(`/api/instances/${endpoint}/${encodeURIComponent(editTarget.id)}?targetId=${targetId}`, { method: "DELETE" });
      notify?.("已删除。");
      await refresh();
    } catch (reason) {
      fail?.(reason);
    } finally {
      setBusy(false);
    }
  };

  const handleConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    setPendingConnection({ source: connection.source, target: connection.target });
  };

  const flowRef = useRef<ReactFlowInstance | null>(null);

  const handleDragStop = (_: unknown, node: Node) => {
    if (!admin) return;
    const position = { x: node.position.x, y: node.position.y };
    setMoved((current) => ({ ...current, [node.id]: position }));
    void api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, items: [{ elementId: node.id, x: node.position.x, y: node.position.y }] }) }).catch(() => {});
  };

  const expand = async () => {
    if (!selectedNode || !onExpand) return;
    try { setBusy(true); await onExpand(selectedNode.id); } catch (reason) { fail?.(reason); } finally { setBusy(false); }
  };

  const organize = async () => {
    if (!graph.nodes.length) return;
    const positions = forceLayout(graph.nodes, graph.relationships);
    flowRef.current?.setNodes((current) => current.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node));
    setMoved(positions);
    if (admin && targetId) {
      const items: { elementId: string; x: number; y: number }[] = [];
      for (const node of graph.nodes) {
        const point = positions[node.id];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) items.push({ elementId: node.id, x: point.x, y: point.y });
      }
      await api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, items }) }).catch((reason) => fail?.(reason));
    }
    notify?.("已按关系重新整理布局。");
  };

  if (!graph.nodes.length) return <div className="graph-empty"><Network size={27} /><b>画布上没有可绘制的节点</b><span>运行返回节点、关系或路径的 Cypher 后即可切换图谱视图；在“图谱”页可管理现有图数据。</span></div>;

  return (
    <div className="graph-canvas">
      <ReactFlow
        key={flowKey}
        defaultNodes={nodes}
        defaultEdges={edges}
        onInit={(instance) => { flowRef.current = instance; }}
        fitView
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={admin}
        nodesDraggable={admin}
        deleteKeyCode={null}
        onNodeClick={(_, node) => { setEditTarget({ kind: "node", id: node.id }); setEditing(false); }}
        onEdgeClick={(_, edge) => { setEditTarget({ kind: "edge", id: edge.id }); setEditing(false); }}
        onPaneClick={() => { setEditTarget(null); setEditing(false); }}
        onConnect={handleConnect}
        onNodeDragStop={handleDragStop}
      >
        <Background color="#c9d8d3" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="graph-explorer-toolbar">
        <label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、标签或属性" /></label>
        <span>{visibleNodeIds.size}/{graph.nodes.length} 个节点</span>
        {graph.nodes.length > 1 && <button className="graph-tool-action" onClick={() => void organize()} title="以关联最多的节点为中心重新排列，其余节点分层环绕"><Wand2 size={14} />自动整理</button>}
        {admin && <button className="graph-tool-action" onClick={() => setCreateOpen(true)}><Plus size={14} />新增节点</button>}
      </div>
      <div className="graph-legend" aria-label="节点类型筛选">{labels.map((label) => <button key={label} className={activeLabels.includes(label) ? "active" : ""} onClick={() => toggleLabel(label)}><i style={{ background: graphColor(label) }} />{label}</button>)}</div>

      <aside className="graph-inspector open">
        {selectedNode && (
          <div className="graph-inspector-body">
            <div className="graph-inspector-head"><div><span style={{ background: graphColor(selectedNode.labels[0] ?? "未标注") }} />节点事实</div><button aria-label="关闭详情" onClick={() => setEditTarget(null)}><X size={15} /></button></div>
            <h3>{graphLabel(selectedNode)}</h3>
            <p>{selectedNode.labels.join(" · ") || "未标注类型"}</p>
            <code className="graph-element-id">{selectedNode.id}</code>
                {admin && editing ? (
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
                  </>
                )}
            {onExpand && <button className="graph-expand" disabled={busy} onClick={() => void expand()}><LocateFixed size={15} />{busy ? "正在扩展…" : "扩展一度邻居"}</button>}
            {admin && <button className="graph-action danger" disabled={busy} onClick={() => void deleteEdit()}><Trash2 size={14} />删除节点</button>}
          </div>
        )}
        {selectedEdge && (
          <div className="graph-inspector-body">
            <div className="graph-inspector-head"><div><span style={{ background: "#7a8f8c" }} />关系事实</div><button aria-label="关闭详情" onClick={() => setEditTarget(null)}><X size={15} /></button></div>
            <h3>{selectedEdge.type}</h3>
            <p><span>起始</span> {selectedEdge.source}<br /><span>终止</span> {selectedEdge.target}</p>
            <code className="graph-element-id">{selectedEdge.id}</code>
            {admin && editing ? (
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
          <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一个元素</b><span>点击节点或连线查看与编辑属性。{admin ? "拖拽节点可保存位置，拖出连线可新建关系。" : "查看节点属性，或在 Cypher 结果中继续扩展。"}</span></div>
        )}
      </aside>

      {admin && pendingConnection && <RelationshipDialog typeOptions={relationshipTypeOptions(runtimeTypes, definition)} onClose={() => setPendingConnection(null)} onCreate={async (type, properties) => { try { setBusy(true); await api("/api/instances/relationships", { method: "POST", body: JSON.stringify({ targetId, relationshipType: type, sourceId: pendingConnection.source, targetIdValue: pendingConnection.target, properties }) }); notify?.("关系已写入 Neo4j。"); setPendingConnection(null); await refresh(); } catch (reason) { fail?.(reason); } finally { setBusy(false); } }} />}
      {admin && createOpen && <NodeDialog labelOptions={labelOptions(runtimeTypes, definition)} onClose={() => setCreateOpen(false)} onCreate={async (label, properties) => { try { setBusy(true); await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId, entityType: label, properties }) }); notify?.("节点已写入 Neo4j。"); setCreateOpen(false); await refresh(); } catch (reason) { fail?.(reason); } finally { setBusy(false); } }} />}
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

function RelationshipDialog({ typeOptions, onClose, onCreate }: { typeOptions: string[]; onClose: () => void; onCreate: (type: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [type, setType] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customType, setCustomType] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const value = customMode ? customType : type;
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; setBusy(true); void onCreate(value.trim(), properties).finally(() => setBusy(false)); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><Link2 size={22} /></div>
        <span className="eyebrow">新建关系</span>
        <h2>选择关系类型</h2>
        <p>在已选择的两个节点之间创建一条关系。</p>
        <label>关系类型
          {customMode ? <input autoFocus value={customType} onChange={(event) => setCustomType(event.target.value)} placeholder="输入新的关系类型" /> : (
            <select value={type} onChange={(event) => setType(event.target.value)} required>
              <option value="">选择类型</option>
              {typeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          )}
        </label>
        <button type="button" className="graph-dialog-custom" onClick={() => setCustomMode((current) => !current)}>{customMode ? "改为从列表选择" : "使用自定义类型"}</button>
        <PropertyEditor definitions={[]} values={properties} mode="raw" onChange={setProperties} />
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!value.trim() || busy}>{busy ? "创建中…" : "创建关系"}</button>
        </div>
      </form>
    </div>
  );
}

function NodeDialog({ labelOptions, onClose, onCreate }: { labelOptions: string[]; onClose: () => void; onCreate: (label: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customLabel, setCustomLabel] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const value = customMode ? customLabel : label;
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; setBusy(true); void onCreate(value.trim(), properties).finally(() => setBusy(false)); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><CircleDot size={22} /></div>
        <span className="eyebrow">新建节点</span>
        <h2>选择节点标签</h2>
        <p>按已发布本体或运行时类型选择标签，并填写属性。</p>
        <label>标签
          {customMode ? <input autoFocus value={customLabel} onChange={(event) => setCustomLabel(event.target.value)} placeholder="输入新的标签" /> : (
            <select value={label} onChange={(event) => setLabel(event.target.value)} required>
              <option value="">选择标签</option>
              {labelOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          )}
        </label>
        <button type="button" className="graph-dialog-custom" onClick={() => setCustomMode((current) => !current)}>{customMode ? "改为从列表选择" : "使用自定义标签"}</button>
        <PropertyEditor definitions={[]} values={properties} mode="raw" onChange={setProperties} />
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!value.trim() || busy}>{busy ? "创建中…" : "创建节点"}</button>
        </div>
      </form>
    </div>
  );
}
