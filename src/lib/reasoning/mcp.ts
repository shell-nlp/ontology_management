import { listDataSources } from "@/lib/data-sources";
import { getGraphStore } from "@/lib/graph";
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
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type McpToolGroup = { key: string; label: string; description: string };

/** 分组照 bkn-studio 的说法：先找本体，再查模型，最后查实例。顺序就是使用顺序。 */
export const MCP_TOOL_GROUPS: McpToolGroup[] = [
  { key: "discovery", label: "本体与 Schema", description: "本体列表与它落在哪个存储上" },
  { key: "model", label: "本体模型检索", description: "语义检索、对象类型、关系类型、动作定义" },
  { key: "query", label: "对象实例与关系子图查询", description: "按类型取对象、取子图" },
];

const TOOL_GROUP: Record<string, string> = {
  list_ontologies: "discovery",
  search_schema: "model",
  get_object_type: "model",
  list_actions: "model",
  query_object_instance: "query",
  query_instance_subgraph: "query",
};

const TOOL_TITLES: Record<string, string> = {
  list_ontologies: "本体列表",
  search_schema: "语义检索",
  get_object_type: "对象类型详情",
  list_actions: "动作定义",
  query_object_instance: "对象实例查询",
  query_instance_subgraph: "关系子图查询",
};

export type McpTool = {
  name: string;
  title: string;
  group: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
    inputSchema: {
      type: "object",
      properties: { ontology_id: ONTOLOGY_PROPERTY, ...(parameters.properties ?? {}) },
      required: ["ontology_id", ...(parameters.required ?? [])],
    },
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_ontologies",
    title: TOOL_TITLES.list_ontologies,
    group: "discovery",
    description: "列出平台上登记的本体：id、名称、标识、落在哪个存储、版本状态与对象数量。查其它工具前先用它拿 ontology_id。",
    inputSchema: { type: "object", properties: {} },
  },
  ...REASONING_TOOLS.map(withOntology),
];

export function findMcpTool(name: string) {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null;
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

export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (name === "list_ontologies") {
    return { payload: { ontologies: await listOntologySummaries() }, evidence: [] };
  }
  if (!findMcpTool(name)) throw new Error(`没有叫「${name}」的工具。先调 tools/list 看可用工具。`);
  const { ontology_id: ontologyId, ...rest } = args;
  const context = await contextFor(typeof ontologyId === "string" ? ontologyId : "");
  return runReasoningTool(name, rest, context);
}
