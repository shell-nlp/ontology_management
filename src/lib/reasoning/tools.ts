import { jsonSchema, tool } from "ai";
import { mergeInheritedProperties } from "@/lib/class-hierarchy";
import type { DataSourceRecord } from "@/lib/data-source/types";
import { entitySources, sourceRoleLabel } from "@/lib/ontology-sources";
import { readOnlyPolicyNote } from "@/lib/data-source/sql-guard";
import type { EntityRecord, GraphStore, RuntimeTypeSet } from "@/lib/graph/types";
import type { OntologyDefinition } from "@/lib/ontology";
import type { ToolOutcome, ToolSpec } from "@/lib/reasoning/types";

/**
 * 本体工具集：模型能调用的全部动作都在这里，且每个都只读、确定性、
 * 只依赖「已发布本体 + 图库」。模型负责规划，工具负责事实。
 *
 * 保持只读是有意的：让模型直接写图库风险太大（它可能编造对象 id）。
 * 写入留给动作引擎走既有流程，这里只告诉模型"有哪些动作可以执行"。
 */

export type ToolContext = {
  store: GraphStore;
  definition: OntologyDefinition;
  /** 运行时类型统计，给模型一个"这个类有多少对象"的量级直觉。 */
  runtimeTypes: RuntimeTypeSet | null;
  /**
   * 本机已登记的数据资源。
   *
   * 对象类型可以绑到表上（`entityTypes[].sources`），但绑定里存的是**数据资源的 id**，
   * 模型看 UUID 没有意义 —— 拿它把「绑了哪张表、在哪个资源上」翻成可读文本。
   */
  dataSources?: DataSourceRecord[];
  /**
   * 单个工具返回给模型的字符上限（「问答配置」里的「工具结果上限」）。
   * 不填 = 不限制：原样交给模型，不截断。
   */
  toolResultLimit?: number;
  /**
   * 数据资源查询一次最多取多少行（「问答配置」里的「取数行数上限」）。
   * 不填 = 用工具自己的兜底上限。
   */
  sqlRowLimit?: number;
};

type ConceptKind = "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "PROPERTY";

export type SchemaConcept = {
  kind: ConceptKind;
  name: string;
  haystack: string;
  detail: string;
  /** 对象类型的实例数 / 关系类型的条数，用于无命中时的兜底排序。 */
  weight: number;
};

export type SchemaMatch = {
  kind: ConceptKind;
  name: string;
  score: number;
  reason: string;
  detail: string;
};

/** 「取数行数上限」留空时的兜底：一次最多取这么多行，防止一条语句把内存拉爆。 */
const SQL_ROW_CEILING = 5000;

export const REASONING_TOOLS: ToolSpec[] = [
  {
    name: "search_schema",
    description:
      "在已发布本体里按自然语言检索对象类型、关系类型、动作与属性。任何问题都先调它，用来确认业务里到底有哪些概念、叫什么名字。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "用户问题或关键词，原样传进来即可" },
        max_concepts: { type: "integer", description: "最多返回多少个候选，默认 8，上限 30" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_object_type",
    description:
      "读取一个对象类型的完整定义：属性（含从父类继承来的，映射到哪一列也会带上）、父类、参与的关系类型、可执行的动作、绑定的数据来源（哪张表 / 视图、主键、标题列、在哪个数据资源上）。问「某个对象类型绑了哪张表」时调它。",
    parameters: {
      type: "object",
      properties: { type_name: { type: "string", description: "对象类型名称，必须来自 search_schema 的结果" } },
      required: ["type_name"],
    },
  },
  {
    name: "list_concept_groups",
    description:
      "列出本体里的**概念分组**（业务域），以及每个分组下有哪些对象类型。问「有哪些概念分组」「某个分组里有什么对象类型」时调它；还没归组的对象类型会单独列出来。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_table_ddl",
    description:
      "看一张表 / 视图的结构，返回 DDL：列、类型、可空、主键、注释。data_source 用数据资源名（见概念清单后面的数据资源），table 是表或视图名。要跑数之前先用它确认字段。",
    parameters: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "数据资源名称，例如「Oracle 测试 1251」" },
        table: { type: "string", description: "表或视图名，大小写不敏感" },
      },
      required: ["data_source", "table"],
    },
  },
  {
    name: "run_sql",
    description:
      "在数据资源上执行**只读** SQL 查询（SELECT / WITH / SHOW / EXPLAIN），用来核对对象类型绑定的表里到底是什么数据。写操作（INSERT / UPDATE / DELETE / DROP 等）和多语句会被直接拒绝；结果默认最多 50 行。写查询前先用 get_table_ddl 确认字段名。",
    parameters: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "数据资源名称，例如「Oracle 测试 1251」" },
        sql: { type: "string", description: "一条只读的 SQL 语句" },
        limit: { type: "integer", description: "返回行数上限，默认 50" },
      },
      required: ["data_source", "sql"],
    },
  },
  /*
   * 两个实例工具标记成 disabled：这一版只在对象类型 / 关系类型这一层推理，不查具体对象与数据行
   * （2026-09-14 决定）。它们不会进模型的工具集、也不进 MCP 的 tools/list，
   * 只留在目录里，让「MCP 调试」页把它们灰着显示出来 —— 看得见"有这么两个工具，暂时不用"。
   * 要恢复：去掉 disabled。
   */
  {
    name: "query_object_instance",
    disabled: true,
    description:
      "按对象类型查询真实实例。传父类型时子类型的实例也会一起返回（类型传播）。返回的 _instance_identity.object_id 是真实标识，后续只能用返回过的 id。",
    parameters: {
      type: "object",
      properties: {
        type_name: { type: "string", description: "对象类型名称" },
        search: { type: "string", description: "可选，按显示名称/属性做关键词过滤" },
        limit: { type: "integer", description: "返回条数，默认 20，上限 50" },
      },
      required: ["type_name"],
    },
  },
  {
    name: "query_instance_subgraph",
    disabled: true,
    description: "按对象类型与关系类型取一张子图，返回节点与关系。用于回答「A 和 B 之间怎么连」这类问题。",
    parameters: {
      type: "object",
      properties: {
        type_names: { type: "array", items: { type: "string" }, description: "要包含的对象类型名称" },
        relationship_types: { type: "array", items: { type: "string" }, description: "可选，只看这几类关系" },
        search: { type: "string", description: "可选，关键词过滤" },
        node_limit: { type: "integer", description: "节点上限，默认 60，上限 200" },
      },
    },
  },
  {
    name: "list_actions",
    description: "列出本体里定义的动作（含作用对象类型、入参、写入了哪些属性），以及挂在动作上的规则。",
    parameters: {
      type: "object",
      properties: { type_name: { type: "string", description: "可选，只看作用在这个对象类型上的动作" } },
    },
  },
];

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** 中文没有空格，所以除了按标点切词，还要把每个词展开成 2 元组。 */
export function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    tokens.add(token);
    if (/[\u4e00-\u9fff]/.test(token)) {
      for (let i = 0; i + 2 <= token.length; i += 1) tokens.add(token.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/** 最长公共子串长度：中文按 2 元组匹配，短查询也能给出有意义的分数。 */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const current = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (previous[j] > best) best = previous[j];
      diagonal = current;
    }
  }
  return best;
}

export function schemaConcepts(definition: OntologyDefinition, runtimeTypes: RuntimeTypeSet | null, dataSources: DataSourceRecord[] = []): SchemaConcept[] {
  const resourceNameById = new Map(dataSources.map((item) => [item.id, item.name]));
  /*
   * 对象数只用来给"完全没命中时的兜底排序"加一点权重，**不进给模型看的文案**：
   * 这一层不推理实例，就不该让模型看到实例层面的数字（否则它会据此下实例结论）。
   */
  const objectCount = new Map((runtimeTypes?.labels ?? []).map((item) => [item.name, item.count]));
  const relationshipCount = new Map((runtimeTypes?.relationshipTypes ?? []).map((item) => [item.name, item.count]));
  const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
  const groupNameById = new Map((definition.groups ?? []).map((item) => [item.id, item.name]));
  const concepts: SchemaConcept[] = [];

  for (const entity of definition.entityTypes) {
    const parents = (entity.parents ?? []).map((id) => typeNameById.get(id)).filter((name): name is string => Boolean(name));
    const properties = mergeInheritedProperties(entity, definition.entityTypes);
    const group = groupNameById.get(entity.groupId ?? "") ?? "";
    // 绑定的表名也进检索面：问"某类在哪个表里"时，靠表名本身也能命中。
    const tables = entitySources(entity).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const resources = [...new Set(entitySources(entity).map((source) => resourceNameById.get(source.dataSourceId) ?? "").filter(Boolean))];
    concepts.push({
      kind: "OBJECT_TYPE",
      name: entity.name,
      // 概念分组也进检索面：问「客户域里有什么」时，该组的成员会被搜出来。
      haystack: normalize([entity.name, entity.description, group, ...parents, ...tables, ...properties.map((property) => property.name)].join(" ")),
      detail: [
        group ? `分组 ${group}` : "",
        parents.length ? `父类 ${parents.join("、")}` : "",
        tables.length ? `绑定 ${tables.join("、")}${resources.length ? `（${resources.join("、")}）` : ""}` : "",
        properties.length ? `属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
      ].filter(Boolean).join("；"),
      weight: objectCount.get(entity.name) ?? 0,
    });
    for (const property of properties) {
      concepts.push({
        kind: "PROPERTY",
        name: `${entity.name}.${property.name}`,
        haystack: normalize(`${entity.name} ${property.name} ${property.dataType}`),
        detail: `${property.dataType}${property.required ? "，必填" : ""}`,
        weight: 0,
      });
    }
  }

  for (const relationship of definition.relationshipTypes) {
    const source = typeNameById.get(relationship.sourceEntityTypeId) ?? "";
    const target = typeNameById.get(relationship.targetEntityTypeId) ?? "";
    concepts.push({
      kind: "RELATION_TYPE",
      name: relationship.name,
      haystack: normalize([relationship.name, source, target].join(" ")),
      detail: `${source || "未指定"} → ${target || "未指定"}`,
      weight: relationshipCount.get(relationship.name) ?? 0,
    });
  }

  for (const action of definition.actionTypes) {
    const scope = typeNameById.get(action.scopeEntityTypeId) ?? "";
    concepts.push({
      kind: "ACTION",
      name: action.name,
      haystack: normalize([action.name, action.code, action.description, scope, ...action.params.map((param) => param.name)].join(" ")),
      detail: `作用于 ${scope || "未指定"}；入参 ${action.params.map((param) => param.name).join("、") || "无"}`,
      weight: 0,
    });
  }

  return concepts;
}

/**
 * 排序规则刻意可解释：先看名字对不对得上，再看描述/属性里有没有提到，
 * 全都没命中时按实例数量兜底 —— 至少让模型知道这个本体里最"重"的概念是什么。
 */
export function rankSchemaConcepts(concepts: readonly SchemaConcept[], query: string, maxConcepts: number): SchemaMatch[] {
  const needle = normalize(query);
  const tokens = queryTokens(query);
  const scored = concepts.map((concept) => {
    const name = normalize(concept.name);
    let score = 0;
    let reason = "";
    if (needle && name === needle) { score = 100; reason = "名称完全一致"; }
    else if (needle && (name.includes(needle) || needle.includes(name))) { score = 70; reason = "名称包含查询词"; }
    else {
      const common = needle ? longestCommonSubstring(needle, name) : 0;
      if (common >= 2) { score = 20 + common * 6; reason = `名称与查询词有 ${common} 个字重合`; }
    }
    const tokenHits = tokens.filter((token) => token.length >= 2 && concept.haystack.includes(token));
    if (tokenHits.length) {
      score += tokenHits.length * 8;
      if (!reason) reason = `描述/属性命中：${tokenHits.slice(0, 3).join("、")}`;
    }
    return { concept, score: score + Math.min(10, concept.weight), reason };
  });

  const matched = scored.filter((item) => item.score > 0);
  /*
   * 都没命中时兜底给一批概念，而不是空手而归 —— 注意这里**不再按"有实例的才有资格"筛**：
   * 一个刚建好、图库还是空的本体，那样会一条都返回不了。weight 只影响排序，不影响有没有。
   */
  const pool = matched.length ? matched : scored;
  return pool
    .sort((a, b) => b.score - a.score || a.concept.name.localeCompare(b.concept.name, "zh-CN"))
    .slice(0, maxConcepts)
    .map((item) => ({
      kind: item.concept.kind,
      name: item.concept.name,
      score: item.score,
      reason: item.reason || "没命中关键词，按本体概念清单兜底推荐",
      detail: item.concept.detail,
    }));
}

function titleOf(definition: OntologyDefinition, node: EntityRecord) {
  const type = definition.entityTypes.find((item) => node.labels.includes(item.name));
  const display = type?.displayProperty?.trim();
  if (display && node.properties[display] != null) return String(node.properties[display]);
  for (const key of ["名称", "name", "title", "编号"]) {
    if (node.properties[key] != null) return String(node.properties[key]);
  }
  return node.id.slice(0, 8);
}

function identityOf(definition: OntologyDefinition, node: EntityRecord) {
  const objectType = node.labels.find((label) => definition.entityTypes.some((item) => item.name === label)) ?? node.labels[0] ?? "";
  return { object_type: objectType, object_id: node.id, title: titleOf(definition, node) };
}

/** 属性里的布局信息（fx/fy）对推理没有意义，去掉能省不少 token。 */
function businessProperties(node: EntityRecord) {
  return Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
}

function clamp(value: unknown, fallback: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(max, Math.floor(numeric));
}

/**
 * 按名字（或 id）找一条数据资源。
 *
 * 报错时把当前登记的资源名列出来 —— 模型可以据此自己改对参数，而不是卡在这里猜。
 */
function resolveDataSource(context: ToolContext, name: string) {
  const sources = context.dataSources ?? [];
  const available = sources.map((item) => `「${item.name}」`).join("、") || "（一个都没登记）";
  const key = name.trim().toLowerCase();
  if (!key) throw new Error(`data_source 不能为空。当前登记的数据资源有：${available}。`);
  const hit = sources.find((item) => item.name.toLowerCase() === key || item.id.toLowerCase() === key);
  if (!hit) throw new Error(`没有叫「${name}」的数据资源。当前登记的数据资源有：${available}。`);
  if (!hit.enabled) throw new Error(`数据资源「${hit.name}」已经停用，先到「数据资源」页启用它。`);
  return hit;
}

/**
 * 把这批工具包成 AI SDK 的 ToolSet，交给 ToolLoopAgent。
 *
 * 证据（每一步引用了哪些真实对象）不在工具的返回值里 —— 那会把给模型看的内容撑大。
 * 改成执行时按 toolCallId 记到旁边，由 agent 在流里读到 `tool-result` 时取回。
 */
export function reasoningToolSet(
  context: ToolContext,
  onEvidence: (toolCallId: string, evidence: ToolOutcome["evidence"]) => void,
) {
  const build = (spec: ToolSpec) => tool({
    description: spec.description,
    inputSchema: jsonSchema(spec.parameters),
    execute: async (input: unknown, { toolCallId }: { toolCallId: string }) => {
      const outcome = await runReasoningTool(spec.name, (input ?? {}) as Record<string, unknown>, context);
      onEvidence(toolCallId, outcome.evidence);
      // 不设上限时原样返回；设了才截断 —— 截断必须在这里做，因为 execute 的返回值就是模型看到的东西。
      // 超长时给一个明确说"被截断"的对象，而不是喂半截 JSON —— 后者会让模型当成完整数据。
      const limit = context.toolResultLimit;
      if (!limit) return outcome.payload;
      const text = JSON.stringify(outcome.payload);
      if (text.length <= limit) return outcome.payload;
      return {
        truncated: true,
        note: `结果过长已截断（原 ${text.length} 字符，上限 ${limit}）。请用更精确的条件或更小的 limit 重新查询，不要把它当成完整数据。`,
        preview: text.slice(0, limit),
      };
    },
  });
  // 标记为 disabled 的工具不进模型能看到的那份工具集（MCP 调试页里仍然灰着列出来）。
  return Object.fromEntries(REASONING_TOOLS.filter((spec) => !spec.disabled).map((spec) => [spec.name, build(spec)]));
}

export async function runReasoningTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const { definition, store, runtimeTypes } = context;
  switch (name) {
    case "search_schema": {
      const query = typeof args.query === "string" ? args.query : "";
      const maxConcepts = clamp(args.max_concepts, 8, 30);
      const matches = rankSchemaConcepts(schemaConcepts(definition, runtimeTypes, context.dataSources ?? []), query, maxConcepts);
      return {
        payload: {
          query,
          matches,
          hint: matches.length
            ? "这些名字是本体里的真实定义，后续查询只能用它们。要字段级细节就调 get_object_type。"
            : "没有命中任何概念，换一个说法或先用更宽的关键词再试。",
        },
        // 属性不是可寻址的实体，不做证据；类型与动作才是。
        evidence: matches
          .filter((match) => match.kind !== "PROPERTY")
          .map((match) => ({ kind: match.kind as "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION", id: match.name, label: match.name })),
      };
    }

    case "get_object_type": {
      const typeName = String(args.type_name ?? "");
      const type = definition.entityTypes.find((item) => item.name === typeName);
      if (!type) throw new Error(`本体里没有对象类型「${typeName}」。先用 search_schema 确认名字。`);
      const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      const own = new Set(type.properties.map((property) => property.name));
      /*
       * 数据来源绑定里存的是数据资源的 id 与来源 id（都是 UUID），模型看不懂。
       * 这里把两份 id 翻成「哪个资源、哪张表、第几份来源」——否则模型只能凭空说
       * “这个对象类型没有绑定数据源”，这正是它明明绑了表却答不出来的原因。
       */
      const sources = entitySources(type);
      const group = (definition.groups ?? []).find((item) => item.id === (type.groupId ?? "")) ?? null;
      const resourceNameById = new Map((context.dataSources ?? []).map((item) => [item.id, item.name]));
      const sourceRoleById = new Map(sources.map((source, index) => [source.id, sourceRoleLabel(index)]));
      const properties = mergeInheritedProperties(type, definition.entityTypes).map((property) => ({
        name: property.name,
        display_name: property.displayName ?? "",
        description: property.description ?? "",
        data_type: property.dataType,
        required: property.required,
        unique: property.unique,
        inherited: !own.has(property.name),
        // 属性取自源表的哪一列、哪一份来源；没映射就是空串。
        source_field: property.sourceField ?? "",
        // 只有映射了列才有来源角色可谈；继承来又没映射列的属性不硬套一个。
        source_role: property.sourceField ? (property.sourceId ? sourceRoleById.get(property.sourceId) ?? "" : sources.length ? sourceRoleLabel(0) : "") : "",
      }));
      const relations = definition.relationshipTypes
        .filter((item) => item.sourceEntityTypeId === type.id || item.targetEntityTypeId === type.id)
        .map((item) => ({
          name: item.name,
          direction: item.sourceEntityTypeId === type.id ? "OUT" : "IN",
          other: typeNameById.get(item.sourceEntityTypeId === type.id ? item.targetEntityTypeId : item.sourceEntityTypeId) ?? "",
        }));
      const actions = definition.actionTypes
        .filter((item) => item.scopeEntityTypeId === type.id)
        .map((item) => ({ name: item.name, code: item.code, params: item.params.map((param) => `${param.name}:${param.dataType}`) }));
      return {
        payload: {
          name: type.name,
          description: type.description,
          // 概念分组：模型答"它属于哪个域"靠这一项。
          group: group?.name ?? "",
          parents: (type.parents ?? []).map((id) => typeNameById.get(id)).filter(Boolean),
          properties,
          relations,
          actions,
          sources: sources.map((source, index) => ({
            role: sourceRoleLabel(index),
            data_source: resourceNameById.get(source.dataSourceId) ?? "",
            schema: source.schema,
            view: source.view,
            primary_key: source.primaryKey,
            title_field: source.titleField,
          })),
          // 一句话点明对象与来源的关系，省得模型把“绑了表”说成“没有数据”。
          data_source_note: sources.length
            ? "对象是这个对象类型绑定的表 / 视图里的一行；sources 就是它的数据来源，属性上的 source_field 是它在源表里的列名。要看真实数据，就拿这里的表名去 get_table_ddl / run_sql。"
            : "这个对象类型还没有绑定数据资源，本体里只有定义。",
          display_property: type.displayProperty ?? "",
        },
        evidence: [{ kind: "OBJECT_TYPE", id: type.name, label: type.name }],
      };
    }

    case "list_concept_groups": {
      const groups = definition.groups ?? [];
      const known = new Set(groups.map((group) => group.id));
      const members = new Map<string, string[]>();
      const ungrouped: string[] = [];
      for (const entity of definition.entityTypes) {
        const groupId = entity.groupId ?? "";
        if (!groupId || !known.has(groupId)) { ungrouped.push(entity.name); continue; }
        const bucket = members.get(groupId);
        if (bucket) bucket.push(entity.name);
        else members.set(groupId, [entity.name]);
      }
      return {
        payload: {
          group_count: groups.length,
          groups: groups.map((group) => ({
            name: group.name,
            object_types: members.get(group.id) ?? [],
            object_type_count: (members.get(group.id) ?? []).length,
          })),
          // 空分组也照样列出来（object_types 是空数组）——"建了组还没归类型"本身是要说清楚的状态。
          ...(ungrouped.length ? { ungrouped_object_types: ungrouped } : {}),
          note: "概念分组只是展示与检索用的归类，不影响对象类型的定义；要细节就用 get_object_type 看某一个类型。",
        },
        evidence: groups.map((group) => ({ kind: "GROUP" as const, id: group.id, label: group.name })),
      };
    }

    case "get_table_ddl": {
      const record = resolveDataSource(context, String(args.data_source ?? ""));
      const table = String(args.table ?? "").trim();
      if (!table) throw new Error("table 不能为空。");
      const { openDataSource } = await import("@/lib/data-sources");
      const connector = await openDataSource(record);
      if (!connector.describeTableDdl) throw new Error(`数据资源「${record.name}」是 ${record.kind}，不支持查看表结构。`);
      const ddl = await connector.describeTableDdl({ name: table, schema: record.schema_name || undefined });
      return {
        payload: {
          data_source: record.name,
          data_source_kind: record.kind,
          schema: ddl.schema,
          table: ddl.name,
          object_kind: ddl.kind,
          ddl_source: ddl.source,
          ddl: ddl.ddl,
          notes: ddl.notes,
          ...(ddl.truncatedAt ? { truncated_at: ddl.truncatedAt, truncated_note: `原始语句超过 ${ddl.truncatedAt} 字符，上面是截断后的。` } : {}),
        },
        // 表结构不是可寻址的本体实体，不做证据。
        evidence: [],
      };
    }

    case "run_sql": {
      const record = resolveDataSource(context, String(args.data_source ?? ""));
      const sql = String(args.sql ?? "");
      if (!sql.trim()) throw new Error("sql 不能为空。");
      // 模型自己给的行数；「问答配置」里设了取数上限就再夹一道，没设就用兜底上限。
      const ceiling = context.sqlRowLimit ?? SQL_ROW_CEILING;
      const limit = Math.min(clamp(args.limit, 50, SQL_ROW_CEILING), ceiling);
      const { openDataSource } = await import("@/lib/data-sources");
      const connector = await openDataSource(record);
      if (!connector.runReadOnlyQuery) throw new Error(`数据资源「${record.name}」是 ${record.kind}，不支持 SQL 查询。`);
      const result = await connector.runReadOnlyQuery(sql, { limit });
      return {
        payload: {
          data_source: record.name,
          data_source_kind: record.kind,
          schema: record.schema_name || "",
          statement: result.statement,
          returned: result.rows.length,
          row_limit: result.rowLimit,
          columns: result.columns,
          rows: result.rows,
          truncated: result.truncated,
          note: readOnlyPolicyNote(record.kind),
          // 只读事务起没起得来要如实报：起不来时只剩语句检查在挡，不能让人以为库里有保险。
          read_only_transaction: result.readOnlyTransaction,
          ...(result.readOnlyTransaction ? {} : { warning: "这个驱动起不了只读事务，本次只有语句检查在挡，请只读使用。" }),
        },
        // 查询出来的行不是本体里的对象，不能当"证据"引用；要引用对象请走本体那边。
        evidence: [],
      };
    }

    /*
     * 下面两个分支是**实例工具**的实现。它们在 REASONING_TOOLS 里被标成 disabled
     * （这一版只在对象类型 / 关系类型这一层推理），所以现在走不到 —— 模型看不到、
     * MCP 那边也会先被 findMcpTool 挡掉。留着是为了将来放回来时不用重写。
     */
    case "query_object_instance": {
      const typeName = String(args.type_name ?? "");
      if (!typeName) throw new Error("type_name 不能为空。");
      if (!definition.entityTypes.some((item) => item.name === typeName)) throw new Error(`本体里没有对象类型「${typeName}」。`);
      const limit = clamp(args.limit, 20, 50);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : null;
      // 传父类型时子类的实例也会回来，这是发布时写进图库的 rdfs:subClassOf 在起作用。
      const nodes = await store.listEntities({ label: typeName, search, limit });
      const instances = nodes.slice(0, limit).map((node) => ({ _instance_identity: identityOf(definition, node), labels: node.labels, properties: businessProperties(node) }));
      return {
        payload: {
          object_type: typeName,
          returned: instances.length,
          instances,
          note: "子类型的实例也会出现在结果里，看 labels 区分具体类型。回答时只引用上面出现过的 object_id。",
        },
        evidence: instances.map((item) => ({ kind: "OBJECT" as const, id: item._instance_identity.object_id, label: item._instance_identity.title })),
      };
    }

    case "query_instance_subgraph": {
      const typeNames = Array.isArray(args.type_names) ? args.type_names.map(String) : [];
      const relationshipTypes = Array.isArray(args.relationship_types) ? args.relationship_types.map(String) : [];
      const nodeLimit = clamp(args.node_limit, 60, 200);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : null;
      const graph = await store.readGraph({ labels: typeNames, relationshipTypes, search, nodeLimit });
      const nodes = graph.nodes.slice(0, nodeLimit).map((node) => ({ _instance_identity: identityOf(definition, node), labels: node.labels, properties: businessProperties(node) }));
      return {
        payload: {
          node_count: nodes.length,
          relationship_count: graph.relationships.length,
          nodes,
          relationships: graph.relationships.map((relationship) => ({
            _instance_identity: { relationship_id: relationship.id, type: relationship.type },
            source_id: relationship.source,
            target_id: relationship.target,
          })),
        },
        evidence: [
          ...nodes.map((node) => ({ kind: "OBJECT" as const, id: node._instance_identity.object_id, label: node._instance_identity.title })),
          ...graph.relationships.map((relationship) => ({ kind: "RELATIONSHIP" as const, id: relationship.id, label: relationship.type })),
        ],
      };
    }

    case "list_actions": {
      const typeName = typeof args.type_name === "string" && args.type_name.trim() ? args.type_name.trim() : null;
      const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      const actions = definition.actionTypes
        .filter((item) => !typeName || typeNameById.get(item.scopeEntityTypeId) === typeName)
        .map((item) => ({
          id: item.id,
          name: item.name,
          code: item.code,
          scope_object_type: typeNameById.get(item.scopeEntityTypeId) ?? "",
          description: item.description,
          params: item.params.map((param) => ({ name: param.name, data_type: param.dataType, required: param.required })),
          edits: item.edits.map((edit) => ({
            op: edit.op,
            entity_type: typeNameById.get(edit.entityTypeId) ?? "",
            relationship_type: definition.relationshipTypes.find((item2) => item2.id === edit.relationshipTypeId)?.name ?? "",
            alias: edit.alias,
            assignments: edit.assignments.map((assignment) => `${assignment.property}=${assignment.value.value}`),
          })),
          rules: definition.rules.filter((rule) => rule.actionId === item.id || !rule.actionId).map((rule) => ({ name: rule.name, effect: rule.effect, message: rule.message })),
        }));
      return {
        payload: {
          actions,
          note: "这些是本体里已定义的动作。本次推理是只读的，不会真的执行动作；要执行请到「动作」页由人确认后运行。",
        },
        evidence: actions.map((action) => ({ kind: "ACTION" as const, id: action.id, label: action.name })),
      };
    }

    default:
      throw new Error(`没有叫「${name}」的工具。`);
  }
}
