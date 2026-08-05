"use client";

import { useEffect, useMemo, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow, type Connection, type Edge, type Node } from "@xyflow/react";
import { CircleDot, Link2, LocateFixed, Network, Pencil, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { PropertyEditor } from "@/components/property-editor";
import type { PropertyDefinition } from "@/lib/instance-property-editor";
import type { GraphData, GraphNode, GraphRelationship } from "@/lib/neo4j";
import type { RuntimeTypeSet } from "@/lib/instances";
import "@xyflow/react/dist/style.css";
import "./graph-canvas.css";

type User = { role: "ADMIN" | "VIEWER" } | null;

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

function layoutJitter(id: string, salt: number) {
  let hash = 0;
  const text = `${id}${salt}`;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

function graphLayoutSeed(nodes: GraphNode[], moved: Record<string, { x: number; y: number }>) {
  const seed: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (moved[node.id]) seed[node.id] = moved[node.id];
    else {
      const stored = storedPosition(node);
      if (stored) seed[node.id] = stored;
    }
  }
  return Object.keys(seed).length ? seed : null;
}

function autoLayout(nodes: GraphNode[], relationships: GraphRelationship[], seed: Record<string, { x: number; y: number }> | null): Record<string, { x: number; y: number }> {
  const count = nodes.length;
  if (!count) return {};
  const width = 1600;
  const height = 1000;
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    const stored = seed?.[node.id];
    positions.set(node.id, stored ? { x: stored.x, y: stored.y } : {
      x: width / 2 + Math.cos((2 * Math.PI * index) / count) * Math.min(width, height) * 0.42,
      y: height / 2 + Math.sin((2 * Math.PI * index) / count) * Math.min(width, height) * 0.42,
    });
  });
  const adjacency = new Map<string, string[]>();
  for (const relationship of relationships) {
    if (!positions.has(relationship.source) || !positions.has(relationship.target)) continue;
    let sourceList = adjacency.get(relationship.source);
    if (!sourceList) adjacency.set(relationship.source, sourceList = []);
    sourceList.push(relationship.target);
    let targetList = adjacency.get(relationship.target);
    if (!targetList) adjacency.set(relationship.target, targetList = []);
    targetList.push(relationship.source);
  }
  const area = width * height;
  const k = Math.sqrt(area / Math.max(count, 1));
  const repulsive = (k * k) / 1.15;
  const idealEdge = Math.min(190, k * 1.4);
  let temperature = Math.max(50, width / 14);
  const iterations = 140;
  const ids = nodes.map((node) => node.id);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const displacement = new Map<string, { x: number; y: number }>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1) { dx = (layoutJitter(ids[i] + ids[j], iteration) % 4) || 1; dy = 1; distance = Math.hypot(dx, dy); }
        const force = repulsive / (distance * distance);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const left = displacement.get(ids[i])!;
        const right = displacement.get(ids[j])!;
        left.x += fx; left.y += fy;
        right.x -= fx; right.y -= fy;
      }
    }
    for (const [id, neighbors] of adjacency) {
      for (const neighbor of neighbors) {
        if (id >= neighbor) continue;
        const a = positions.get(id)!;
        const b = positions.get(neighbor)!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance * distance) / idealEdge;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const left = displacement.get(id)!;
        const right = displacement.get(neighbor)!;
        left.x -= fx; left.y -= fy;
        right.x += fx; right.y += fy;
      }
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const disp = displacement.get(id)!;
      const length = Math.max(1, Math.hypot(disp.x, disp.y));
      const step = Math.min(temperature, length);
      point.x = Math.max(30, Math.min(width - 30, point.x + (disp.x / length) * step));
      point.y = Math.max(30, Math.min(height - 30, point.y + (disp.y / length) * step));
    }
    temperature *= 0.9;
  }
  const result: Record<string, { x: number; y: number }> = {};
  for (const id of ids) {
    const point = positions.get(id)!;
    result[id] = { x: Math.round(point.x), y: Math.round(point.y) };
  }
  return result;
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
  const [layoutForce, setLayoutForce] = useState<Record<string, { x: number; y: number }> | null>(null);

  const layoutPositions = useMemo(() => {
    if (!graph.nodes.length) return null;
    const manualSeed = { ...(layoutForce ?? {}), ...moved };
    const automaticSeed = graphLayoutSeed(graph.nodes, moved);
    const seed = layoutForce ? (Object.keys(manualSeed).length ? manualSeed : null) : automaticSeed;
    return autoLayout(graph.nodes, graph.relationships, seed);
    // The layout re-runs when the loaded graph changes; dragging only updates `moved`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes, graph.relationships, layoutForce]);

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

  const nodes = useMemo<Node[]>(() => graph.nodes.map((node, index) => {
    const radius = Math.max(150, Math.min(300, 78 * graph.nodes.length));
    const angle = (Math.PI * 2 * index) / Math.max(graph.nodes.length, 1) - Math.PI / 2;
    const color = graphColor(node.labels[0] ?? "未标注");
    const selected = editTarget?.kind === "node" && node.id === editTarget.id;
    return {
      id: node.id,
      position: moved[node.id] ?? layoutPositions?.[node.id] ?? storedPosition(node) ?? { x: 390 + Math.cos(angle) * radius, y: 275 + Math.sin(angle) * radius },
      data: { label: <div className="graph-node-label"><b>{graphLabel(node)}</b><small>{node.labels.join(" · ") || "未标注"}</small></div> },
      hidden: !visibleNodeIds.has(node.id),
      style: { width: 132, minHeight: 84, borderRadius: 14, border: `2px solid ${color}`, background: "#ffffff", color: "#173536", display: "grid", placeItems: "center", textAlign: "center", padding: "9px", boxShadow: selected ? `0 0 0 4px ${color}33, 0 12px 28px rgba(19, 57, 55, .20)` : "0 5px 15px rgba(19, 57, 55, .11)", transition: "box-shadow .18s ease, transform .18s ease" },
      draggable: true,
      selectable: false,
    };
  }), [editTarget, graph.nodes, layoutPositions, moved, visibleNodeIds]);

  const edges = useMemo<Edge[]>(() => graph.relationships.filter((relationship) => visibleNodeIds.has(relationship.source) && visibleNodeIds.has(relationship.target)).map((relationship) => ({
    id: relationship.id,
    source: relationship.source,
    target: relationship.target,
    label: relationship.type,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#718f8c" },
    style: { stroke: "#718f8c", strokeWidth: 1.35 },
    labelStyle: { fill: "#496361", fontSize: 10, fontWeight: 650 },
    labelBgStyle: { fill: "#f9fcfa", fillOpacity: 0.94 },
    labelBgPadding: [4, 3],
    labelBgBorderRadius: 3,
  })), [graph.relationships, visibleNodeIds]);

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

  const handleDragStop = (_: unknown, node: Node) => {
    if (!admin) return;
    setMoved((current) => ({ ...current, [node.id]: { x: node.position.x, y: node.position.y } }));
    void api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, items: [{ elementId: node.id, x: node.position.x, y: node.position.y }] }) }).catch(() => {});
  };

  const expand = async () => {
    if (!selectedNode || !onExpand) return;
    try { setBusy(true); await onExpand(selectedNode.id); } catch (reason) { fail?.(reason); } finally { setBusy(false); }
  };

  const organize = async () => {
    if (!graph.nodes.length) return;
    const fresh = autoLayout(graph.nodes, graph.relationships, null);
    setLayoutForce(fresh);
    if (admin && targetId) {
      const items: { elementId: string; x: number; y: number }[] = [];
      for (const node of graph.nodes) {
        const point = fresh[node.id];
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) items.push({ elementId: node.id, x: point.x, y: point.y });
      }
      await api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, items }) }).catch((reason) => fail?.(reason));
    }
    notify?.("已整理布局。");
  };

  if (!graph.nodes.length) return <div className="graph-empty"><Network size={27} /><b>画布上没有可绘制的节点</b><span>运行返回节点、关系或路径的 Cypher 后即可切换图谱视图；在“图谱”页可管理现有图数据。</span></div>;

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={(changes) => setMoved((current) => {
          let next = current;
          for (const change of changes) {
            if (change.type === "position" && change.position) next = { ...next, [change.id]: { x: change.position.x, y: change.position.y } };
          }
          return next;
        })}
        fitView
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={admin}
        nodesDraggable
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
        {graph.nodes.length > 1 && <button className="graph-tool-action" onClick={() => void organize()} title="按力导向重新计算所有节点的位置"><Wand2 size={14} />自动整理</button>}
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
