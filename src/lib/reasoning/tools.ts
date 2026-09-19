import { jsonSchema, tool } from "ai";
import {
  checkImplementations,
  effectiveInterfaceLinkConstraints,
  effectiveInterfaceActionConstraints,
  effectiveInterfaceProperties,
  implementsIdsOf,
  implementersOf,
  interfaceAncestorsOf,
} from "@/lib/interfaces";
import type { DataSourceRecord } from "@/lib/data-source/types";
import { entitySources, sourceRoleLabel } from "@/lib/ontology-sources";
import { keyMappingLabel, keyMappingRows } from "@/lib/relationship-keys";
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

type ConceptKind = "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "PROPERTY" | "INTERFACE";

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

/**
 * run_sql 自己的默认行数（模型不传 limit 时用它）。
 * 与连接器的 `DEFAULT_QUERY_ROWS` 保持一致：**默认 100 行**，
 * 超过就靠多取一行判出来，返回里标 `truncated: true` 并附一段人话提示。
 */
const DEFAULT_SQL_ROWS = 100;

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
      "读取一个对象类型的完整定义：属性（映射到哪一列也会带上）、实现了哪些接口、参与的关系类型、可执行的动作、绑定的数据来源（哪张表 / 视图、主键、标题列、在哪个数据资源上）。问「某个对象类型绑了哪张表」时调它。",
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
    name: "list_interfaces",
    description:
      "列出本体里的**接口**（抽象契约）以及每个接口的实现情况：接口属性、继承的接口、关系约束、哪些对象类型实现了它。问「有哪些接口」「这个接口谁实现了」时调它；「这个对象类型实现了哪些接口」在 get_object_type 里也能看到。",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "traverse_object_types",
    description:
      "从对象类型出发沿关系类型走 1~5 跳，返回沿途的对象类型与关系类型。问「这个对象类型一圈都连着谁」「隔两跳能到哪些类型」「A 和 B 之间怎么连」时用它。关系类型是**双向**的（一条关系类型两侧都能走，不用另建反向关系），所以默认两个方向都算连通；要只往外或只往回，用 direction 收窄。hops 默认 3、上限 5；object_types / relationship_types 把范围限死在指定的类型上（不填就是不限定）；start_type 留空表示从本体的全部对象类型出发。只看一层的关系类型与属性定义用 get_object_type。",
    parameters: {
      type: "object",
      properties: {
        start_type: { type: "string", description: "起点对象类型名称；留空 = 从全部对象类型出发" },
        hops: { type: "integer", description: "最多走几跳，默认 3，上限 5" },
        object_types: { type: "array", items: { type: "string" }, description: "只走（并只落到）这些对象类型；不填 = 不限定" },
        relationship_types: { type: "array", items: { type: "string" }, description: "只沿这些关系类型走；不填 = 不限定" },
        direction: { type: "string", enum: ["both", "forward", "backward"], description: "遍历方向：both（默认，两个方向都走）、forward（只沿「起点→终点」）、backward（只沿「终点→起点」）" },
      },
    },
  },
  {
    name: "get_table_ddl",
    description:
      "看一张表 / 视图的结构，返回 DDL：列、类型、可空、主键、注释。data_source 用数据资源名（见概念清单后面的数据资源）。table 写全「模式.表」，例如 GISTOOLS.TB_DIC_AREA_CODE（对象类型绑定的表就是这么写的）；只写表名也认，模式退回数据资源登记的那个。要跑数之前先用它确认字段。",
    parameters: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "数据资源名称，例如「Oracle 测试 1251」" },
        table: { type: "string", description: "表或视图名，写全「模式.表」（如 GISTOOLS.TB_DIC_AREA_CODE）；大小写不敏感" },
      },
      required: ["data_source", "table"],
    },
  },
  {
    name: "run_sql",
    description:
      "在数据资源上执行**只读** SQL 查询（SELECT / WITH / SHOW / EXPLAIN），用来核对对象类型绑定的表里到底是什么数据。SQL 里的表名同样写全「模式.表」（如 SELECT * FROM GISTOOLS.TB_DIC_AREA_CODE），别依赖连接用户的默认模式。写操作（INSERT / UPDATE / DELETE / DROP 等）和多语句会被直接拒绝；**默认最多返回 100 行**，超过就在结果里标 truncated=true 并给出提示（要更多就传 limit，或用更精确的 WHERE / 聚合）。写查询前先用 get_table_ddl 确认字段名。",
    parameters: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "数据资源名称，例如「Oracle 测试 1251」" },
        sql: { type: "string", description: "一条只读的 SQL 语句" },
        limit: { type: "integer", description: "返回行数上限，默认 100（上限 5000）" },
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
      "按对象类型查询真实实例。传接口名时，实现了该接口的类型的实例也会一起返回（接口的类型传播）。返回的 _instance_identity.object_id 是真实标识，后续只能用返回过的 id。",
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
  const interfaceNameById = new Map((definition.interfaces ?? []).map((item) => [item.id, item.name]));
  const concepts: SchemaConcept[] = [];

  for (const entity of definition.entityTypes) {
    const properties = entity.properties;
    const group = groupNameById.get(entity.groupId ?? "") ?? "";
    // 绑定的表名也进检索面：问"某类在哪个表里"时，靠表名本身也能命中。
    const tables = entitySources(entity).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const resources = [...new Set(entitySources(entity).map((source) => resourceNameById.get(source.dataSourceId) ?? "").filter(Boolean))];
    // 实现了哪些接口也进检索面：问「谁实现了设施接口」能直接命中这些对象类型。
    const implemented = (entity.implements ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    concepts.push({
      kind: "OBJECT_TYPE",
      name: entity.name,
      // 概念分组也进检索面：问「客户域里有什么」时，该组的成员会被搜出来。
      haystack: normalize([entity.name, entity.description, group, ...tables, ...properties.map((property) => property.name), ...implemented].join(" ")),
      detail: [
        group ? `分组 ${group}` : "",
        implemented.length ? `实现接口 ${implemented.join("、")}` : "",
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

  // 接口本身也是可检索的概念（问「有哪些接口」「这个接口谁实现了」都要命中）。
  for (const item of definition.interfaces ?? []) {
    const inherited = interfaceAncestorsOf(definition.interfaces ?? [], item.id).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const implementers = definition.entityTypes.filter((entity) => (entity.implements ?? []).includes(item.id)).map((entity) => entity.name);
    const properties = effectiveInterfaceProperties(definition.interfaces ?? [], item.id);
    concepts.push({
      kind: "INTERFACE",
      name: item.name,
      haystack: normalize([item.name, item.description, ...properties.map((property) => property.name), ...implementers, ...inherited].join(" ")),
      detail: [
        "接口（抽象契约，不绑数据、不能直接实例化）",
        inherited.length ? `继承 ${inherited.join("、")}` : "",
        properties.length ? `接口属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
        implementers.length ? `${implementers.length} 个实现：${implementers.join("、")}` : "还没有对象类型实现它",
      ].filter(Boolean).join("；"),
      weight: 0,
    });
  }  for (const relationship of definition.relationshipTypes) {
    const source = typeNameById.get(relationship.sourceEntityTypeId) ?? "";
    const target = typeNameById.get(relationship.targetEntityTypeId) ?? "";
    concepts.push({
      kind: "RELATION_TYPE",
      name: relationship.name,
      haystack: normalize([relationship.name, source, target].join(" ")),
      // 双向关系类型只写一条定义：用 ↔ 表示两个方向都能走，别让人以为反向要再来一条。
      detail: `${source || "未指定"} ↔ ${target || "未指定"}`,
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

/** 多跳查询的默认跳数与上限（用户口径：默认 3，最多 5）。 */
export const DEFAULT_TRAVERSE_HOPS = 3;
export const MAX_TRAVERSE_HOPS = 5;

export type TypeGraphNode = {
  name: string;
  group: string;
  /** 距离起点最近的跳数；起点自己是 0。 */
  hop: number;
  description: string;
  /** 绑定的表（`SCHEMA.TABLE`），没绑就是空数组。 */
  bound_tables: string[];
};

/**
 * 一条边（关系类型）。`from` / `to` 是定义里的起点与终点；两个方向都能走，所以它同时表示反向那条。
 * `via_interface` 只在"这条关系是接口带出来的"时出现 —— 见 `interfaceDerivedLinks`。
 */
export type TypeGraphEdge = { relation: string; from: string; to: string; hop: number; via_interface?: string };

/**
 * 接口带来的关系（Palantir 的 interface link type 语义）：对象类型实现了接口，
 * 接口的每条关系约束就由它落地 —— 实现方必须能走到约束里的对端。
 *
 * 为什么工具也要算这一层：接口的关系约束落在**影子对象类型**身上（提取为接口时原样保留），
 * 实现方自己在 `relationshipTypes` 里一条边都没有。不补这一层，工具会如实回答
 * "集团客户一跳内没有任何关系类型"，模型就只能答"走不到"，而画布上明明连着。
 *
 * 对端写的是"另一个接口"时，取那个接口的实现方（含实现它子接口的对象类型）。
 */
export function interfaceDerivedLinks(definition: OntologyDefinition): { name: string; fromId: string; toId: string; viaInterface: string }[] {
  const interfaces = definition.interfaces ?? [];
  if (!interfaces.length) return [];
  const interfaceNameById = new Map(interfaces.map((item) => [item.id, item.name]));
  const knownEntityIds = new Set(definition.entityTypes.map((item) => item.id));
  const links: { name: string; fromId: string; toId: string; viaInterface: string }[] = [];
  const seen = new Set<string>();
  for (const entity of definition.entityTypes) {
    for (const interfaceId of implementsIdsOf(entity)) {
      // effectiveInterfaceLinkConstraints 已经把继承来的父接口约束算进去了，这里只看这个接口。
      const viaInterface = interfaceNameById.get(interfaceId) ?? "";
      for (const constraint of effectiveInterfaceLinkConstraints(interfaces, interfaceId)) {
        if (!constraint.name) continue;
        const targets = constraint.targetKind === "INTERFACE"
          ? implementersOf(interfaces, definition.entityTypes, constraint.targetId).map((item) => item.id)
          : [constraint.targetId];
        for (const targetId of targets) {
          if (!targetId || targetId === entity.id || !knownEntityIds.has(targetId)) continue;
          const key = `${entity.id}|${constraint.name}|${targetId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ name: constraint.name, fromId: entity.id, toId: targetId, viaInterface });
        }
      }
    }
  }
  return links;
}

/** 遍历方向：`both` 两个方向都走（默认），`forward` 只沿"起点→终点"，`backward` 只沿"终点→起点"。 */
export type TraverseDirection = "both" | "forward" | "backward";

export function parseTraverseDirection(value: unknown): TraverseDirection {
  return value === "forward" || value === "backward" ? value : "both";
}

export type TypeGraphTraversal = {
  hops: number;
  /** 本次实际生效的方向（没传或传了不认识的值就是 `both`）。 */
  direction: TraverseDirection;
  starts: string[];
  nodes: TypeGraphNode[];
  edges: TypeGraphEdge[];
  /** 起点没写对时，这条名字会被原样报回去（不猜）。 */
  unknown_start: string;
  /** object_types / relationship_types 里本体没有的名字。 */
  unknown_names: string[];
  filters: { object_types: string[]; relationship_types: string[] };
};

function describeBriefly(text: string, limit = 80) {
  const value = text.trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/**
 * 对象类型这一层的多跳遍历（纯函数，有单测）。
 *
 * 沿关系类型走：起点是 `start`（留空 = 全部对象类型），最多 `hops` 跳（默认 3、上限 5）。
 * `objectTypes` / `relationshipTypes` 是白名单：给了就只走这些关系类型、只落到这些对象类型上；
 * 不给就是不限定。起点永远包含在结果里，哪怕它自己不在白名单内（否则"从这个类型出发"就说不通了）。
 * `direction` 默认 `both`：关系类型是双向的，两个方向都能走到下一跳；要"只往外"或"只往回"再收紧。
 *
 * `nodes[].hop` 是**最短距离**；`edges` 是这些节点之间**全部**关系的诱导子图，每条边带
 * `hop = 两端里更远的那个的跳数`。这样"隔两跳能到谁"和"这两个类型之间还连着哪几条关系"
 * 一次都能答，而不用模型自己拼路径。
 */
export function traverseTypeGraph(
  definition: OntologyDefinition,
  options: { start?: string; hops?: number; objectTypes?: readonly string[]; relationshipTypes?: readonly string[]; direction?: TraverseDirection } = {},
): TypeGraphTraversal {
  const hops = clamp(options.hops, DEFAULT_TRAVERSE_HOPS, MAX_TRAVERSE_HOPS);
  const direction = options.direction ?? "both";
  const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
  const typeByName = new Map(definition.entityTypes.map((item) => [item.name, item]));
  const groupNameById = new Map((definition.groups ?? []).map((item) => [item.id, item.name]));
  /*
   * 图上能走的"关系"有两个来源：定义里的关系类型，以及**实现接口**带来的那些。
   * 只认前者的话，实现了接口的对象类型会显得孤立 —— 恰好是模型最容易答错的地方。
   */
  const links = [
    ...definition.relationshipTypes.map((item) => ({ name: item.name, fromId: item.sourceEntityTypeId, toId: item.targetEntityTypeId, viaInterface: "" })),
    ...interfaceDerivedLinks(definition),
  ];
  const relationNames = new Set(links.map((item) => item.name));
  const wantedTypes = [...new Set(options.objectTypes ?? [])].filter(Boolean);
  const wantedRelations = [...new Set(options.relationshipTypes ?? [])].filter(Boolean);
  const allowedTypes = new Set(wantedTypes);
  const allowedRelations = new Set(wantedRelations);
  const unknownNames = [...wantedTypes.filter((name) => !typeByName.has(name)), ...wantedRelations.filter((name) => !relationNames.has(name))];

  const startName = (options.start ?? "").trim();
  const unknownStart = startName && !typeByName.has(startName) ? startName : "";
  const starts = unknownStart || !definition.entityTypes.length
    ? []
    : startName
      ? [startName]
      : definition.entityTypes.filter((item) => !allowedTypes.size || allowedTypes.has(item.name)).map((item) => item.name);

  /** 每个节点第一次被走到的跳数；起点是 0。 */
  const hopOf = new Map<string, number>(starts.map((name) => [name, 0]));
  let frontier = [...starts];
  for (let hop = 1; hop <= hops && frontier.length; hop += 1) {
    const next: string[] = [];
    for (const fromName of frontier) {
      const from = typeByName.get(fromName);
      if (!from) continue;
      for (const link of links) {
        if (allowedRelations.size && !allowedRelations.has(link.name)) continue;
        const outgoing = link.fromId === from.id;
        const incoming = link.toId === from.id;
        if (!outgoing && !incoming) continue;
        // 方向开关：关系类型双向，默认两个方向都走；只沿"起点→终点"或只沿"终点→起点"时在这里收窄。
        if (direction === "forward" && !outgoing) continue;
        if (direction === "backward" && !incoming) continue;
        const otherName = typeNameById.get(outgoing ? link.toId : link.fromId);
        // 端点未定义的关系类型不进结果（发布前校验会拦，这里不猜）。
        if (!otherName || hopOf.has(otherName)) continue;
        // 白名单限定的是"能落到哪里"：范围外的类型整支都不展开。
        if (allowedTypes.size && !allowedTypes.has(otherName)) continue;
        hopOf.set(otherName, hop);
        next.push(otherName);
      }
    }
    frontier = next;
  }

  const nodes: TypeGraphNode[] = definition.entityTypes
    .filter((item) => hopOf.has(item.name))
    .map((item) => ({
      name: item.name,
      group: groupNameById.get(item.groupId ?? "") ?? "",
      hop: hopOf.get(item.name) ?? 0,
      description: describeBriefly(item.description ?? ""),
      bound_tables: entitySources(item).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean),
    }));
  const edges: TypeGraphEdge[] = links
    .map((link) => {
      const from = typeNameById.get(link.fromId);
      const to = typeNameById.get(link.toId);
      if (!from || !to) return null;
      const fromHop = hopOf.get(from);
      const toHop = hopOf.get(to);
      if (fromHop === undefined || toHop === undefined) return null;
      if (allowedRelations.size && !allowedRelations.has(link.name)) return null;
      return { relation: link.name, from, to, hop: Math.max(fromHop, toHop), ...(link.viaInterface ? { via_interface: link.viaInterface } : {}) };
    })
    .filter((edge): edge is TypeGraphEdge => edge !== null);

  return { hops, direction, starts, nodes, edges, unknown_start: unknownStart, unknown_names: unknownNames, filters: { object_types: wantedTypes, relationship_types: wantedRelations } };
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
  /** 被用户关掉的工具名（见 reasoning/tool-policy.ts）：关掉的不进模型能看到的那份工具集。 */
  disabledTools: readonly string[] = [],
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
  const off = new Set(disabledTools);
  return Object.fromEntries(REASONING_TOOLS.filter((spec) => !spec.disabled && !off.has(spec.name)).map((spec) => [spec.name, build(spec)]));
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
          .map((match) => ({ kind: match.kind as "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "INTERFACE", id: match.name, label: match.name })),
      };
    }

    case "get_object_type": {
      const typeName = String(args.type_name ?? "");
      const type = definition.entityTypes.find((item) => item.name === typeName);
      if (!type) throw new Error(`本体里没有对象类型「${typeName}」。先用 search_schema 确认名字。`);
      const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      const interfaceNameById = new Map((definition.interfaces ?? []).map((item) => [item.id, item.name]));
      /*
       * 数据来源绑定里存的是数据资源的 id 与来源 id（都是 UUID），模型看不懂。
       * 这里把两份 id 翻成「哪个资源、哪张表、第几份来源」——否则模型只能凭空说
       * “这个对象类型没有绑定数据源”，这正是它明明绑了表却答不出来的原因。
       */
      const sources = entitySources(type);
      const group = (definition.groups ?? []).find((item) => item.id === (type.groupId ?? "")) ?? null;
      const resourceNameById = new Map((context.dataSources ?? []).map((item) => [item.id, item.name]));
      const sourceRoleById = new Map(sources.map((source, index) => [source.id, sourceRoleLabel(index)]));
      const properties = type.properties.map((property) => ({
        name: property.name,
        display_name: property.displayName ?? "",
        description: property.description ?? "",
        data_type: property.dataType,
        required: property.required,
        unique: property.unique,
        // 属性取自源表的哪一列、哪一份来源；没映射就是空串。
        source_field: property.sourceField ?? "",
        // 只有映射了列才有来源角色可谈；没映射列的属性不硬套一个。
        source_role: property.sourceField ? (property.sourceId ? sourceRoleById.get(property.sourceId) ?? "" : sources.length ? sourceRoleLabel(0) : "") : "",
      }));
      const groupNameById = new Map((definition.groups ?? []).map((item) => [item.id, item.name]));
      /** 一跳邻居的简介：名字 + 分组 + 一句话 + 绑的表（模型常接着问"那它呢"）。 */
      const neighbor = (id: string) => {
        const other = definition.entityTypes.find((item) => item.id === id);
        return {
          name: other?.name ?? "",
          group: groupNameById.get(other?.groupId ?? "") ?? "",
          description: describeBriefly(other?.description ?? "", 60),
          bound_tables: other ? entitySources(other).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean) : [],
        };
      };
      const touching = definition.relationshipTypes.filter((item) => item.sourceEntityTypeId === type.id || item.targetEntityTypeId === type.id);
      /*
       * 关系类型的键映射：这条关系在数据上按哪几个字段把两端接起来。
       * 模型答"这两类对象怎么对上"（能不能按客户编号连过去、要不要走连接表）要靠它；
       * 没配的关系类型就不带这一项，免得每条边都挂一串空数组。
       */
      const keyMappingsOf = (relation: (typeof touching)[number]) => {
        const source = keyMappingRows(relation.sourceKeyMappings).map(keyMappingLabel);
        const target = keyMappingRows(relation.targetKeyMappings).map(keyMappingLabel);
        if (!source.length && !target.length) return null;
        return { source, target };
      };
      /*
       * 一跳关系：出边、入边分开列。模型问"A 一圈都连着谁"是最常见的追问，
       * 提前给到就省掉一次遍历；要多跳再走 traverse_object_types（最多 5 跳）。
       */
      const oneHop = {
        outgoing: touching.filter((item) => item.sourceEntityTypeId === type.id).map((item) => { const keyMapping = keyMappingsOf(item); return { relation: item.name, ...neighbor(item.targetEntityTypeId), ...(keyMapping ? { key_mapping: keyMapping } : {}) }; }),
        incoming: touching.filter((item) => item.targetEntityTypeId === type.id).map((item) => { const keyMapping = keyMappingsOf(item); return { relation: item.name, ...neighbor(item.sourceEntityTypeId), ...(keyMapping ? { key_mapping: keyMapping } : {}) }; }),
        /*
         * 接口带来的关系：实现接口就承接接口的关系约束（Palantir 语义），
         * 所以"实现方一跳能到谁"必须把它算进来 —— 否则实现方看着像孤立的类型。
         */
        via_interfaces: interfaceDerivedLinks(definition)
          .filter((link) => link.fromId === type.id || link.toId === type.id)
          .map((link) => ({ relation: link.name, via_interface: link.viaInterface, ...neighbor(link.fromId === type.id ? link.toId : link.fromId) })),
        note: "这里只列一跳，两个方向都列（关系类型是双向的，不用另建反向关系）。via_interfaces 是这个对象类型**实现接口**拿到的关系：接口的关系约束由实现方落地，对端就是约束里那个对象类型，回答连通性时要算上。key_mapping 是这条关系类型声明过的键映射（连接属性 → 该端对象类型的属性，`外键 X` 表示连接键长在对象类型上），它说明两类对象在数据上按哪几个字段对得上；没配的关系类型不带这一项，那只是还没填，不代表连不上。看两跳及以上用 traverse_object_types（最多 5 跳，可限定对象类型、关系类型与方向）。",
      };
      const actions = definition.actionTypes
        .filter((item) => item.scopeEntityTypeId === type.id)
        .map((item) => ({ name: item.name, code: item.code, params: item.params.map((param) => `${param.name}:${param.dataType}`) }));
      /*
       * 被提取成接口的对象类型仍然留在定义里（影子），名字和接口**同名**。
       * 不点破这一点，模型会把"对象类型客户"和"接口客户"当成两个不相干的同名概念。
       */
      const promotedInterface = (definition.interfaces ?? []).find((item) => item.promotedFromEntityTypeId === type.id) ?? null;
      return {
        payload: {
          name: type.name,
          description: type.description,
          // 概念分组：模型答"它属于哪个域"靠这一项。
          group: group?.name ?? "",
          // 实现了哪些接口：模型答"这个类型能不能当某某接口用"靠这一项。
          implements: (type.implements ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean),
          properties,
          one_hop: oneHop,
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
            ? "对象是这个对象类型绑定的表 / 视图里的一行；sources 就是它的数据来源，属性上的 source_field 是它在源表里的列名。要看真实数据就调 get_table_ddl / run_sql，表名把 schema 与 view 拼成「模式.表」（例如 GISTOOLS.TB_DIC_AREA_CODE）。"
            : "这个对象类型还没有绑定数据资源，本体里只有定义。",
          // 实现的接口：Palantir 里对象类型靠接口被通用地消费，模型要能顺着接口理解它。
          interfaces: implementsIdsOf(type).map((interfaceId) => {
            const node = (definition.interfaces ?? []).find((item) => item.id === interfaceId) ?? null;
            const check = checkImplementations(type, definition.interfaces ?? [], definition.relationshipTypes, definition.entityTypes, definition.actionTypes)
              .find((item) => item.interfaceId === interfaceId) ?? null;
            return {
              name: node?.name ?? "",
              description: describeBriefly(node?.description ?? "", 80),
              extends: interfaceAncestorsOf(definition.interfaces ?? [], interfaceId)
                .map((id) => (definition.interfaces ?? []).find((item) => item.id === id)?.name ?? "")
                .filter(Boolean),
              properties: node
                ? effectiveInterfaceProperties(definition.interfaces ?? [], interfaceId).map((property) => ({
                  name: property.name,
                  display_name: property.displayName ?? "",
                  data_type: property.dataType,
                  required: property.required !== false,
                  mapped: !(check?.missingProperties ?? []).includes(property.name),
                  // 落到了实现方的哪个属性上：显式映射优先，没写就是同名。
                  mapped_from: check?.propertyMappings.find((item) => item.name === property.name)?.entityProperty ?? "",
                }))
                : [],
              missing_properties: check?.missingProperties ?? [],
              missing_links: (check?.missingLinks ?? []).map((item) => item.name),
              // 动作约束：接口要求的那件事，实现方映射到了哪条动作；没映射就在这里报出来。
              action_constraints: (check?.actionMappings ?? []).map((item) => ({
                name: item.name,
                required: item.required,
                action: item.actionTypeId ? (definition.actionTypes.find((action) => action.id === item.actionTypeId)?.name ?? "") : "",
                mapped: Boolean(item.actionTypeId),
              })),
              missing_actions: check?.missingActions ?? [],
            };
          }),
          interface_note: implementsIdsOf(type).length
            ? "interfaces 是这个对象类型实现的接口（抽象契约）：接口属性按同名映射到对象类型自己的属性上，mapped=false 表示还没对上，缺失会挡住发布。"
            : "这个对象类型没有实现任何接口。接口是抽象契约，用来让不同的对象类型被同一套应用按同一个形状消费。",
          display_property: type.displayProperty ?? "",
          ...(promotedInterface
            ? { promoted_interface: promotedInterface.name, promoted_interface_note: `这个对象类型已经被提取为接口「${promotedInterface.name}」：画布上它以接口节点出现，接口的关系约束与实现方见 list_interfaces。它自己仍然是这几条关系类型（one_hop）的实际端点，名字和那个接口一样，别当成两个不同的东西。` }
            : {}),
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

    case "list_interfaces": {
      const interfaces = definition.interfaces ?? [];
      const entityNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      const interfaceNameById = new Map(interfaces.map((item) => [item.id, item.name]));
      const nameOf = (constraint: { targetKind: string; targetId: string }) => constraint.targetKind === "INTERFACE"
        ? interfaceNameById.get(constraint.targetId) ?? ""
        : entityNameById.get(constraint.targetId) ?? "";
      return {
        payload: {
          interface_count: interfaces.length,
          interfaces: interfaces.map((item) => {
            const implementers = implementersOf(interfaces, definition.entityTypes, item.id);
            return {
              name: item.name,
              description: describeBriefly(item.description ?? "", 100),
              // 继承的接口：接口属性与关系约束是从这些接口继承来的。
              parent_interfaces: interfaceAncestorsOf(interfaces, item.id).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean),
              properties: effectiveInterfaceProperties(interfaces, item.id).map((property) => ({
                name: property.name,
                data_type: property.dataType,
                required: property.required !== false,
              })),
              link_constraints: effectiveInterfaceLinkConstraints(interfaces, item.id).map((constraint) => ({
                name: constraint.name,
                target_kind: constraint.targetKind === "INTERFACE" ? "接口" : "对象类型",
                target: nameOf(constraint),
                cardinality: constraint.cardinality === "ONE" ? "一对一" : "一对多",
                required: constraint.required !== false,
              })),
              action_constraints: effectiveInterfaceActionConstraints(interfaces, item.id).map((constraint) => ({
                name: constraint.name,
                description: constraint.description ?? "",
                required: constraint.required !== false,
              })),
              implementers: implementers.map((entry) => entry.name),
              // 通过子接口间接实现的：应用按这个接口消费时同样能看到它们。
              inherited_implementers: implementers.filter((entry) => !entry.direct).map((entry) => entry.name),
            };
          }),
          note: interfaces.length
            ? "接口是抽象契约：不能被实例化，也不绑数据；它只描述「实现它的对象类型必须有哪些属性与关系」。要看某个对象类型的完整定义与它实现的接口，用 get_object_type。"
            : "这个本体还没有定义接口。",
        },
        evidence: interfaces.map((item) => ({ kind: "INTERFACE" as const, id: item.id, label: item.name })),
      };
    }    case "traverse_object_types": {
      const startName = (typeof args.start_type === "string" ? args.start_type : "").trim();
      const traversal = traverseTypeGraph(definition, {
        start: startName,
        hops: typeof args.hops === "number" ? args.hops : Number(args.hops),
        objectTypes: Array.isArray(args.object_types) ? args.object_types.map((item) => String(item)) : [],
        relationshipTypes: Array.isArray(args.relationship_types) ? args.relationship_types.map((item) => String(item)) : [],
        direction: parseTraverseDirection(args.direction),
      });
      if (traversal.unknown_start) throw new Error(`本体里没有对象类型「${traversal.unknown_start}」。先用 search_schema 确认名字。`);
      const relationNames = [...new Set(traversal.edges.map((edge) => edge.relation))];
      const interfaceLinks = traversal.edges.filter((edge) => edge.via_interface);
      return {
        payload: {
          hops: traversal.hops,
          direction: traversal.direction,
          starts: traversal.starts,
          filters: traversal.filters,
          node_count: traversal.nodes.length,
          edge_count: traversal.edges.length,
          nodes: traversal.nodes,
          edges: traversal.edges,
          // 实现接口带来的那些边单独点一句：模型要能解释"这条路是接口契约给的"。
          ...(interfaceLinks.length
            ? {
              interface_note: `标了 via_interface 的边不是直接建在对象类型上的关系类型，而是它**实现接口**拿到的：接口「X」的关系约束由实现方落地，所以实现方能沿这个关系走到对端。${interfaceLinks.length} 条这样的边（例如 ${interfaceLinks.slice(0, 3).map((edge) => `${edge.from}—${edge.relation}—${edge.to}（经接口「${edge.via_interface}」）`).join("；")}）。回答"A 能不能到 B"时，这类路径要算在内。`,
            }
            : {}),
          // 名字对不上就照实说，别让模型以为"限定生效了"。
          ...(traversal.unknown_names.length
            ? { unknown_names: traversal.unknown_names, unknown_note: "这些名字本体里没有，已忽略；先用 search_schema 确认真实名字。" }
            : {}),
          note: !startName
            ? "没有指定起点，所以是整张类型图（每个对象类型都是 0 跳）：nodes 是全部对象类型，edges 是它们之间全部的关系（关系类型双向，每条边两个方向都能走）。想从某个类型往外看，传 start_type。要看某个类型的属性、来源与动作，用 get_object_type。"
            : `hop 是离起点的最短跳数（起点是 0）；edges 是这些对象类型之间全部的关系，hop 取两端里更远的那个。direction 是本次生效的方向（${traversal.direction === "both" ? "两个方向都走" : traversal.direction === "forward" ? "只沿起点→终点" : "只沿终点→起点"}）。要看某个类型的属性、来源与动作，用 get_object_type。`,
        },
        evidence: [
          ...traversal.nodes.map((node) => ({ kind: "OBJECT_TYPE" as const, id: node.name, label: node.name })),
          ...relationNames.map((name) => ({ kind: "RELATION_TYPE" as const, id: name, label: name })),
        ],
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
      const limit = Math.min(clamp(args.limit, DEFAULT_SQL_ROWS, SQL_ROW_CEILING), ceiling);
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
          // 截断了就要说人话：模型只看到一个 true 时，
          // 很容易把"前 100 行"当成"一共就这么多"，进而下一个错结论。
          ...(result.truncated
            ? { truncation_note: `结果已被截断：只返回了前 ${result.rows.length} 行（本次上限 ${result.rowLimit}），表里还有更多行。要全貌就用更精确的 WHERE、聚合或更强的取数上限重新查；把"前 ${result.rows.length} 行"当成全量会得出错误结论。` }
            : {}),
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
      // 传接口名时，实现它的对象类型的实例也会回来：发布时把「实现」写成 rdfs:subClassOf，读路径沿它做类型传播。
      const nodes = await store.listEntities({ label: typeName, search, limit });
      const instances = nodes.slice(0, limit).map((node) => ({ _instance_identity: identityOf(definition, node), labels: node.labels, properties: businessProperties(node) }));
      return {
        payload: {
          object_type: typeName,
          returned: instances.length,
          instances,
          note: "实现该接口的对象类型的实例也会出现在结果里，看 labels 区分具体类型。回答时只引用上面出现过的 object_id。",
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
