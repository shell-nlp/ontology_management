import { listDataSources } from "@/lib/data-sources";
import { getGraphStore } from "@/lib/graph";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp-protocol";
import { getOntology, listOntologies } from "@/lib/ontologies";
import { getPublishedOntology } from "@/lib/published-ontology";
import { REASONING_TOOLS, runReasoningTool, type ToolContext } from "@/lib/reasoning/tools";
import type { ToolOutcome } from "@/lib/reasoning/types";
import { getTarget } from "@/lib/targets";
import { listVersionRecords } from "@/lib/version-snapshot";

/**
 * 把本体工具通过 MCP（Model Context Protocol）暴露出去，让外部 agent / 客户端也能查这个本体。
 *
 * 复用 reasoning/tools.ts 的实现，一层都不重写 —— 平台里的「智能问答」和外部 MCP 客户端
 * 走的是同一套查询语义，不会出现"界面上查得到、MCP 里查不到"的漂移。
 */

export const MCP_SERVER_NAME = "ontology-management";
export const MCP_SERVER_VERSION = "0.1.0";
/** 协议版本与技能 MCP 共用一份（见 `@/lib/mcp-protocol`），这里原样再导出给路由用。 */
export { MCP_PROTOCOL_VERSION };

export type McpToolGroup = { key: string; label: string; description: string; disabled?: boolean };

/**
 * 分组照 bkn-studio 的说法：先找本体，再查模型，最后查实例。顺序就是使用顺序。
 *
 * 「对象实例与关系子图查询」这一组标了 disabled：2026-09-14 起只在对象类型 / 关系类型这一层
 * 推理，不查实例。它在 MCP 调试页上照样列出来，但是灰的、点不动，一眼能看出"有这两个工具、暂时不用"；
 * 外部客户端的 tools/list 里没有它们（见下面 MCP_TOOLS 与 MCP_TOOL_CATALOG 的区别）。
 */
export const MCP_TOOL_GROUPS: McpToolGroup[] = [
  { key: "discovery", label: "本体与 Schema", description: "本体列表与它落在哪个存储上" },
  { key: "model", label: "本体模型检索", description: "语义检索、对象类型、关系类型、动作定义" },
  { key: "data", label: "数据来源（只读）", description: "对象类型绑定的表：表结构与只读查询" },
  { key: "query", label: "对象实例与关系子图查询", description: "按类型取对象、取子图", disabled: true },
];

const TOOL_GROUP: Record<string, string> = {
  list_ontologies: "discovery",
  search_schema: "model",
  get_object_type: "model",
  list_concept_groups: "model",
  list_interfaces: "model",
  traverse_object_types: "model",
  list_actions: "model",
  review_model: "model",
  get_table_ddl: "data",
  run_sql: "data",
  query_object_instance: "query",
  query_instance_subgraph: "query",
};

const TOOL_TITLES: Record<string, string> = {
  list_ontologies: "本体列表",
  search_schema: "语义检索",
  get_object_type: "对象类型详情",
  list_concept_groups: "概念分组",
  list_interfaces: "接口",
  traverse_object_types: "对象类型多跳查询",
  list_actions: "动作定义",
  review_model: "建模体检",
  // 不叫「建表语句」：视图走的是视图定义，还原那条也不是库里的原始 CREATE，叫表结构才名实相符。
  get_table_ddl: "表结构",
  run_sql: "只读查询",
  query_object_instance: "对象实例查询",
  query_instance_subgraph: "关系子图查询",
};

export type McpTool = {
  name: string;
  title: string;
  group: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** 暂时不使用的工具：只出现在调试页的目录里，不出现在 tools/list。 */
  disabled?: boolean;
};

const ONTOLOGY_PROPERTY = {
  type: "string",
  description: "本体 id。先调 list_ontologies 拿到；不是图数据库连接 id。",
};

/** MCP 面向的是"本体"，所以每个工具都多一个 ontology_id，再带上它自己的参数。 */
function withOntology(tool: (typeof REASONING_TOOLS)[number]): McpTool {
  const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
  return {
    name: tool.name,
    title: TOOL_TITLES[tool.name] ?? tool.name,
    group: TOOL_GROUP[tool.name] ?? "model",
    description: tool.description,
    disabled: tool.disabled,
    inputSchema: {
      type: "object",
      properties: { ontology_id: ONTOLOGY_PROPERTY, ...(parameters.properties ?? {}) },
      required: ["ontology_id", ...(parameters.required ?? [])],
    },
  };
}

/** 给「MCP 调试」页看的全量目录：**含**暂时不用的工具，界面把它们灰着显示。 */
export function mcpToolCatalog(): McpTool[] {
  return [
  {
    name: "list_ontologies",
    title: TOOL_TITLES.list_ontologies,
    group: "discovery",
    description: "列出平台上登记的本体：id、名称、标识、落在哪个存储、版本状态与对象数量。查其它工具前先用它拿 ontology_id。",
    inputSchema: { type: "object", properties: {} },
  },
    ...REASONING_TOOLS.map(withOntology),
  ];
}

/**
 * 真正对外提供的工具：tools/list 与 tools/call 都走这一份。
 *
 * 两种"不提供"：平台自己停用的（`tool.disabled`，这一版不查实例），
 * 以及用户在「MCP 调试」里关掉的（`disabledTools`）。关掉的工具在外部客户端眼里就等于不存在。
 */
export function mcpTools(disabledTools: readonly string[] = []): McpTool[] {
  const off = new Set(disabledTools);
  return mcpToolCatalog().filter((tool) => !tool.disabled && !off.has(tool.name));
}

export function findMcpTool(name: string, disabledTools: readonly string[] = []) {
  return mcpTools(disabledTools).find((tool) => tool.name === name) ?? null;
}

async function listOntologySummaries() {
  const ontologies = await listOntologies();
  return Promise.all(ontologies.map(async (ontology) => {
    const records = await listVersionRecords(ontology.target_id).catch(() => []);
    const draft = records.find((record) => record.status === "DRAFT");
    const published = records.find((record) => record.status === "PUBLISHED");
    const definition = published?.definition ?? draft?.definition ?? null;
    return {
      ontology_id: ontology.id,
      name: ontology.name,
      identifier: ontology.identifier,
      description: ontology.description,
      tags: ontology.tags,
      draft_version: draft?.version_number ?? null,
      published_version: published?.version_number ?? null,
      object_types: definition?.entityTypes.length ?? 0,
      relation_types: definition?.relationshipTypes.length ?? 0,
      objects: published?.entity_count ?? 0,
      relationships: published?.relationship_count ?? 0,
    };
  }));
}

/** 走和平台内一致的解析路径：本体 → 落点 → 已发布定义 → 图库。 */
async function contextFor(ontologyId: string): Promise<ToolContext> {
  if (!ontologyId) throw new Error("缺少 ontology_id。先调 list_ontologies 拿一个。");
  const ontology = await getOntology(ontologyId);
  if (!ontology) throw new Error(`没有 id 为 ${ontologyId} 的本体。`);
  const target = await getTarget(ontology.target_id);
  if (!target) throw new Error(`本体「${ontology.name}」的落点不存在，可能已被删除。`);
  let definition;
  try {
    definition = await getPublishedOntology(target.id);
  } catch {
    throw new Error(`本体「${ontology.name}」还没有发布版本，先把草稿发布一次再查。`);
  }
  const store = getGraphStore(target);
  const runtimeTypes = await store.readRuntimeTypes().catch(() => null);
  // 对象类型绑了哪些表，模型自己看不到（绑定里只有资源 id），这里一并交给工具集翻译成可读文本。
  const dataSources = await listDataSources().catch(() => []);
  return { store, definition, runtimeTypes, dataSources };
}

export async function callMcpTool(name: string, args: Record<string, unknown>, disabledTools: readonly string[] = []): Promise<ToolOutcome> {
  if (name === "list_ontologies") {
    return { payload: { ontologies: await listOntologySummaries() }, evidence: [] };
  }
  if (!findMcpTool(name, disabledTools)) throw new Error(`没有叫「${name}」的工具。先调 tools/list 看可用工具（被关掉的工具不在里面）。`);
  const { ontology_id: ontologyId, ...rest } = args;
  const context = await contextFor(typeof ontologyId === "string" ? ontologyId : "");
  return runReasoningTool(name, rest, context);
}
