"use client";

import { type Target, type Version, type View } from "@/components/workbench/shared";
import { CircleDot, Link2, Network } from "lucide-react";
import { type RuntimeTypeInfo, type RuntimeTypeSet } from "@/lib/framework/graph/types";





export function censusRows(rows: RuntimeTypeInfo[], total: number, family: "entity" | "relation") {
  return rows.map((item) => (
    <div className="census-row" key={item.name}>
      <span className="census-name" title={item.name}>{item.name}</span>
      <span className={family === "entity" ? "census-track entity" : "census-track relation"}><i style={{ width: total ? `${Math.round((item.count / total) * 100)}%` : "0%" }} /></span>
      <span className="census-count">{item.count.toLocaleString()}</span>
    </div>
  ));
}


export function Overview({ target, draft, published, runtimeTypes, canViewGraph, onNavigate, onOpenStorage }: { target: Target | null; draft: Version | null; published: Version | null; runtimeTypes: RuntimeTypeSet | null; canViewGraph: boolean; onNavigate: (view: View) => void; onOpenStorage: () => void }) {
  const entityTypes = runtimeTypes?.labels.length ?? published?.definition.entityTypes.length ?? 0;
  const relationshipTypes = runtimeTypes?.relationshipTypes.length ?? published?.definition.relationshipTypes.length ?? 0;
  const entities = runtimeTypes?.entityCount ?? runtimeTypes?.labels.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const relationships = runtimeTypes?.relationshipCount ?? runtimeTypes?.relationshipTypes.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const entityRows = [...(runtimeTypes?.labels ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  const relationRows = [...(runtimeTypes?.relationshipTypes ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
  const entityTotal = entityRows.reduce((sum, item) => sum + item.count, 0);
  const relationTotal = relationRows.reduce((sum, item) => sum + item.count, 0);
  const hasCensus = runtimeTypes !== null;
  return <section className="panel functional-panel overview-panel"><span className="eyebrow">本体控制室</span><h2>{target ? "本体与运行时状态" : "开始登记第一个本体存储"}</h2>{target ? <><div className="overview-stats"><div className="overview-stat"><b>{entityTypes}</b><span>对象类型</span><small>对象的定义</small></div><div className="overview-stat"><b>{entities}</b><span>对象</span><small>数据库中的节点</small></div><div className="overview-stat"><b>{relationshipTypes}</b><span>关系类型</span><small>数据库中的关系类型</small></div><div className="overview-stat"><b>{relationships}</b><span>关系</span><small>数据库中的关系</small></div></div><div className="overview-status"><span>草稿：<b>{draft ? `v${draft.version_number}` : "无"}</b></span><span>已发布：<b>{published ? `v${published.version_number}` : "无"}</b></span></div>{hasCensus && (entityTotal + relationTotal > 0 ? <div className="overview-census"><section className="census-panel entity"><div className="census-head"><CircleDot size={15} /><span>对象类型分布</span><b>{entityRows.length}</b></div>{censusRows(entityRows, entityTotal, "entity")}</section><section className="census-panel relation"><div className="census-head"><Link2 size={15} /><span>关系类型分布</span><b>{relationRows.length}</b></div>{censusRows(relationRows, relationTotal, "relation")}</section></div> : <div className="overview-census-empty">图数据库中还没有数据。在「实例图谱」页创建节点与关系后，这里会展示每个对象类型与关系类型的数量分布。</div>)}</> : <p>先在「本体存储」登记图数据库的连接信息，凭据会加密保存。</p>}<div className="functional-actions">{target && canViewGraph && <button className="action" onClick={() => onNavigate("graph")}><Network size={16} />打开图谱管理</button>}<button className="action primary" onClick={() => target ? onNavigate("ontology") : onOpenStorage()}><span className="arrow">→</span>{target ? "查看本体" : "登记本体存储"}</button></div></section>;
}
