"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Braces,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Command,
  Database,
  Eye,
  FileCheck2,
  GitBranch,
  Layers3,
  Link2,
  LockKeyhole,
  Network,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  TableProperties,
  TerminalSquare,
  UsersRound,
  X,
} from "lucide-react";
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

type View = "overview" | "ontology" | "entities" | "relations" | "properties" | "runtime" | "cypher" | "targets";
type EntityType = { name: string; description: string; count: number; color: string; properties: number };

const baseTypes: EntityType[] = [
  { name: "客户", description: "参与商机与合同的业务主体", count: 248, color: "mint", properties: 6 },
  { name: "商机", description: "可追踪的销售机会", count: 186, color: "coral", properties: 8 },
  { name: "产品", description: "可售卖或交付的产品", count: 42, color: "blue", properties: 5 },
  { name: "员工", description: "承担客户或商机职责的成员", count: 63, color: "yellow", properties: 5 },
];

const relationshipTypes = [
  { name: "负责", from: "员工", to: "商机", count: 186, color: "yellow" },
  { name: "关联", from: "商机", to: "客户", count: 214, color: "coral" },
  { name: "包含", from: "商机", to: "产品", count: 326, color: "blue" },
];

const navGroups: { label: string; items: { id: View; label: string; icon: typeof Network }[] }[] = [
  {
    label: "图谱空间",
    items: [
      { id: "overview", label: "总览", icon: Layers3 },
      { id: "ontology", label: "本体草稿", icon: BookOpen },
      { id: "runtime", label: "运行时 Schema", icon: Network },
    ],
  },
  {
    label: "图数据",
    items: [
      { id: "entities", label: "实体", icon: CircleDot },
      { id: "relations", label: "关系", icon: Link2 },
      { id: "properties", label: "属性", icon: TableProperties },
    ],
  },
  {
    label: "操作",
    items: [
      { id: "cypher", label: "Cypher 工作台", icon: TerminalSquare },
      { id: "targets", label: "连接目标", icon: Database },
    ],
  },
];

const titles: Record<View, { kicker: string; title: string; subtitle: string }> = {
  overview: { kicker: "本体控制室", title: "客户关系知识图谱", subtitle: "草稿 v1.4  已校验，可发布" },
  ontology: { kicker: "建模", title: "本体草稿 · v1.4", subtitle: "类型变更只会在发布后约束实例管理" },
  entities: { kicker: "图数据", title: "实体管理", subtitle: "每个实体只能选择一个已发布实体类型" },
  relations: { kicker: "图数据", title: "关系管理", subtitle: "端点必须符合已发布的关系契约" },
  properties: { kicker: "图数据", title: "属性字典", subtitle: "规则定义于类型，值编辑于实体或关系实例" },
  runtime: { kicker: "发现", title: "运行时 Schema", subtitle: "来自 CALL db.schema.visualization() 的当前事实" },
  cypher: { kicker: "操作", title: "Cypher 工作台", subtitle: "默认只读。写入语句需要单次确认。" },
  targets: { kicker: "连接", title: "Neo4j 目标", subtitle: "凭据加密保存在平台 PostgreSQL 中" },
};

function Count({ value, label }: { value: string; label: string }) {
  return <div className="count"><strong>{value}</strong><span>{label}</span></div>;
}

export function OntologyWorkbench() {
  const [view, setView] = useState<View>("overview");
  const [types, setTypes] = useState(baseTypes);
  const [draftOpen, setDraftOpen] = useState(false);
  const [typeName, setTypeName] = useState("");
  const [query, setQuery] = useState("MATCH (c:客户)-[:关联]-(o:商机)\nRETURN c.名称 AS 客户, count(o) AS 商机数\nORDER BY 商机数 DESC\nLIMIT 8");
  const [writeMode, setWriteMode] = useState(false);
  const [executed, setExecuted] = useState(false);
  const heading = titles[view];

  const graphNodes = useMemo<Node[]>(() => types.slice(0, 5).map((item, index) => ({
    id: item.name,
    position: [{ x: 78, y: 145 }, { x: 355, y: 56 }, { x: 355, y: 270 }, { x: 640, y: 145 }, { x: 635, y: 330 }][index] ?? { x: 620, y: 60 },
    data: { label: <div className={`flow-node ${item.color}`}><span>{item.name.slice(0, 1)}</span><div><b>{item.name}</b><small>{item.count} 个实例</small></div></div> },
    type: "default",
    draggable: false,
  })), [types]);

  const graphEdges = useMemo<Edge[]>(() => [
    { id: "e1", source: "员工", target: "商机", label: "负责", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#c9a948", strokeWidth: 1.4 }, labelStyle: { fill: "#8a6c1c", fontSize: 11 } },
    { id: "e2", source: "商机", target: "客户", label: "关联", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#cf6d58", strokeWidth: 1.4 }, labelStyle: { fill: "#a24e3c", fontSize: 11 } },
    { id: "e3", source: "商机", target: "产品", label: "包含", markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "#4989a4", strokeWidth: 1.4 }, labelStyle: { fill: "#246c87", fontSize: 11 } },
  ], []);

  function createType() {
    const normalized = typeName.trim();
    if (!normalized || types.some((item) => item.name === normalized)) return;
    setTypes((items) => [...items, { name: normalized, description: "等待配置属性与关系契约", count: 0, color: "mint", properties: 0 }]);
    setTypeName("");
    setDraftOpen(false);
    setView("ontology");
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><GitBranch size={21} /></div><div><strong>ATLAS</strong><span>ONTOLOGY CONTROL</span></div></div>
        <div className="target-chip"><span className="live-dot" /><div><small>当前目标</small><b>crm-knowledge-prod</b></div><ChevronDown size={15} /></div>
        <nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><p>{group.label}</p>{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} className={view === item.id ? "nav-item selected" : "nav-item"} onClick={() => setView(item.id)}><Icon size={17} />{item.label}{item.id === "ontology" && <i>v1.4</i>}</button>; })}</div>)}</nav>
        <div className="sidebar-foot"><div className="status-line"><span className="live-dot" />Neo4j 已连接</div><button className="account"><div className="avatar">LY</div><span><b>刘宇</b><small>管理员</small></span><ChevronDown size={15} /></button></div>
      </aside>

      <section className="workspace">
        <header className="topbar"><div className="crumb"><span>图谱治理</span><b>/</b><strong>{heading.title}</strong></div><div className="top-actions"><button className="icon-button" title="搜索"><Search size={18} /></button><button className="icon-button" title="通知"><Activity size={18} /><i className="notification" /></button><button className="help-button"><Command size={15} /> K</button></div></header>
        <div className="content">
          <section className="page-heading"><div><p>{heading.kicker}</p><h1>{heading.title}</h1><span>{heading.subtitle}</span></div><div className="heading-actions">{view === "ontology" || view === "overview" ? <><button className="quiet-button"><FileCheck2 size={17} />校验草稿</button><button className="primary-button" onClick={() => setDraftOpen(true)}><Plus size={17} />新增实体类型</button></> : <button className="primary-button"><Plus size={17} />新增{view === "entities" ? "实体" : view === "relations" ? "关系" : "配置"}</button>}</div></section>
          {view === "overview" && <Overview types={types} graphNodes={graphNodes} graphEdges={graphEdges} onNavigate={setView} />}
          {view === "ontology" && <OntologyTable types={types} onCreate={() => setDraftOpen(true)} />}
          {view === "entities" && <Entities types={types} />}
          {view === "relations" && <Relationships />}
          {view === "properties" && <Properties />}
          {view === "runtime" && <RuntimeSchema graphNodes={graphNodes} graphEdges={graphEdges} />}
          {view === "cypher" && <CypherWorkspace query={query} setQuery={setQuery} writeMode={writeMode} setWriteMode={setWriteMode} executed={executed} onRun={() => setExecuted(true)} />}
          {view === "targets" && <Targets />}
        </div>
      </section>
      {draftOpen && <CreateTypeDialog value={typeName} onChange={setTypeName} onClose={() => setDraftOpen(false)} onCreate={createType} />}
    </main>
  );
}

function Overview({ types, graphNodes, graphEdges, onNavigate }: { types: EntityType[]; graphNodes: Node[]; graphEdges: Edge[]; onNavigate: (view: View) => void }) {
  return <><section className="metric-strip"><Count value={`${types.length}`} label="已发布实体类型" /><Count value="3" label="关系类型" /><Count value="28" label="属性定义" /><Count value="1,265" label="受控图谱实例" /><div className="validation"><CheckCircle2 size={18} /><span><b>草稿校验通过</b>端点、属性与现有数据均符合 v1.4</span><ArrowUpRight size={16} /></div></section><section className="main-grid"><div className="panel graph-panel"><div className="panel-head"><div><span className="eyebrow">本体视图</span><h2>已发布类型映射</h2></div><button className="text-button" onClick={() => onNavigate("ontology")}>查看草稿 <ArrowUpRight size={15} /></button></div><div className="flow-wrap"><ReactFlow nodes={graphNodes} edges={graphEdges} fitView fitViewOptions={{ padding: 0.22 }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}><Background color="#d8ddd6" gap={18} size={1} /><Controls showInteractive={false} /></ReactFlow></div><div className="graph-note"><Sparkles size={15} />已发布类型可用于创建实例；运行时 Schema 只展示已有实例。</div></div><div className="side-stack"><div className="panel activity-panel"><div className="panel-head"><div><span className="eyebrow">发布轨迹</span><h2>版本状态</h2></div><span className="version-badge">v1.4</span></div><div className="timeline"><div><i className="success" /><p><b>草稿校验已完成</b><span>属性规则与关系契约均有效</span><time>10:42</time></p></div><div><i /><p><b>客户.行业 属性已更新</b><span>文本数组 {"->"} 文本</span><time>09:18</time></p></div><div><i /><p><b>v1.3 已发布</b><span>为商机新增产品包含关系</span><time>昨天</time></p></div></div></div><div className="panel quick-panel"><span className="eyebrow">安全边界</span><div><LockKeyhole size={20} /><p><b>Cypher 默认只读</b><span>写入必须切换模式并单次确认</span></p></div><button className="text-button" onClick={() => onNavigate("cypher")}>打开工作台 <ArrowUpRight size={15} /></button></div></div></section></>;
}

function OntologyTable({ types, onCreate }: { types: EntityType[]; onCreate: () => void }) {
  return <section className="panel table-panel"><div className="section-toolbar"><div className="segmented"><button className="active">实体类型 <b>{types.length}</b></button><button>关系类型 <b>3</b></button><button>属性规则 <b>28</b></button></div><button className="quiet-button" onClick={onCreate}><Plus size={16} />添加类型</button></div><div className="type-table"><div className="table-row table-label"><span>类型</span><span>说明</span><span>属性</span><span>实例</span><span>状态</span></div>{types.map((item) => <div className="table-row" key={item.name}><span><i className={`type-dot ${item.color}`} /> <b>{item.name}</b></span><span>{item.description}</span><span>{item.properties} 项</span><span>{item.count.toLocaleString()}</span><span><em>已发布</em></span></div>)}</div><div className="publication-bar"><div><ShieldCheck size={18} /><span><b>发布保护已启用</b>发布前会校验目标数据库内所有既有实例。</span></div><button className="primary-button"><ArrowUpRight size={17} />发布 v1.4</button></div></section>;
}

function Entities({ types }: { types: EntityType[] }) {
  return <section className="two-column"><div className="panel table-panel"><div className="section-toolbar"><div className="search-field"><Search size={16} /><input placeholder="搜索实体名称或属性" /></div><button className="filter-button">所有类型 <ChevronDown size={15} /></button></div><div className="entity-list">{["深圳远航科技", "华北医药集团", "智慧供应链升级", "企业协同套件"].map((name, index) => { const type = types[index % types.length]; return <button key={name} className="entity-row"><i className={`type-dot ${type.color}`} /><span><b>{name}</b><small>{type.name} · 更新于今天</small></span><ArrowUpRight size={16} /></button>; })}</div></div><div className="panel detail-panel"><span className="eyebrow">选中实体</span><h2>深圳远航科技</h2><div className="identity-line"><i className="type-dot mint" />客户 <em>已发布类型</em></div><dl><div><dt>统一社会信用代码</dt><dd>91440300MA5G9X82X3</dd></div><div><dt>行业</dt><dd>企业服务</dd></div><div><dt>客户等级</dt><dd>A</dd></div></dl><button className="quiet-button"><TableProperties size={16} />编辑属性值</button></div></section>;
}

function Relationships() { return <section className="two-column"><div className="panel table-panel"><div className="section-toolbar"><span className="eyebrow">关系实例 · 726</span><button className="quiet-button"><Plus size={16} />新建关系</button></div><div className="relation-list">{relationshipTypes.map((item) => <div className="relation-row" key={item.name}><span>{item.from}</span><i className={`line ${item.color}`} /><b>{item.name}</b><i className={`line ${item.color}`} /><span>{item.to}</span><em>{item.count}</em></div>)}</div></div><div className="panel contract-panel"><span className="eyebrow">关系契约</span><h2>负责</h2><div className="contract-path"><div className="contract-card yellow"><UsersRound size={21} /><b>员工</b><small>起始类型</small></div><ArrowUpRight size={18} /><div className="contract-card coral"><CircleDot size={21} /><b>商机</b><small>终止类型</small></div></div><p>创建关系时会校验两个端点类型和方向，不符合契约的连接不能写入。</p><button className="quiet-button"><BookOpen size={16} />编辑契约</button></div></section>;
}

function Properties() { const rows = [["客户", "名称", "文本", "必填", "索引"], ["客户", "统一社会信用代码", "文本", "必填", "唯一"], ["商机", "预计金额", "小数", "否", "索引"], ["负责", "分配日期", "日期", "必填", "-"]]; return <section className="panel table-panel"><div className="section-toolbar"><div className="segmented"><button className="active">属性定义</button><button>实例属性值</button></div><button className="quiet-button"><Plus size={16} />新增属性</button></div><div className="property-table"><div className="table-row table-label"><span>所属类型</span><span>属性名称</span><span>数据类型</span><span>必填</span><span>强制规则</span></div>{rows.map((row) => <div className="table-row" key={row.join("-")}><span><i className="type-dot mint" />{row[0]}</span><span><b>{row[1]}</b></span><span><code>{row[2]}</code></span><span>{row[3] === "必填" ? <CheckCircle2 className="check" size={16} /> : "-"}</span><span>{row[4] === "-" ? "-" : <em>{row[4]}</em>}</span></div>)}</div><div className="property-footer"><span>支持：文本、整数、小数、布尔值、日期、日期时间、文本数组、JSON</span><button className="text-button">查看发布影响 <ArrowUpRight size={15} /></button></div></section>;
}

function RuntimeSchema({ graphNodes, graphEdges }: { graphNodes: Node[]; graphEdges: Edge[] }) { return <section className="runtime-layout"><div className="panel graph-panel"><div className="panel-head"><div><span className="eyebrow">实时发现</span><h2>CALL db.schema.visualization()</h2></div><div className="fresh"><span className="live-dot" />刚刚刷新</div></div><div className="flow-wrap runtime-flow"><ReactFlow nodes={graphNodes} edges={graphEdges} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}><Background color="#d8ddd6" gap={18} size={1} /><Controls showInteractive={false} /></ReactFlow></div></div><aside className="runtime-aside"><div className="callout"><Eye size={19} /><b>这是运行时事实</b><span>仅显示目标库已有实例的标签和关系类型。</span></div><div className="schema-list"><span className="eyebrow">发现结果</span>{["4 个节点标签", "3 个关系类型", "1,265 个图谱实例"].map((item) => <div key={item}><CheckCircle2 size={16} />{item}</div>)}</div></aside></section>;
}

function CypherWorkspace({ query, setQuery, writeMode, setWriteMode, executed, onRun }: { query: string; setQuery: (value: string) => void; writeMode: boolean; setWriteMode: (value: boolean) => void; executed: boolean; onRun: () => void }) { return <section className="cypher-layout"><div className="panel editor-panel"><div className="editor-bar"><div><Braces size={18} /><span>crm-knowledge-prod</span><ChevronDown size={15} /></div><div className={writeMode ? "write-switch enabled" : "write-switch"}><button onClick={() => setWriteMode(false)}>只读</button><button onClick={() => setWriteMode(true)}>写入</button></div></div><textarea value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} /><div className="editor-foot"><span><LockKeyhole size={14} />{writeMode ? "写入模式：执行前需要确认" : "只读模式：无法执行变更语句"}</span><button className="run-button" onClick={onRun}><span>运行</span><kbd>Ctrl ↵</kbd></button></div></div><div className="panel result-panel"><div className="panel-head"><div><span className="eyebrow">结果</span><h2>{executed ? "8 行返回" : "等待执行"}</h2></div>{executed && <span className="duration">42 ms</span>}</div>{executed ? <div className="result-table"><div><b>客户</b><b>商机数</b></div>{[["深圳远航科技", "18"], ["华北医药集团", "15"], ["恒星制造", "12"], ["新川零售", "11"]].map((row) => <div key={row[0]}><span>{row[0]}</span><strong>{row[1]}</strong></div>)}</div> : <div className="empty-result"><TerminalSquare size={28} /><span>运行查询后在此查看记录、列与执行摘要。</span></div>}</div><div className="cypher-tip"><ShieldCheck size={18} /><span><b>执行策略</b>服务器检测写入关键字；查看者只能执行只读查询，管理员写入时还需单次确认。</span></div></section>;
}

function Targets() { return <section className="target-grid">{[["crm-knowledge-prod", "neo4j+s://graph.example.com", "生产", true], ["crm-knowledge-test", "neo4j://10.0.4.18:7687", "测试", false]].map(([name, uri, stage, live]) => <div className="panel target-card" key={String(name)}><div className="target-card-head"><div className="database-mark"><Database size={19} /></div><span className={live ? "live-pill" : "idle-pill"}>{live ? "已连接" : "未测试"}</span></div><h2>{name}</h2><code>{uri}</code><dl><div><dt>数据库</dt><dd>neo4j</dd></div><div><dt>用途</dt><dd>{stage}</dd></div></dl><div className="target-actions"><button className="quiet-button">测试连接</button><button className="icon-button" title="编辑目标"><TableProperties size={17} /></button></div></div>)}<button className="add-target"><Plus size={21} /><b>登记 Neo4j 目标</b><span>凭据将以加密形式保存</span></button></section>;
}

function CreateTypeDialog({ value, onChange, onClose, onCreate }: { value: string; onChange: (value: string) => void; onClose: () => void; onCreate: () => void }) { return <div className="dialog-backdrop" role="presentation"><form className="dialog" onSubmit={(event) => { event.preventDefault(); onCreate(); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><CircleDot size={22} /></div><span className="eyebrow">本体草稿</span><h2>新增实体类型</h2><p>发布后，实体管理才可将此类型作为节点 Label 使用。</p><label>类型名称<input autoFocus value={value} onChange={(event) => onChange(event.target.value)} placeholder="例如：合同" /></label><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!value.trim()}>创建到草稿</button></div></form></div>;
}
