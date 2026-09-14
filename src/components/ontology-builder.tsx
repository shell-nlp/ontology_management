"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Boxes, CircleDot, CornerDownRight, Database, Link2, LocateFixed, Pencil, Plus, Trash2, Wand2, X } from "lucide-react";
import { actionInvolvement } from "@/lib/action-engine";
import { ancestorsOf, inheritedPropertiesOf, indexNodes } from "@/lib/class-hierarchy";
import { buildGroupFrames, circleLayout, groupedLayoutPositions } from "@/lib/concept-groups";
import { compactGraphLabel, graphColor } from "@/lib/graph-palette";
import { newId } from "@/lib/ids";
import { readStoredPositions, writeStoredPositions } from "@/lib/local-layout";
import type { ActionType, Definition, EntityType, RelationType } from "@/lib/ontology-draft";
import { LayoutSwitcher, useLayoutMode } from "@/components/layout-switcher";
import type { SigmaEdge, SigmaNode } from "@/components/sigma-graph";
import { TypeEditDialog } from "@/components/type-edit-dialog";
// 画布上的浮层沿用「图谱」页的样式（graph-canvas.css 已随 GraphCanvas 进入同一份页面样式）。
import "./ontology-builder.css";

const SigmaGraph = dynamic(() => import("@/components/sigma-graph").then((module) => module.SigmaGraph), { ssr: false });

/**
 * 没被手动摆放过的对象类型：度数最高的那个居中，其余绕成一圈。
 * 换一个 seed 就是绕轴转一圈，所以「自动整理」看得见变化，布局本身仍是确定的。
 */
function radialLayout(entities: EntityType[], edges: SigmaEdge[], seed: number) {
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

export type EntityPayload = { name: string; description: string; displayProperty: string; groupName?: string; parents?: string[]; properties: EntityType["properties"]; sources?: EntityType["sources"] };
export type RelationPayload = { name: string; description?: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: RelationType["properties"] };

type Selection = { kind: "entity"; id: string } | { kind: "relation"; id: string } | null;
type DialogState =
  | { kind: "entity"; mode: "create"; id: string }
  | { kind: "entity"; mode: "edit"; id: string }
  | { kind: "relation"; mode: "create"; id: string; source: string; target: string }
  | { kind: "relation"; mode: "edit"; id: string };

type Props = {
  definition: Definition;
  targetId?: string;
  canEdit: boolean;
  hasSnapshot: boolean;
  onCreateEntity: (id: string, payload: EntityPayload) => Promise<void>;
  onUpdateEntity: (id: string, payload: EntityPayload) => Promise<void>;
  onDeleteEntity: (id: string) => Promise<void>;
  onCreateRelation: (id: string, payload: RelationPayload) => Promise<void>;
  onUpdateRelation: (id: string, payload: RelationPayload) => Promise<void>;
  onDeleteRelation: (id: string) => Promise<void>;
  /** 整份草稿的保存入口：概念分组这一类"不属于某个对象类型"的改动走它。 */
  onSaveDefinition: (next: Definition) => Promise<void>;
  onExtract: () => void;
  /** 跳去「动作」页：对象类型与动作的关联在这里点开。 */
  onOpenActions?: () => void;
  /** 跳去「概念分组」页：画布这边只看效果，配置在那边做。 */
  onOpenGroups?: () => void;
  onFail: (reason: unknown) => void;
};

/**
 * 本体草稿的可视化工作台：类是节点，关系类型是带箭头的连线。
 *
 * 画布上做的每一次改动都会立刻写回草稿（和表单模式同一套保存路径），
 * 摆放位置只记在本机浏览器，不属于草稿定义。
 */
export function OntologyBuilder({ definition, targetId, canEdit, hasSnapshot, onCreateEntity, onUpdateEntity, onDeleteEntity, onCreateRelation, onUpdateRelation, onDeleteRelation, onSaveDefinition, onExtract, onOpenActions, onOpenGroups, onFail }: Props) {
  const [selected, setSelected] = useState<Selection>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [layoutSeed, setLayoutSeed] = useState(0);
  const storageKey = targetId ? `ontology-builder:${targetId}` : null;
  // 布局只记在本机（"我怎么看这张图"），不进草稿定义。
  const [layout, setLayout] = useLayoutMode(storageKey ? `${storageKey}:layout` : null);
  /*
   * 手工摆放的位置**按布局分别记**：默认布局沿用老键（老数据不丢），圆形 / 按逻辑分组各用自己的键。
   * 分开记才不会出现"拖着默认布局摆好的位置，一切到按逻辑分组就全乱"。
   */
  const positionKey = storageKey ? (layout === "default" ? storageKey : `${storageKey}:${layout}`) : null;

  const entityById = useMemo(() => new Map(definition.entityTypes.map((item) => [item.id, item])), [definition.entityTypes]);
  const relationById = useMemo(() => new Map(definition.relationshipTypes.map((item) => [item.id, item])), [definition.relationshipTypes]);
  // 选中一个类时顺着父类往上算：得到隐含的祖先，以及它从祖先那里继承来的属性。
  const hierarchyNodes = useMemo(() => indexNodes(definition.entityTypes), [definition.entityTypes]);
  /** 选中类的血统：直接父类（用户勾的）和更远的祖先（推出来的）分开说，不混成一句话。 */
  const selectedLineage = useMemo(() => {
    const selectedEntity = selected?.kind === "entity" ? definition.entityTypes.find((item) => item.id === selected.id) : undefined;
    if (!selectedEntity) return { direct: [] as string[], extra: [] as string[] };
    const direct = (selectedEntity.parents ?? []).map((id) => entityById.get(id)?.name ?? "已删除");
    const extra = ancestorsOf(selectedEntity.id, hierarchyNodes)
      .map((id) => hierarchyNodes.get(id)?.name ?? id)
      .filter((name) => !direct.includes(name));
    return { direct, extra };
  }, [selected, definition.entityTypes, entityById, hierarchyNodes]);
  const selectedInherited = useMemo(() => {
    const node = selected?.kind === "entity" ? hierarchyNodes.get(selected.id) : undefined;
    return node ? inheritedPropertiesOf(node, hierarchyNodes) : [];
  }, [selected, hierarchyNodes]);

  const { nodes, edges, frames, orphanEntities, unresolvedRelations } = useMemo(() => {
    // 拖过的节点记在这里：它是**覆盖**，压在算出来的坐标上面，所以拖完不会弹回去，分组框也跟着它变。
    const positions = positionKey ? readStoredPositions(positionKey) : {};
    const connected = new Set<string>();
    const degree = new Map<string, number>();
    const drawnEdges: SigmaEdge[] = [];
    const unresolved: RelationType[] = [];
    for (const relation of definition.relationshipTypes) {
      if (!entityById.has(relation.sourceEntityTypeId) || !entityById.has(relation.targetEntityTypeId)) { unresolved.push(relation); continue; }
      connected.add(relation.sourceEntityTypeId);
      connected.add(relation.targetEntityTypeId);
      degree.set(relation.sourceEntityTypeId, (degree.get(relation.sourceEntityTypeId) ?? 0) + 1);
      degree.set(relation.targetEntityTypeId, (degree.get(relation.targetEntityTypeId) ?? 0) + 1);
      drawnEdges.push({ id: relation.id, type: relation.name, source: relation.sourceEntityTypeId, target: relation.targetEntityTypeId });
    }
    let hubId: string | null = null;
    let hubDegree = -1;
    for (const entity of definition.entityTypes) {
      const value = degree.get(entity.id) ?? 0;
      if (value > hubDegree) { hubDegree = value; hubId = entity.id; }
    }
    const fallback = radialLayout(definition.entityTypes, drawnEdges, layoutSeed);
    // 概念分组的框与坐标只在「按逻辑分组」下算：另外两种布局不看分组，也不画框。
    const frames = buildGroupFrames(definition.groups, definition.entityTypes, definition.entityTypes.map((entity) => ({ id: entity.id, name: entity.name })));
    const described = layout === "grouped"
      ? groupedLayoutPositions(frames, definition.entityTypes.filter((entity) => !frames.some((frame) => frame.nodeIds.includes(entity.id))).map((entity) => entity.id), drawnEdges, layoutSeed)
      : layout === "circle" ? circleLayout(definition.entityTypes.map((entity) => entity.id), layoutSeed) : null;
    const arranged = (id: string) => described?.get(id);
    const drawnNodes: SigmaNode[] = definition.entityTypes.map((entity) => ({
      id: entity.id,
      label: compactGraphLabel(entity.name),
      color: graphColor(entity.name),
      isHub: entity.id === hubId,
      x: positions[entity.id]?.x ?? arranged(entity.id)?.x ?? fallback.get(entity.id)?.x,
      y: positions[entity.id]?.y ?? arranged(entity.id)?.y ?? fallback.get(entity.id)?.y,
    }));
    return {
      nodes: drawnNodes,
      edges: drawnEdges,
      frames: layout === "grouped" ? frames : [],
      orphanEntities: definition.entityTypes.filter((entity) => !connected.has(entity.id)),
      unresolvedRelations: unresolved,
    };
  }, [definition.entityTypes, definition.groups, definition.relationshipTypes, entityById, layout, layoutSeed, positionKey]);

  const selectedEntity = selected?.kind === "entity" ? entityById.get(selected.id) ?? null : null;
  const selectedRelation = selected?.kind === "relation" ? relationById.get(selected.id) ?? null : null;

  const organize = useCallback(() => {
    // 「自动整理」= 忘掉手工摆放，回到算出来的位置（分组布局下就是转一圈重新铺）。
    if (positionKey) writeStoredPositions(positionKey, {});
    setLayoutSeed((seed) => seed + 1);
  }, [positionKey]);

  /** 改一个对象类型的归属（空串 = 移出分组）：分组不属于任何类型，所以整份存草稿。 */
  const assignGroup = (entityId: string, groupId: string) => {
    void onSaveDefinition({ ...definition, entityTypes: definition.entityTypes.map((item) => (item.id === entityId ? { ...item, groupId } : item)) }).catch(onFail);
  };

  const openCreateRelation = (source: string, target: string) => {
    setDialog({ kind: "relation", mode: "create", id: newId(), source, target });
    setConnectFrom(null);
  };

  const handleNodeClick = (nodeId: string) => {
    if (connectFrom && connectFrom !== nodeId) { openCreateRelation(connectFrom, nodeId); return; }
    if (connectFrom === nodeId) { setConnectFrom(null); return; }
    setSelected({ kind: "entity", id: nodeId });
  };

  const startConnection = (source: string) => {
    setConnectFrom(source);
    setSelected({ kind: "entity", id: source });
  };

  const gapCount = orphanEntities.length + unresolvedRelations.length;

  return (
    <div className="ob-shell">
      <div className="ob-canvas">
      <SigmaGraph
        nodes={nodes}
        edges={edges}
        frames={frames}
        selectedNodeId={selected?.kind === "entity" ? selected.id : null}
        selectedEdgeId={selected?.kind === "relation" ? selected.id : null}
        connectionSourceId={connectFrom}
        draggable
        layoutRequest={0}
        onNodeClick={handleNodeClick}
        onEdgeClick={(edgeId) => setSelected({ kind: "relation", id: edgeId })}
        onStageClick={() => { setSelected(null); setConnectFrom(null); }}
        onDragEnd={(nodeId, point) => { if (positionKey && canEdit) writeStoredPositions(positionKey, { ...readStoredPositions(positionKey), [nodeId]: point }); }}
        onLayoutEnd={() => undefined}
      />

      <div className="ob-toolbar">
        <button className="graph-tool-action" disabled={!canEdit} onClick={() => setDialog({ kind: "entity", mode: "create", id: newId() })}>
          <Plus size={14} />对象类型
        </button>
        <button
          className={connectFrom ? "graph-tool-action" : "ob-tool-action"}
          disabled={!canEdit || definition.entityTypes.length < 2}
          onClick={() => (connectFrom ? setConnectFrom(null) : setConnectFrom(selectedEntity?.id ?? definition.entityTypes[0]?.id ?? null))}
          title={connectFrom ? "取消连线" : "先点起点对象类型，再点终点对象类型"}
        >
          <Link2 size={14} />{connectFrom ? "退出连线" : "新建关系类型"}
        </button>
        <button className="ob-tool-action" onClick={organize} title="按现有关系重新铺开，恢复默认摆放"><Wand2 size={14} />自动整理</button>
        <LayoutSwitcher value={layout} onChange={setLayout} />
        <button className="ob-tool-action" disabled={!onOpenGroups} onClick={() => onOpenGroups?.()} title="概念分组（业务域）：切到同一页的「概念分组」标签建分组、勾成员">
          <Boxes size={14} />概念分组 <b>{definition.groups.length}</b>
        </button>
        <span className="ob-count">{definition.entityTypes.length} 个对象类型 · {definition.relationshipTypes.length} 关系类型</span>
      </div>


      {connectFrom && (
        <div className="ob-connect-hint" role="status">
          <Link2 size={13} />
          正在从「{entityById.get(connectFrom)?.name ?? "对象类型"}」连线，点另一个对象类型作为终点
          <button onClick={() => setConnectFrom(null)}>取消</button>
        </div>
      )}

      {gapCount > 0 && (
        <div className="ob-gaps">
          <b><AlertTriangle size={13} />发布前待补全</b>
          {unresolvedRelations.map((relation) => (
            <button key={relation.id} onClick={() => setSelected({ kind: "relation", id: relation.id })}>{relation.name}<span>端点未定</span></button>
          ))}
          {orphanEntities.map((entity) => (
            <button key={entity.id} onClick={() => setSelected({ kind: "entity", id: entity.id })}>{entity.name}<span>未接入关系类型</span></button>
          ))}
        </div>
      )}

      {!definition.entityTypes.length && (
        <div className="ob-empty">
          <CircleDot size={26} />
          <b>画布上还没有对象类型</b>
          <span>先落一个对象类型，从它拉出关系类型，再补端点和属性。每次改动都会立刻存进草稿。</span>
          <div>
            <button className="graph-action primary" disabled={!canEdit} onClick={() => setDialog({ kind: "entity", mode: "create", id: newId() })}><Plus size={15} />新建对象类型</button>
            {hasSnapshot && <button className="graph-action" disabled={!canEdit} onClick={onExtract}><Database size={15} />从快照提取类型</button>}
          </div>
        </div>
      )}

      </div>
      <aside className="ob-inspector">
        {selectedEntity ? (
          <>
            <div className="graph-inspector-head">
              <div><span style={{ background: graphColor(selectedEntity.name) }} />对象类型</div>
              <button aria-label="关闭详情" onClick={() => setSelected(null)}><X size={15} /></button>
            </div>
            <div className="graph-inspector-body">
              <h3>{selectedEntity.name}</h3>
              <p>{selectedEntity.description || "未填写说明"}</p>
              <div className="ob-facts">
                <span>属性 <b>{selectedEntity.properties.length}</b></span>
                <span>必填 <b>{selectedEntity.properties.filter((item) => item.required).length}</b></span>
                <span>标题 <b>{selectedEntity.displayProperty || "默认"}</b></span>
              </div>
              <label className="ob-group-pick">
                <span><Boxes size={12} />概念分组</span>
                <select value={selectedEntity.groupId ?? ""} disabled={!canEdit} onChange={(event) => assignGroup(selectedEntity.id, event.target.value)}>
                  <option value="">未归组</option>
                  {definition.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
                <small>{definition.groups.length ? "选一个业务域，图谱「按逻辑分组」时它会和同组的类型画在一个框里。" : "还没有分组，点工具栏的「概念分组」新建一个。"}</small>
              </label>
              {selectedLineage.direct.length > 0 && (
                <p className="ob-lineage"><CornerDownRight size={12} />继承自 <b>{selectedLineage.direct.join("、")}</b></p>
              )}
              {selectedLineage.extra.length > 0 && (
                <p className="ob-lineage"><CornerDownRight size={12} />也属于 <b>{selectedLineage.extra.join("、")}</b></p>
              )}
              {selectedEntity.properties.length > 0 || selectedInherited.length > 0 ? (
                <div className="graph-properties">
                  {selectedEntity.properties.map((property) => (
                    <div key={property.name}>
                      <div><b>{property.name}</b>{property.required && <em>必填</em>}</div>
                      <span>{property.dataType}{property.unique ? " · 唯一" : ""}</span>
                    </div>
                  ))}
                  {selectedInherited.map(({ property, from }) => (
                    <div key={`inherited-${property.name}`} className="inherited">
                      <div><b>{property.name}</b>{property.required && <em>必填</em>}</div>
                      <span>{property.dataType} · 来自 {from}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="ob-inspector-note">还没有属性。点「编辑」补上业务属性与必填约束。</p>}
              <InvolvedActions definition={definition} entityTypeId={selectedEntity.id} onOpen={onOpenActions} />
              <div className="graph-inspector-actions">
                <button className="graph-action" disabled={!canEdit} onClick={() => setDialog({ kind: "entity", mode: "edit", id: selectedEntity.id })}><Pencil size={13} />编辑</button>
                <button className="graph-action" disabled={!canEdit || definition.entityTypes.length < 2} onClick={() => startConnection(selectedEntity.id)}><Link2 size={13} />新建关系类型</button>
              </div>
              <button className="graph-action danger" disabled={!canEdit} onClick={() => { onDeleteEntity(selectedEntity.id).then(() => setSelected(null)).catch(onFail); }}><Trash2 size={13} />删除对象类型</button>
            </div>
          </>
        ) : selectedRelation ? (
          <>
            <div className="graph-inspector-head">
              <div><span style={{ background: "#7a8f8c" }} />关系类型</div>
              <button aria-label="关闭详情" onClick={() => setSelected(null)}><X size={15} /></button>
            </div>
            <div className="graph-inspector-body">
              <h3>{selectedRelation.name}</h3>
              <p><span>起点</span> {entityById.get(selectedRelation.sourceEntityTypeId)?.name ?? "未指定"}<br /><span>终点</span> {entityById.get(selectedRelation.targetEntityTypeId)?.name ?? "未指定"}</p>
              {(entityById.get(selectedRelation.sourceEntityTypeId)?.name ?? "") === "" || (entityById.get(selectedRelation.targetEntityTypeId)?.name ?? "") === "" ? <p className="ob-inspector-warning"><AlertTriangle size={13} />端点未指定，这条关系类型不会出现在画布上，也无法发布。</p> : null}
              {selectedRelation.properties.length > 0 ? (
                <div className="graph-properties">
                  {selectedRelation.properties.map((property) => (
                    <div key={property.name}>
                      <div><b>{property.name}</b>{property.required && <em>必填</em>}</div>
                      <span>{property.dataType}{property.unique ? " · 唯一" : ""}</span>
                    </div>
                  ))}
                </div>
              ) : <p className="ob-inspector-note">这条关系类型没有额外属性。</p>}
              <InvolvedActions definition={definition} relationTypeId={selectedRelation.id} onOpen={onOpenActions} />
              <div className="graph-inspector-actions">
                <button className="graph-action" disabled={!canEdit} onClick={() => setDialog({ kind: "relation", mode: "edit", id: selectedRelation.id })}><Pencil size={13} />编辑</button>
                <button className="graph-action danger" disabled={!canEdit} onClick={() => { onDeleteRelation(selectedRelation.id).then(() => setSelected(null)).catch(onFail); }}><Trash2 size={13} />删除</button>
              </div>
            </div>
          </>
        ) : (
          <div className="graph-inspector-body">
            <div className="graph-inspector-empty">
              <LocateFixed size={20} />
              <b>选择一个元素</b>
              <span>点对象类型看它的属性；点连线看端点契约。拖节点可调整摆放，「自动整理」复位。</span>
            </div>
          </div>
        )}
      </aside>

      {dialog?.kind === "entity" && (
        <TypeEditDialog
          kind="entity"
          mode={dialog.mode}
          entity={dialog.mode === "edit" ? entityById.get(dialog.id) ?? null : null}
          entityTypes={definition.entityTypes}
          groups={definition.groups}
          onClose={() => setDialog(null)}
          onSave={async (payload) => {
            const body: EntityPayload = { name: payload.name, description: payload.description ?? "", displayProperty: payload.displayProperty ?? "", groupName: payload.groupName, parents: payload.parents, properties: payload.properties, sources: payload.sources };
            if (dialog.mode === "create") { await onCreateEntity(dialog.id, body); setSelected({ kind: "entity", id: dialog.id }); }
            else await onUpdateEntity(dialog.id, body);
          }}
        />
      )}
      {dialog?.kind === "relation" && (
        <TypeEditDialog
          kind="relation"
          mode={dialog.mode}
          relation={dialog.mode === "edit" ? relationById.get(dialog.id) ?? null : { id: dialog.id, name: "", sourceEntityTypeId: dialog.source, targetEntityTypeId: dialog.target, properties: [] }}
          entityTypes={definition.entityTypes}
          onClose={() => setDialog(null)}
          onSave={async (payload) => {
            const body: RelationPayload = { name: payload.name, description: payload.description, sourceEntityTypeId: payload.sourceEntityTypeId ?? "", targetEntityTypeId: payload.targetEntityTypeId ?? "", properties: payload.properties };
            if (dialog.mode === "create") { await onCreateRelation(dialog.id, body); setSelected({ kind: "relation", id: dialog.id }); }
            else await onUpdateRelation(dialog.id, body);
          }}
        />
      )}
    </div>
  );
}

/**
 * 类 / 关系类型这一侧看"谁在动我"。
 * 关联由动作的参数与操作模板推导（actionInvolvement），不是另存的一张表。
 */
function InvolvedActions({ definition, entityTypeId, relationTypeId, onOpen }: { definition: Definition; entityTypeId?: string; relationTypeId?: string; onOpen?: () => void }) {
  const entries = definition.actionTypes
    .map((action) => {
      const involvement = actionInvolvement(definition, action);
      const hit = entityTypeId
        ? involvement.entityTypes.find((item) => item.id === entityTypeId)
        : involvement.relationshipTypes.find((item) => item.id === relationTypeId);
      return hit ? { action, roles: hit.roles } : null;
    })
    .filter((item): item is { action: ActionType; roles: string[] } => Boolean(item));
  const targetName = entityTypeId ? definition.entityTypes.find((item) => item.id === entityTypeId)?.name ?? "" : definition.relationshipTypes.find((item) => item.id === relationTypeId)?.name ?? "";
  const scoped = entries.filter((item) => item.roles.includes("主对象"));
  const referenced = entries.filter((item) => !item.roles.includes("主对象"));
  if (!entries.length) {
    return <p className="ob-inspector-note">还没有动作定义在对象类型「{targetName}」上；在「动作」页新建动作时把作用的对象类型选成它，这里就会出现，并能直接执行。</p>;
  }
  return (
    <>
      <p className="ob-inspector-note">对象类型在数据里体现为节点上的这个标签。动作定义在对象类型上，作用在属于它的对象（实例）上。</p>
      {scoped.length > 0 && (
        <div className="ob-actions">
          <b>{relationTypeId ? "会建出这条关系类型的动作" : "定义在这个对象类型上的动作"}</b>
          {scoped.map(({ action, roles }) => (
            <button key={action.id} onClick={onOpen} disabled={!onOpen} title="去「动作」页运行或编辑">
              <span>{action.name || action.code || "未命名动作"}</span>
              <em>{roles.join(" · ")}</em>
            </button>
          ))}
        </div>
      )}
      {referenced.length > 0 && (
        <div className="ob-actions">
          <b>引用这个对象类型的动作</b>
          {referenced.map(({ action, roles }) => (
            <button key={action.id} onClick={onOpen} disabled={!onOpen} title="去「动作」页运行或编辑">
              <span>{action.name || action.code || "未命名动作"}</span>
              <em>{roles.join(" · ")}</em>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
