"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { CircleDot, Link2, LocateFixed, Network, Pencil, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import { PropertyEditor } from "@/components/property-editor";
import type { SigmaEdge, SigmaNode } from "@/components/sigma-graph";
import type { PropertyDefinition } from "@/lib/instance-property-editor";
import type { GraphData, GraphNode, GraphRelationship } from "@/lib/neo4j";
import type { RuntimeTypeSet } from "@/lib/instances";
import "./graph-canvas.css";

const SigmaGraph = dynamic(() => import("@/components/sigma-graph").then((module) => module.SigmaGraph), { ssr: false });

type User = { role: "ADMIN" | "VIEWER" } | null;

type OntologyPropertyDefinition = PropertyDefinition & { unique?: boolean; indexed?: boolean };

type ManagedDefinition = {
  entityTypes: { id?: string; name: string; description?: string; properties: OntologyPropertyDefinition[] }[];
  relationshipTypes: { id?: string; name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string; properties: OntologyPropertyDefinition[] }[];
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

function OntologyPropertyList({ properties }: { properties: OntologyPropertyDefinition[] }) {
  if (!properties.length) return <small>此类型未定义属性规则。</small>;
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
  const admin = editable && user?.role === "ADMIN" && Boolean(targetId);
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

  const nodeTypes = useMemo(() => {
    const types = new Map((runtimeTypes?.labels ?? []).map((item) => [item.name, item.count]));
    for (const node of graph.nodes) for (const label of node.labels) if (!types.has(label)) types.set(label, 0);
    return [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [graph.nodes, runtimeTypes?.labels]);
  const relationshipTypes = useMemo(() => {
    const types = new Map((runtimeTypes?.relationshipTypes ?? []).map((item) => [item.name, item.count]));
    for (const relationship of graph.relationships) if (!types.has(relationship.type)) types.set(relationship.type, 0);
    return [...types.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  }, [graph.relationships, runtimeTypes?.relationshipTypes]);
  const totalNodeCount = runtimeTypes ? runtimeTypes.labels.reduce((total, item) => total + item.count, 0) : graph.nodes.length;
  const totalRelationshipCount = runtimeTypes ? runtimeTypes.relationshipTypes.reduce((total, item) => total + item.count, 0) : graph.relationships.length;
  const visibleNodeIds = useMemo(() => new Set(graph.nodes.filter((node) => {
    const haystack = `${graphLabel(node)} ${node.labels.join(" ")} ${Object.values(node.properties).map(propertyValue).join(" ")}`.toLocaleLowerCase();
    const labelMatches = !activeLabels.length || node.labels.some((label) => activeLabels.includes(label));
    return labelMatches && haystack.includes(search.trim().toLocaleLowerCase());
  }).map((node) => node.id)), [activeLabels, graph.nodes, search]);
  const visibleRelationships = useMemo(() => graph.relationships.filter((relationship) => {
    return visibleNodeIds.has(relationship.source)
      && visibleNodeIds.has(relationship.target)
      && (!activeRelationshipTypes.length || activeRelationshipTypes.includes(relationship.type));
  }), [activeRelationshipTypes, graph.relationships, visibleNodeIds]);

  const selectedNode = editTarget?.kind === "node" ? graph.nodes.find((node) => node.id === editTarget.id) ?? null : null;
  const selectedEdge = editTarget?.kind === "edge" ? graph.relationships.find((relationship) => relationship.id === editTarget.id) ?? null : null;

  const nodeDefinitions = selectedNode ? (definition?.entityTypes.find((item) => selectedNode.labels.includes(item.name))?.properties ?? null) : null;
  const edgeDefinitions = selectedEdge ? (definition?.relationshipTypes.find((item) => item.name === selectedEdge.type)?.properties ?? null) : null;
  const ontologyEntity = viewMode === "ontology" && selectedNode ? definition?.entityTypes.find((item) => item.id === selectedNode.id || item.name === graphLabel(selectedNode) || selectedNode.labels.includes(item.name)) ?? null : null;
  const ontologyRelationship = viewMode === "ontology" && selectedEdge ? definition?.relationshipTypes.find((item) => item.id === selectedEdge.id || item.name === selectedEdge.type) ?? null : null;
  const ontologySource = ontologyRelationship ? definition?.entityTypes.find((item) => item.id === ontologyRelationship.sourceEntityTypeId) ?? null : null;
  const ontologyTarget = ontologyRelationship ? definition?.entityTypes.find((item) => item.id === ontologyRelationship.targetEntityTypeId) ?? null : null;
  const graphSource = selectedEdge ? graph.nodes.find((item) => item.id === selectedEdge.source) ?? null : null;
  const graphTarget = selectedEdge ? graph.nodes.find((item) => item.id === selectedEdge.target) ?? null : null;

  const graphData = useMemo(() => {
    const hubId = hubNodeId(graph.nodes, graph.relationships);
    const positionedNodeCount = graph.nodes.filter((node) => storedPosition(node)).length;
    // A partially persisted legacy layout mixes unrelated coordinate systems and creates sparse, uneven graphs.
    const useStoredPositions = positionedNodeCount / graph.nodes.length >= 0.8;
    const nodes: SigmaNode[] = graph.nodes.filter((node) => visibleNodeIds.has(node.id)).map((node) => {
      const position = useStoredPositions ? storedPosition(node) : null;
      return { id: node.id, label: graphLabel(node), color: graphColor(viewMode === "ontology" ? graphLabel(node) : node.labels[0] ?? "未标注"), isHub: node.id === hubId, x: position?.x, y: position?.y };
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges: SigmaEdge[] = visibleRelationships.filter((relationship) => nodeIds.has(relationship.source) && nodeIds.has(relationship.target)).map((relationship) => ({ id: relationship.id, type: relationship.type, source: relationship.source, target: relationship.target }));
    return { nodes, edges };
  }, [graph.nodes, graph.relationships, viewMode, visibleNodeIds, visibleRelationships]);

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

  const savePositions = (positions: Record<string, { x: number; y: number }>) => {
    if (!admin || !targetId) return;
    const items = Object.entries(positions).filter(([, point]) => Number.isFinite(point.x) && Number.isFinite(point.y)).map(([elementId, point]) => ({ elementId, x: point.x, y: point.y }));
    if (items.length) void api("/api/instances/positions", { method: "PUT", body: JSON.stringify({ targetId, items }) }).catch(() => {});
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
    setLayoutRequest((request) => request + 1);
  };

  if (!graph.nodes.length) return <div className="graph-empty"><Network size={27} /><b>画布上没有可绘制的节点</b><span>运行返回节点、关系或路径的 Cypher 后即可切换图谱视图；在“图谱”页可管理现有图数据。</span></div>;

  return (
    <div className="graph-canvas">
      <SigmaGraph
        nodes={graphData.nodes}
        edges={graphData.edges}
        selectedNodeId={editTarget?.kind === "node" ? editTarget.id : null}
        selectedEdgeId={editTarget?.kind === "edge" ? editTarget.id : null}
        connectionSourceId={connectionSourceId}
        draggable={admin}
        layoutRequest={layoutRequest}
        onNodeClick={handleNodeClick}
        onEdgeClick={(edgeId) => { setEditTarget({ kind: "edge", id: edgeId }); setEditing(false); }}
        onStageClick={() => { setEditTarget(null); setEditing(false); setConnectionSourceId(null); }}
        onDragEnd={(nodeId, point) => savePositions({ [nodeId]: point })}
        onLayoutEnd={(positions) => { savePositions(positions); notify?.("已按关系重新整理布局。"); }}
      />
      <div className="graph-explorer-toolbar">
        <label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称、标签或属性" /></label>
        <span>{visibleNodeIds.size}/{graph.nodes.length} 个节点 · {visibleRelationships.length}/{graph.relationships.length} 条关系</span>
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
            <div className="graph-inspector-head"><div><span style={{ background: graphColor(ontologyEntity ? ontologyEntity.name : selectedNode.labels[0] ?? "未标注") }} />{viewMode === "ontology" ? "实体类型" : "节点事实"}</div><button aria-label="关闭详情" onClick={() => setEditTarget(null)}><X size={15} /></button></div>
            <h3>{graphLabel(selectedNode)}</h3>
            <p>{viewMode === "ontology" ? ontologyEntity?.description || "数据库架构中已存在的实体类型" : selectedNode.labels.join(" · ") || "未标注类型"}</p>
            {viewMode !== "ontology" && <code className="graph-element-id">{selectedNode.id}</code>}
                {viewMode === "ontology" ? (
                  ontologyEntity ? <><p className="ontology-property-title">属性定义（{ontologyEntity.properties.length}）</p><OntologyPropertyList properties={ontologyEntity.properties} /></> : <p className="ontology-missing-definition">已发布本体尚未定义该实体类型的属性规则。</p>
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
            <p>{viewMode === "ontology" ? <><span>起点实体类型</span> {ontologySource?.name ?? (graphSource ? graphLabel(graphSource) : "未定义")}<br /><span>终点实体类型</span> {ontologyTarget?.name ?? (graphTarget ? graphLabel(graphTarget) : "未定义")}</> : <><span>起始</span> {selectedEdge.source}<br /><span>终止</span> {selectedEdge.target}</>}</p>
            {viewMode !== "ontology" && <code className="graph-element-id">{selectedEdge.id}</code>}
            {viewMode === "ontology" ? (
              ontologyRelationship ? <><p className="ontology-property-title">属性定义（{ontologyRelationship.properties.length}）</p><OntologyPropertyList properties={ontologyRelationship.properties} /></> : <p className="ontology-missing-definition">已发布本体尚未定义该关系类型的属性规则。</p>
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
          <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一个元素</b><span>{viewMode === "ontology" ? "点击实体类型或关系类型，查看端点契约及每一项属性规则。" : <>点击节点或连线查看与编辑属性。{admin ? "拖拽节点可保存位置；从节点详情发起新建关系后选择目标节点。" : "查看节点属性，或在 Cypher 结果中继续扩展。"}</>}</span></div>
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
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
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
        <PropertyEditor definitions={[]} values={properties} mode="raw" onChange={setProperties} />
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={!label.trim() || busy}>{busy ? "创建中…" : "创建节点"}</button>
        </div>
      </form>
    </div>
  );
}
