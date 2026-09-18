import type { DataType } from "@/lib/instance-property-editor";

/**
 * 图数据库抽象层的公共契约。
 *
 * 这里只描述“任何图后端都成立”的概念：本体存储、图数据、运行时类型、查询结果。
 * 内置类型图与 Apache Jena 两个后端并存（Neo4j 已于 2026-09-14 移除），
 * 它实现 GraphStore，由 @/lib/graph 的注册表按 target.kind 分派。
 * 上层 API 路由与 React 组件只依赖这里的类型，不直接依赖 SPARQL 客户端。
 *
 * 新增后端（NetworkX、Elasticsearch 等）时只需要：
 * 1. 在 GraphTargetKind 中登记类型；
 * 2. 在 GRAPH_TARGET_KINDS 中补充连接表单元数据；
 * 3. 新增一个实现 GraphStore 的适配器并在 registry 中注册。
 */
export type GraphTargetKind = "JENA" | "EMBEDDED";

/** 后端原生查询语言。上层只用于展示与“是否允许直接写入”的判断。 */
export type QueryLanguage = "sparql";

export type GraphStoreCapabilities = {
  /** 能否读取“类型级”结构视图（Jena 用实例的 rdf:type 与 RDF Schema 推导）。 */
  schemaVisualization: boolean;
  /** 能否在图库侧落地唯一 / 必填等强约束。 */
  strongRules: boolean;
  /**
   * 整图替换是否原子：要么整体生效，要么图保持替换前的状态。
   * 发布流程据此决定失败后能不能说“图数据未被改动”。
   */
  atomicReplace: boolean;
};

/**
 * 引擎标记的几何来源：直接用该引擎自己的数据模型画，而不是套一个通用数据库图标。
 * triple = 闭合的主谓宾；mesh = 无向网格；shards = 分片。
 */
export type GraphTargetMark = "triple" | "mesh" | "shards";

export type GraphTargetKindInfo = {
  kind: GraphTargetKind;
  label: string;
  /** 用于按钮、徽标等紧凑位置。 */
  shortLabel: string;
  description: string;
  /** 数据模型的一句话说法，例如「属性图」「RDF 三元组」。 */
  modelLabel: string;
  /** 引擎专属强调色，只用于标记与选中态。 */
  accent: string;
  mark: GraphTargetMark;
  queryLanguage: QueryLanguage;
  queryLanguageLabel: string;
  capabilities: GraphStoreCapabilities;
  endpoint: { label: string; placeholder: string; example: string };
  dataset: { label: string; placeholder: string; example: string; required: boolean } | null;
  credentials: {
    usernameLabel: string;
    usernameExample: string;
    passwordLabel: string;
    /** 是否必须填写用户名和密码。 */
    required: boolean;
  };
};

export const GRAPH_TARGET_KINDS: GraphTargetKindInfo[] = [
  {
    kind: "EMBEDDED",
    label: "内置类型图",
    shortLabel: "内置",
    description: "类型定义保存在平台，按版本重建内存图，无需部署独立图服务。",
    modelLabel: "内存 RDF 图",
    accent: "#0d8b83",
    mark: "mesh",
    queryLanguage: "sparql",
    queryLanguageLabel: "SPARQL",
    capabilities: { schemaVisualization: true, strongRules: false, atomicReplace: true },
    endpoint: { label: "存储位置", placeholder: "平台数据库", example: "embedded://platform" },
    dataset: null,
    credentials: { usernameLabel: "用户名", usernameExample: "", passwordLabel: "密码", required: false },
  },
  {
    kind: "JENA",
    label: "Apache Jena",
    shortLabel: "Jena",
    description: "RDF/OWL 与 SPARQL 1.1。通过 Fuseki 的 SPARQL 端点读写三元组，支持推理机。",
    modelLabel: "RDF 三元组",
    accent: "#6d4aff",
    mark: "triple",
    queryLanguage: "sparql",
    queryLanguageLabel: "SPARQL",
    capabilities: { schemaVisualization: true, strongRules: false, atomicReplace: true },
    endpoint: { label: "SPARQL 服务地址", placeholder: "http://localhost:3030", example: "http://localhost:3030" },
    dataset: { label: "数据集名称", placeholder: "ds", example: "ds", required: true },
    credentials: { usernameLabel: "用户名（可选）", usernameExample: "admin", passwordLabel: "密码（可选）", required: false },
  },
];

/**
 * 路线图上的引擎，只用于选择器的「规划中」分类。
 * 刻意不并入 GraphTargetKind 与 GRAPH_TARGET_KINDS：数据库 kind 约束只应包含真正可连接的后端。
 */
export type PlannedGraphTarget = {
  key: string;
  label: string;
  description: string;
  /** 卡片上的能力行，与已支持引擎的「模型 · 查询语言」保持同样的位置。 */
  capability: string;
  note: string;
  accent: string;
  mark: GraphTargetMark;
};

export const PLANNED_GRAPH_TARGETS: PlannedGraphTarget[] = [
  { key: "NETWORKX", label: "NetworkX", description: "进程内图算法与推理，适合子图计算、中心性与社区发现。", capability: "图算法 · Python API", note: "规划中", accent: "#0f766e", mark: "mesh" },
  { key: "ELASTICSEARCH", label: "Elasticsearch", description: "文档检索与聚合，用于大图上的属性召回与倒排筛选。", capability: "检索 · 聚合", note: "规划中", accent: "#b45309", mark: "shards" },
];

/**
 * 前端对外提供的引擎。
 *
 * 2026-09-14：**Neo4j 已整体移除** —— 适配器、驱动依赖、类型枚举、界面入口一并删掉。
 * 内置类型图与 Apache Jena 并存；已有 Jena 存储不受影响。
 */
export const FRONTEND_GRAPH_TARGET_KINDS: GraphTargetKindInfo[] = GRAPH_TARGET_KINDS;

/** 新建本体存储时的默认引擎。 */
export const DEFAULT_GRAPH_TARGET_KIND: GraphTargetKind = "JENA";

/** 这个引擎是否在前端提供。 */
export function isFrontendGraphTargetKind(kind: GraphTargetKind): boolean {
  return GRAPH_TARGET_KINDS.some((item) => item.kind === kind);
}

export function isGraphTargetKind(value: unknown): value is GraphTargetKind {
  return typeof value === "string" && GRAPH_TARGET_KINDS.some((item) => item.kind === value);
}

export function graphTargetKindInfo(kind: GraphTargetKind): GraphTargetKindInfo {
  return GRAPH_TARGET_KINDS.find((item) => item.kind === kind) ?? GRAPH_TARGET_KINDS[0];
}

/** 本体存储记录：字段是所有后端共用的最小集合，后端专属配置放在 options 里。 */
export type GraphTarget = {
  id: string;
  name: string;
  kind: GraphTargetKind;
  /** Jena 的 SPARQL 服务地址；内置后端使用 embedded://platform 标识。 */
  uri: string;
  /** Jena 的数据集名；内置后端固定为 platform。 */
  database_name: string;
  username: string;
  credential_secret: string;
  options: Record<string, unknown>;
  created_at: Date;
};

export type GraphNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GraphRelationship = { id: string; type: string; source: string; target: string; properties: Record<string, unknown> };
export type GraphData = { nodes: GraphNode[]; relationships: GraphRelationship[] };

export type QueryResult = {
  keys: string[];
  records: Record<string, unknown>[];
  graph: GraphData;
  summary: string;
};

export type ConnectionInfo = {
  connected: true;
  kind: GraphTargetKind;
  address: string;
  agent: string;
  protocolVersion: string;
  detail?: Record<string, unknown>;
};

export type RuntimeProperty = { name: string; dataType: DataType; required: boolean; unique: boolean; indexed: boolean };
export type RuntimeTypeInfo = { name: string; count: number; properties?: RuntimeProperty[] };
export type RuntimeTypeSet = {
  labels: RuntimeTypeInfo[];
  relationshipTypes: RuntimeTypeInfo[];
  entityCount: number;
  relationshipCount: number;
  relationshipEndpoints?: Record<string, { source: string; target: string }>;
};

export type EntityRecord = { id: string; labels: string[]; properties: Record<string, unknown> };
export type RelationshipRecord = {
  id: string;
  type: string;
  sourceId: string;
  targetId: string;
  properties: Record<string, unknown>;
  sourceLabels?: string[];
  sourceProperties?: Record<string, unknown>;
  targetLabels?: string[];
  targetProperties?: Record<string, unknown>;
};
export type EntitySearchHit = EntityRecord & { matched: string[]; rank: number };

export type GraphViolation = { rule: string; message: string; count: number };

/** 属性定义的最小结构，正好是 OntologyDefinition 的子集，便于快照直接传入。 */
export type GraphPropertyDefinition = {
  name: string;
  dataType: DataType;
  required: boolean;
  unique: boolean;
  indexed: boolean;
  /** 只用于界面展示，图库侧不落这两个字段。 */
  displayName?: string;
  description?: string;
};
export type GraphDefinitionLike = {
  /** interfaces 是接口定义：发布时声明成抽象类，并写"谁实现了它"。 */
  interfaces?: { id?: string; name: string; extends?: string[] }[];
  /** 抽象关系只有一种：`implements`（实现了哪些接口）。发布时据此写 rdfs:subClassOf + bkn:implements。 */
  entityTypes: { id?: string; name: string; implements?: string[]; properties: GraphPropertyDefinition[] }[];
  relationshipTypes: { name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string; properties: GraphPropertyDefinition[] }[];
};

export type GraphWriteNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GraphWriteRelationship = { id: string; sourceId: string; targetId: string; type: string; properties: Record<string, unknown> };
/** 发布快照的写入视图，结构上等价于 VersionSnapshot。 */
export type GraphWriteSnapshot = {
  definition: GraphDefinitionLike;
  nodes: GraphWriteNode[];
  relationships: GraphWriteRelationship[];
};

/** 导出视图：id 由后端给出（Jena IRI），上层负责转成快照 UUID。 */
export type GraphExport = {
  nodes: { id: string; labels: string[]; properties: Record<string, unknown> }[];
  relationships: { id: string; sourceId: string; targetId: string; type: string; properties: Record<string, unknown> }[];
};

export type ReadGraphOptions = {
  label?: string | null;
  labels?: string[];
  relationshipTypes?: string[];
  search?: string | null;
  nodeLimit?: number;
};

export type ListEntitiesOptions = {
  label?: string | null;
  labels?: string[];
  search?: string | null;
  limit?: number;
  /** 类名 -> 展示属性名，来自已发布本体。 */
  displayProperties?: Record<string, string>;
};

export type SearchEntitiesOptions = {
  search: string;
  labels?: string[];
  limit?: number;
  displayProperties?: Record<string, string>;
};

export type ListRelationshipsOptions = {
  type?: string | null;
  search?: string | null;
  limit?: number;
};

/**
 * 一个已登记本体存储的统一操作面。
 * 每个方法都必须是后端无关的语义：调用方不应该知道底层是哪种查询语言。
 */
export interface GraphStore {
  readonly kind: GraphTargetKind;
  readonly target: GraphTarget;
  readonly info: GraphTargetKindInfo;

  /** 连通性自检，用于“测试连接”。 */
  testConnection(): Promise<ConnectionInfo>;
  /** 判断一条原生查询是否会写入图库。 */
  containsWriteStatement(query: string): boolean;
  /** 执行原生查询（SPARQL），返回表格结果与可绘制的图数据。 */
  execute(query: string, parameters?: Record<string, unknown>, options?: { readOnly?: boolean }): Promise<QueryResult>;
  /** 原生查询工作台的默认语句与提示。 */
  queryTemplate(): { defaultQuery: string; placeholder: string; visualizationHint: string };
  /** 类型级结构图：本体视图使用。 */
  readSchemaGraph(): Promise<QueryResult>;
  /** 图谱筛选用的类型元数据。 */
  readMeta(): Promise<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>;
  /** 运行时类型统计（类 / 关系类型 / 属性类型推断）。 */
  readRuntimeTypes(): Promise<RuntimeTypeSet>;
  /** 读取实例子图。 */
  readGraph(options?: ReadGraphOptions): Promise<GraphData>;
  /** 读取一度邻居，用于图谱扩展。 */
  readNeighborhood(id: string, limit: number): Promise<GraphData>;
  listEntities(options?: ListEntitiesOptions): Promise<EntityRecord[]>;
  readEntity(id: string): Promise<EntityRecord | null>;
  searchEntities(options: SearchEntitiesOptions): Promise<EntitySearchHit[]>;
  listRelationships(options?: ListRelationshipsOptions): Promise<RelationshipRecord[]>;
  /** 导出整图，用于从当前图数据初始化草稿快照。 */
  exportGraph(): Promise<GraphExport>;
  /**
   * 用快照整体替换图数据，发布/激活版本时调用。
   * 实现必须保证原子性：失败时图数据保持替换前的状态，不能留下半成品。
   */
  replaceGraph(snapshot: GraphWriteSnapshot): Promise<void>;

  /**
   * 清空这个本体存储里的图数据（全部节点与关系）。
   * 只动图库本身：平台自己的版本记录与快照不受影响，重新发布一次就能写回来。
   */
  clearGraph(): Promise<void>;
  /** 校验本体定义在图库上的约束违反情况。 */
  validateDefinition(definition: GraphDefinitionLike): Promise<GraphViolation[]>;
  /** 同步图库侧的强约束，返回是否支持必填约束。 */
  reconcileStrongRules(definition: GraphDefinitionLike): Promise<{ enforced: boolean }>;
}
