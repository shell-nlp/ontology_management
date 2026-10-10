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
import { keyMappingLabel, keyMappingRows, type KeyMapping } from "@/lib/relationship-keys";
import { cardinalityLabel, cardinalityPhrase } from "@/lib/relationship-cardinality";
import { readOnlyPolicyNote } from "@/lib/data-source/sql-guard";
import { cachedColumnValueIndex, columnValueOf, ensureColumnProfile, enumProfileWarnings, sourceTableBinding, type ColumnValueIndex, type SourceTableBinding } from "@/lib/column-profile";
import type { EntityRecord, GraphStore, RuntimeTypeSet } from "@/lib/graph/types";
import type { OntologyDefinition } from "@/lib/ontology";
import { getObject, queryObjects } from "@/lib/object-service";
import { queryLinks } from "@/lib/object-service/links";
import type { ObjectContext, ObjectRecord } from "@/lib/object-service/types";
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

type ConceptKind = "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "PROPERTY" | "INTERFACE" | "METRIC";

/** 允许在 search_schema 的 kinds 里出现的取值（从类型定义里取一份运行时白名单）。 */
const CONCEPT_KINDS: ConceptKind[] = ["OBJECT_TYPE", "RELATION_TYPE", "ACTION", "PROPERTY", "INTERFACE", "METRIC"];

export type SchemaConcept = {
  kind: ConceptKind;
  name: string;
  haystack: string;
  /**
   * 低基数列的取值画像（采样来的码值），单独一档打分。
   *
   * 为什么要分开：模型常搜的是**码值**（「互联网专线」是 `ZX_FLAG='2'` 的意思），
   * 它既不是对象类型名也不是属性名，只在取值里出现。与描述混在一根 haystack 里，
   * 就没法区分"名字/描述里提到"和"某列真有这个取值"——后者才是能直接拿去过滤的落点。
   */
  values?: string;
  detail: string;
  /** 对象类型的实例数 / 关系类型的条数，用于无命中时的兜底排序。 */
  weight: number;
  /** 命中后模型下一步要用的落点：描述、绑定的表、来源列。 */
  description?: string;
  boundTable?: string;
  /** 这条落点所在的**数据资源名**（run_sql / get_table_ddl 要填的 data_source）；没绑 / 认不出就是空。 */
  dataSource?: string;
  sourceColumn?: string;
  /** 这条概念挂在哪些对象类型上（属性 / 指标是它自己的类型；关系类型是两个端点）。object_type 过滤用它。 */
  references?: string[];
};

export type SchemaMatch = {
  kind: ConceptKind;
  name: string;
  score: number;
  /** 靠什么命中的：名字 / 取值 / 描述 / 兜底。模型据此知道该拿这个结果干什么。 */
  matched: "name" | "value" | "description" | "fallback";
  reason: string;
  detail: string;
  /** 下面几项是落点：取值命中时 bound_table + source_column 就是"拿哪张表的哪一列去过滤"。 */
  description?: string;
  bound_table?: string;
  data_source?: string;
  source_column?: string;
  object_type?: string;
};

/** search_schema 的默认条数与调用方可以要到的上限（排序检索，不是清单；见那里的说明）。 */
const DEFAULT_SEARCH_MATCHES = 50;
const MAX_SEARCH_MATCHES = 1000;

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
      "在已发布本体里按一个或多个自然语言关键词检索对象类型、关系类型、动作、接口、指标与属性。任何问题都先调它，用来确认业务里到底有哪些概念、叫什么名字。多个关键词一次传入 queries，结果按概念去重。**默认给分数最高的前 50 条**；命中总数写在 total_matched、被省掉多少写在 omitted（尾巴可以不给，但**绝不隐形**）。要看更多就传 max_concepts（最大 1000），或者用更具体的业务词 / kinds 收窄。返回里 matched 说明凭什么命中：name=名字对上，description=描述/属性里提到，value=**某个列的取值**命中（这时 bound_table + source_column 就是落点，可以直接拿去 run_sql 过滤；命中的概念都带 data_source，那就是 run_sql / get_table_ddl 要填的数据资源名，不用再去 get_object_type 反查）。**整个本体都没命中时会带 no_match_queries** —— 那说明这些概念还没建进本体，剩下的 matches 只是兜底推荐，别当成命中、也别拿它硬凑口径。查「某某状态 / 某某类型」这类业务黑话时，先看有没有 value 命中——它往往比名字更接近答案。",
    parameters: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "一次传一个或多个关键词。结果会按概念去重，并在每条命中上标 matched_queries，避免同一轮重复检索同一概念" },
        max_concepts: { type: "integer", description: "最多返回多少个候选，默认 50、最大 1000。返回里的 total_matched 是命中总数、omitted 是这次没给的条数" },
        limit: { type: "integer", description: "max_concepts 的别名，二选一即可" },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["OBJECT_TYPE", "RELATION_TYPE", "ACTION", "PROPERTY", "INTERFACE", "METRIC"] },
          description: "只看这几类概念。只找类型时传 [\"OBJECT_TYPE\",\"METRIC\"]；不传就是都看（结果里对象类型 / 指标 / 关系类型保底占一半名额，不会被属性刷屏）",
        },
        object_type: { type: "string", description: "只看挂在这个对象类型下的概念（它的属性、指标、关系类型）。问「X 有哪些字段 / 指标」时传它" },
        include_values: { type: "boolean", description: "是否用已缓存的列画像做取值检索，默认 true。列画像是按天缓存的采样结果，不会为了一次检索去扫表" },
      },
      required: ["queries"],
    },
  },
  {
    name: "get_object_type",
    description:
      "读取一个对象类型的完整定义：属性（映射到哪一列也会带上）、实现了哪些接口、参与的关系类型、可执行的动作、绑定的数据来源（哪张表 / 视图、主键、标题列、在哪个数据资源上）。问「某个对象类型绑了哪张表」时调它。",
    parameters: {
      type: "object",
      properties: {
        type_names: { type: "array", items: { type: "string" }, description: "一次查询多个对象类型；返回 objects 数组，每一项都是单个 get_object_type 的完整原样结果" },
      },
      required: ["type_names"],
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
      "从对象类型出发沿关系类型走 1~5 跳，返回沿途的对象类型与关系类型。问「这个对象类型一圈都连着谁」「隔两跳能到哪些类型」「A 和 B 之间怎么连」时用它。关系类型是**双向**的（一条关系类型两侧都能走，不用另建反向关系），所以默认两个方向都算连通；要只往外或只往回，用 direction 收窄。hops 默认 3、上限 5；object_types / relationship_types 把范围限死在指定的类型上（不填就是不限定）；start_type 留空表示从本体的全部对象类型出发。只看一层的关系类型与属性定义用 get_object_type。**返回的列序**：nodes 每项是 [对象类型名, 分组, 跳数, 描述, [绑定的表]]，edges 每项是 [关系类型名, 起点对象类型, 终点对象类型, 跳数, 经哪个接口, 基数, 键映射]（不是经接口拿到的边、没标基数的边、没配键映射的边，对应位置是空串；键映射是 { source, target } 两端各自的连接属性，写 SQL 时按它连，别自己猜列名）。",
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
      "看一个或多个表 / 视图的结构，返回每张表完整的 DDL（列、类型、可空、主键、注释）、**列画像**（column_profile：每列采样 1000 行，低基数列给出取值清单、取值种数、空值比例）以及**反向引用**（bound_object_types：这张表被哪些对象类型绑定、各映射了哪几列）。多个表一次传入 tables，results 中每一项与单独调用完全一致。问「某某状态 / 某某类型对应哪个码值」先看 column_profile，不要一轮轮手写 GROUP BY 去探；表名没人认领时看 bound_object_types（本平台里表只能通过对象类型到达）。画像是按天缓存的采样结果，默认直接复用；只有传 refresh=true 才回源库重采（大表 COUNT(DISTINCT) 很贵，别频繁刷新）。返回里的 elapsed_ms 是这一步实际耗时，别对同一张表反复调。data_source 用数据资源名（见概念清单后面的数据资源），**也可以不传** —— 不给就按 table 在本体绑定里自动定位资源，定位到多个才必须指定。tables 中每项写全「模式.表」，例如 GISTOOLS.TB_DIC_AREA_CODE（对象类型绑定的表就是这么写的）；只写表名也认，模式退回数据资源登记的那个。**返回的列序**：column_profile.columns 每项是 [列名, 取值种数, 空值比例, 取值清单]，高基数列没有第 4 项；bound_object_types 每项是 [对象类型名, 映射到这张表的列, 来源角色, 主键列, 映射列总数, 绑定状态]（**映射列给全、不截断**，总数与清单长度一致；绑定状态写「未绑定数据资源」时，说明这条来源的 dataSourceId 还没绑到本机资源，去「对象 / 本体」页点「补齐数据资源绑定」补上再跑数，别当成表不存在）。采样里的取值清单是**跨多个统计日混在一起**算的，别当成「每天都有」——覆盖了哪些日期看 sample_coverage；带右填充空格的列看 padded_columns（比较 / join 要 TRIM，漏了会静默丢行）。要跑数之前先用它确认字段。",
    parameters: {
      type: "object",
      properties: {
        data_source: { type: "string", description: "数据资源名称，例如「Oracle 测试 1251」。**可以省略**：不给就按 table 在本体绑定里自动定位资源，定位到多个才必须指定" },
        tables: { type: "array", items: { type: "string" }, description: "一次查询多张表；返回 tables 数组，每一项都是单个 get_table_ddl 的完整原样结果。data_source 可对整批共用" },
        refresh: { type: "boolean", description: "重新采一次列画像（默认 false：用当天缓存的那一份）。只在确实怀疑数据分布变了时才传 true" },
      },
      required: ["tables"],
    },
  },
  {
    name: "run_sql",
    description:
      "在数据资源上执行**只读** SQL 查询（SELECT / WITH / SHOW / EXPLAIN），用来核对对象类型绑定的表里到底是什么数据。SQL 里的表名同样写全「模式.表」（如 SELECT * FROM GISTOOLS.TB_DIC_AREA_CODE），别依赖连接用户的默认模式。写操作（INSERT / UPDATE / DELETE / DROP 等）和多语句会被直接拒绝；**默认最多返回 100 行**，超过就在结果里标 truncated=true 并给出提示（要更多就传 limit，或用更精确的 WHERE / 聚合）。**一次调用可以带多个 CTE / 子查询**：把「探码值 + 汇总 + 校验」合并成一条语句比来回查省得多；返回里的 elapsed_ms 就是这条语句实际花了多久，可以据此判断哪次查询贵。**返回的列序**：rows 是二维数组，每行按 columns 的顺序排列（列名只在 columns 里出现一次）；只有语句被平台改写时才回显 executed_statement；只读事务没起得来时会带 read_only_transaction=false 与 warning。写查询前先用 get_table_ddl 确认字段名与码值。",
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
    description:
      "按对象类型查询真实对象（实例）：先查本体的物化索引，索引里没有就按对象类型绑定的数据资源回源取数（回源这一批不落库）。传接口名时，实现了该接口的类型的实例也会一起返回。返回的 _instance_identity.object_id 与 _primary_key 是真标识，后续只能用返回过的 id。",
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
    description:
      "按对象类型与关系类型取一张子图，返回节点与关系：节点来自对象服务（索引或数据源），关系来自本体图里已存在的关系实例。用于回答「A 和 B 之间怎么连」这类问题；节点可能来自数据源而没有任何关系，这时如实说明。",
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
  {
    name: "list_metrics",
    description:
      "列出本体里定义的**指标**（业务口径）：每个指标量的是什么、作用在哪个对象类型上、按哪个属性怎么聚合、固定过滤（口径边界）、可按哪些维度分组、单位。问「某某条数 / 金额怎么算」「有没有现成的口径」时调它；不要自己从列注释里猜口径，先用这里的定义。指标只描述「怎么算」，不是某一次查询的结果。",
    parameters: {
      type: "object",
      properties: {
        type_name: { type: "string", description: "可选，只看作用在这个对象类型上的指标" },
        name: { type: "string", description: "可选，按名字精确找一条指标" },
        status: { type: "string", enum: ["draft", "verified"], description: "可选，按验收状态过滤。要拿现成口径出数就传 verified：draft 是还没定稿的（测试残留、配置示例都在这一档），别拿来当已验收口径用" },
      },
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

export function schemaConcepts(definition: OntologyDefinition, runtimeTypes: RuntimeTypeSet | null, dataSources: DataSourceRecord[] = [], valueIndex: ColumnValueIndex | null = null): SchemaConcept[] {
  const resourceNameById = new Map(dataSources.map((item) => [item.id, item.name]));
  /*
   * 没绑 / 绑飞了的来源：模式名唯一对得上一个资源时兜底给出资源名（与 get_object_type.sources 同一口径）。
   * 有它模型才不用从 detail 的长句里人工抠资源名 —— search_schema 直接给 data_source 落点。
   */
  const resourceNamesBySchema = new Map<string, string[]>();
  for (const item of dataSources) {
    const key = (item.schema_name ?? "").trim().toUpperCase();
    if (!key) continue;
    resourceNamesBySchema.set(key, [...(resourceNamesBySchema.get(key) ?? []), item.name]);
  }
  const resourceNameOf = (source: { dataSourceId?: string; schema?: string } | undefined) => {
    if (!source) return "";
    const bound = resourceNameById.get(source.dataSourceId ?? "") ?? "";
    if (bound) return bound;
    const candidates = resourceNamesBySchema.get((source.schema ?? "").trim().toUpperCase()) ?? [];
    return candidates.length === 1 ? candidates[0] : "";
  };
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
    const sourced = entitySources(entity);
    // 绑定的表名也进检索面：问"某类在哪个表里"时，靠表名本身也能命中。
    const tables = sourced.map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const boundTable = tables[0] ?? "";
    const resources = [...new Set(sourced.map((source) => resourceNameOf(source)).filter(Boolean))];
    // 实现了哪些接口也进检索面：问「谁实现了设施接口」能直接命中这些对象类型。
    const implemented = (entity.implements ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    /*
     * 取值画像：把这张表上映射列的低基数取值拼成一根字符串，单独一档打分。
     * 只取已缓存的画像（按天采样），检索本身不回源库 —— 见 @/lib/column-profile。
     */
    const values = [...new Set(sourced.flatMap((source) =>
      properties
        .filter((property) => property.sourceField && (!property.sourceId || property.sourceId === source.id))
        .flatMap((property) => columnValueOf(valueIndex, source.schema, source.view, property.sourceField ?? "")),
    ))].slice(0, 400);
    concepts.push({
      kind: "OBJECT_TYPE",
      name: entity.name,
      // 概念分组也进检索面：问「客户域里有什么」时，该组的成员会被搜出来。
      // 属性说明也进检索面（截 120 字）：业务口径多半写在列的注释里。
      haystack: normalize([entity.name, describeBriefly(entity.description, 200), group, ...tables, ...properties.map((property) => property.name), ...properties.map((property) => describeBriefly(property.description ?? "", 120)), ...implemented].join(" ")),
      values: normalize(values.join(" ")),
      detail: [
        group ? `分组 ${group}` : "",
        implemented.length ? `实现接口 ${implemented.join("、")}` : "",
        tables.length ? `绑定 ${tables.join("、")}${resources.length ? `（${resources.join("、")}）` : ""}` : "",
        properties.length ? `属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
      ].filter(Boolean).join("；"),
      weight: objectCount.get(entity.name) ?? 0,
      description: entity.description,
      boundTable,
      dataSource: resourceNameOf(sourced[0]),
      references: [entity.name],
    });
    for (const property of properties) {
      // 属性的落点就是"哪张表的哪一列"：模型拿到它不用再猜，也不用再调一次 get_object_type。
      const source = sourced.find((item) => !property.sourceId || item.id === property.sourceId) ?? sourced[0];
      concepts.push({
        kind: "PROPERTY",
        name: `${entity.name}.${property.name}`,
        haystack: normalize([entity.name, property.name, property.dataType, describeBriefly(property.description ?? "", 120)].join(" ")),
        // 属性声明的取值枚举（码值 + 中文含义）也进取值面：「全球通」要能命中 U_TYPE，而不是靠描述里碰巧出现。
        values: normalize([
          ...columnValueOf(valueIndex, source?.schema ?? "", source?.view ?? "", property.sourceField ?? ""),
          ...(property.enumValues ?? []).flatMap((item) => [item.value, item.label].filter(Boolean)),
        ].join(" ")),
        detail: `${property.dataType}${property.required ? "，必填" : ""}${property.sourceField ? `，取自 ${property.sourceField}` : ""}`,
        weight: 0,
        description: property.description ?? "",
        boundTable: source ? [source.schema, source.view].filter(Boolean).join(".") : boundTable,
        dataSource: resourceNameOf(source),
        sourceColumn: property.sourceField ?? "",
        references: [entity.name],
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
      haystack: normalize([item.name, describeBriefly(item.description, 200), ...properties.map((property) => property.name), ...properties.map((property) => describeBriefly(property.description ?? "", 120)), ...implementers, ...inherited].join(" ")),
      detail: [
        "接口（抽象契约，不绑数据、不能直接实例化）",
        inherited.length ? `继承 ${inherited.join("、")}` : "",
        properties.length ? `接口属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
        implementers.length ? `${implementers.length} 个实现：${implementers.join("、")}` : "还没有对象类型实现它",
      ].filter(Boolean).join("；"),
      weight: 0,
      description: item.description,
      references: implementers,
    });
  }  for (const relationship of definition.relationshipTypes) {
    const source = typeNameById.get(relationship.sourceEntityTypeId) ?? "";
    const target = typeNameById.get(relationship.targetEntityTypeId) ?? "";
    concepts.push({
      kind: "RELATION_TYPE",
      name: relationship.name,
      haystack: normalize([relationship.name, describeBriefly(relationship.description ?? "", 200), source, target].join(" ")),
      // 双向关系类型只写一条定义：用 ↔ 表示两个方向都能走，别让人以为反向要再来一条。
      detail: `${source || "未指定"} ↔ ${target || "未指定"}${relationship.cardinality ? `；基数 ${cardinalityLabel(relationship.cardinality)}（起点 → 终点）` : ""}`,
      weight: relationshipCount.get(relationship.name) ?? 0,
      description: relationship.description ?? "",
      references: [source, target].filter(Boolean),
    });
  }

  for (const action of definition.actionTypes) {
    const scope = typeNameById.get(action.scopeEntityTypeId) ?? "";
    concepts.push({
      kind: "ACTION",
      name: action.name,
      haystack: normalize([action.name, action.code, describeBriefly(action.description, 200), scope, ...action.params.map((param) => param.name)].join(" ")),
      detail: `作用于 ${scope || "未指定"}；入参 ${action.params.map((param) => param.name).join("、") || "无"}`,
      weight: 0,
      description: action.description,
      references: scope ? [scope] : [],
    });
  }

  /*
   * 指标（业务口径）也是一等可检索概念：问「短彩信欠费金额怎么算」时，
   * 现成的口径定义比让模型从列注释里反推可靠得多。
   */
  for (const metric of definition.metrics ?? []) {
    const scopeType = definition.entityTypes.find((item) => item.id === metric.entityTypeId) ?? null;
    const scope = scopeType?.name ?? "";
    const source = scopeType ? entitySources(scopeType)[0] : undefined;
    const column = scopeType?.properties.find((item) => item.name === metric.property)?.sourceField ?? "";
    concepts.push({
      kind: "METRIC",
      name: metric.name,
      haystack: normalize([
        metric.name,
        describeBriefly(metric.description, 200),
        scope,
        metric.property,
        metric.aggregation,
        ...metric.dimensions,
        ...metric.filters.map((filter) => `${filter.property} ${filter.value}`),
        metric.timeProperty,
        ...metric.tags,
      ].join(" ")),
      values: normalize(columnValueOf(valueIndex, source?.schema ?? "", source?.view ?? "", column).join(" ")),
      detail: [
        `${metric.aggregation}${metric.property ? `(${metric.property})` : "（行数）"}`,
        scope ? `作用 ${scope}` : "还没选作用的对象类型",
        metric.filters.length ? `口径 ${metric.filters.map((filter) => `${filter.property}${filter.operator}${filter.value}`).join("、")}` : "",
        metric.dimensions.length ? `维度 ${metric.dimensions.join("、")}` : "",
        metric.unit ? `单位 ${metric.unit}` : "",
        // 状态位进检索结果的说明：模型一眼能分辨「已验收」和「还没定稿」。
        (metric.status ?? "draft") === "verified" ? "已验收" : "未验收（draft）",
      ].filter(Boolean).join("；"),
      weight: 0,
      description: metric.description,
      boundTable: source ? [source.schema, source.view].filter(Boolean).join(".") : "",
      dataSource: resourceNameOf(source),
      sourceColumn: column,
      references: scope ? [scope] : [],
    });
  }

  return concepts;
}

/**
 * 这次检索有没有「真命中」：整串关键词落在某个概念的名字 / 描述 / 已缓存取值上，**或者至少两个词重合**。
 *
 * 为什么要单独判：没命中时 rankSchemaConcepts 会给一批兜底推荐（实例数权重会让结果非空），
 * 只看 matches.length 永远判不出"没命中"，模型就会把兜底当成命中、换着词反复试探（2026-10-10 用户报的）。
 * 单个 2 字词的重合（搜「专线分类」碰到「业务」）是噪音，不算命中。
 *
 * 这里不碰 rankSchemaConcepts 的排序与分档，只回答"有没有落到东西"。
 */
export function schemaQueryHasStrongHit(concepts: readonly SchemaConcept[], query: string): boolean {
  const needle = normalize(query);
  if (!needle) return false;
  const tokens = queryTokens(query);
  return concepts.some((concept) => {
    const name = normalize(concept.name);
    if (name === needle || name.includes(needle) || needle.includes(name)) return true;
    if (needle.length >= 2 && concept.values && concept.values.includes(needle)) return true;
    if (needle.length >= 2 && concept.haystack.includes(needle)) return true;
    // 长问题（"统计互联网专线带宽≥100的条数"）整串不会出现在任何描述里，退回按词命中，但要有 ≥2 个词才算数。
    return tokens.filter((token) => token.length >= 2 && token !== needle && concept.haystack.includes(token)).length >= 2;
  });
}

export type RankSchemaOptions = {
  /** 只看这几类概念（不传 = 全都看）。 */
  kinds?: ConceptKind[];
  /**
   * 类型类概念（对象类型 / 指标 / 关系类型）保底占一半名额，默认开。
   *
   * 为什么：属性数量是对象类型的几十倍，光按分排，「订单」这种查询会被
   * 「订单.编号」「订单.金额」刷屏，模型拿不到真正能往下走的那一层。只在**有命中**时生效。
   */
  typeQuota?: boolean;
};

type ScoredConcept = { concept: SchemaConcept; score: number; reason: string; matched: SchemaMatch["matched"] };

/** 类型类概念：这些是模型能接着往下走的东西（属性只能拿去过滤，走不了关系）。 */
const TYPE_KINDS = new Set<ConceptKind>(["OBJECT_TYPE", "RELATION_TYPE", "METRIC"]);

/**
 * 排序规则刻意可解释，分三档、**每档一个固定分**：
 * 1. 名字：完全一致 100 / 包含 70 / 有 ≥2 个字重合 20+6n；
 * 2. 取值命中（列画像里的码值）45 —— 这是"业务黑话其实是一个码值"的情况，落点最实在；
 * 3. 描述 / 属性命中 30 —— 覆盖"口径写在列注释里"的情况。
 * 名字已经对上（≥70）时不再叠加后两档：否则一个啰嗦的描述会把真正的名字命中比下去。
 * 全都没命中时按实例数量兜底，至少让模型知道这个本体里最"重"的概念是什么。
 */
export function rankSchemaConcepts(concepts: readonly SchemaConcept[], query: string, maxConcepts: number, options: RankSchemaOptions = {}): SchemaMatch[] {
  const kinds = options.kinds?.length ? new Set(options.kinds) : null;
  const needle = normalize(query);
  const tokens = queryTokens(query);
  const scored: ScoredConcept[] = concepts
    .filter((concept) => !kinds || kinds.has(concept.kind))
    .map((concept) => {
      const name = normalize(concept.name);
      let score = 0;
      let reason = "";
      let matched: SchemaMatch["matched"] = "fallback";
      if (needle && name === needle) { score = 100; reason = "名称完全一致"; matched = "name"; }
      else if (needle && (name.includes(needle) || needle.includes(name))) { score = 70; reason = "名称包含查询词"; matched = "name"; }
      // 名字已经对上就不再叠加后两档：否则一个啰嗦的描述会把真正的名字命中比下去。
      if (score < 70) {
        const valueHit = needle.length >= 2 && Boolean(concept.values) && (concept.values ?? "").includes(needle);
        const textHit = needle.length >= 2 && concept.haystack.includes(needle);
        if (valueHit) {
          score += 45;
          matched = "value";
          reason = `取值命中：有列的取值包含「${query.trim()}」`;
        } else if (textHit) {
          score += 30;
          matched = "description";
          reason = "描述 / 属性里提到了查询词";
        } else {
          // 名字只有零星几个字重合，是弱信号；它排在取值 / 描述命中之后。
          const common = needle ? longestCommonSubstring(needle, name) : 0;
          if (common >= 2) { score = 20 + common * 6; reason = `名称与查询词有 ${common} 个字重合`; matched = "name"; }
          // 长问题（"统计互联网专线带宽≥100的条数"）整体不会出现在任何描述里，退回按词命中，最多算 3 个词。
          const hits = tokens.filter((token) => token.length >= 2 && token !== needle && concept.haystack.includes(token)).slice(0, 3);
          if (hits.length) {
            score += hits.length * 8;
            if (matched !== "name") matched = "description";
            if (!reason) reason = `描述 / 属性命中：${hits.join("、")}`;
          }
        }
      }
      return { concept, score: score + Math.min(10, concept.weight), reason, matched };
    });

  const matched = scored.filter((item) => item.score > 0);
  if (!matched.length) {
    /*
     * 都没命中时兜底给一批概念，而不是空手而归 —— 注意这里**不再按"有实例的才有资格"筛**：
     * 一个刚建好、图库还是空的本体，那样会一条都返回不了。weight 只影响排序，不影响有没有。
     */
    return scored
      .sort(compareScored)
      .slice(0, maxConcepts)
      .map((item) => toMatch(item, "fallback"));
  }
  return applyTypeQuota(matched.sort(compareScored), maxConcepts, options.typeQuota !== false).map((item) => toMatch(item));
}

function compareScored(a: ScoredConcept, b: ScoredConcept) {
  return b.score - a.score || a.concept.name.localeCompare(b.concept.name, "zh-CN");
}

function toMatch(item: ScoredConcept, forced?: SchemaMatch["matched"]): SchemaMatch {
  return {
    kind: item.concept.kind,
    name: item.concept.name,
    score: item.score,
    matched: forced ?? item.matched,
    reason: item.reason || "没命中关键词，按本体概念清单兜底推荐",
    detail: item.concept.detail,
    ...(item.concept.description ? { description: describeBriefly(item.concept.description, 300) } : {}),
    ...(item.concept.boundTable ? { bound_table: item.concept.boundTable } : {}),
    ...(item.concept.dataSource ? { data_source: item.concept.dataSource } : {}),
    ...(item.concept.sourceColumn ? { source_column: item.concept.sourceColumn } : {}),
    ...(item.concept.kind === "PROPERTY" || item.concept.kind === "METRIC" ? { object_type: item.concept.references?.[0] ?? "" } : {}),
  };
}

/**
 * 类型类概念（对象类型 / 指标 / 关系类型）保底占一半名额：**从尾部换掉分数最低的属性类命中**，
 * 不重排、不插队，已经被名字命中的东西位置不动。
 */
function applyTypeQuota(ordered: ScoredConcept[], maxConcepts: number, enabled: boolean): ScoredConcept[] {
  const head = ordered.slice(0, maxConcepts);
  if (!enabled || head.length < 2) return head;
  const wanted = Math.ceil(head.length / 2);
  const kept = head.filter((item) => TYPE_KINDS.has(item.concept.kind)).length;
  if (kept >= wanted) return head;
  const extra = ordered.slice(maxConcepts).filter((item) => TYPE_KINDS.has(item.concept.kind));
  const out = [...head];
  for (let i = 0; i < wanted - kept && i < extra.length; i += 1) {
    for (let j = out.length - 1; j >= 0; j -= 1) {
      if (!TYPE_KINDS.has(out[j].concept.kind)) { out[j] = extra[i]; break; }
    }
  }
  return out;
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

/**
 * 实例工具的上下文：目标本体存储 + 已发布定义。
 *
 * `versionId` 留空是有意的 —— 读路径（索引 / 回源）不需要它，只有往索引里写才用得上，
 * 而工具是只读的。所以这里不必再去查一次版本记录。
 */
function objectContextOf(context: ToolContext): ObjectContext {
  return { targetId: context.store.target.id, definition: context.definition, versionId: null };
}

/** 对象服务返回的对象 -> 工具的实例形状（与图库那条路径保持同一个形状）。 */
function instanceOf(record: ObjectRecord) {
  return {
    _instance_identity: { object_type: record.entityType, object_id: record.objectId, title: record.title },
    labels: [record.entityType],
    properties: record.properties,
    _origin: record.origin,
    _primary_key: record.primaryKey,
  };
}

/** 属性里的布局信息（fx/fy）对推理没有意义，去掉能省不少 token。 */
function businessProperties(node: EntityRecord) {
  return Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
}

/**
 * 一条关系类型声明过的键映射（连接属性 → 该端对象类型的属性）；两端都没配就是 null。
 *
 * get_object_type 的一跳与 traverse_object_types 的边共用这一份 —— 多跳时模型同样需要连接键，
 * 以前只在 get_object_type 里给，走 2 跳以上就只能猜列名，猜错是**静默错数**。
 */
function keyMappingsOf(relation: { sourceKeyMappings?: readonly KeyMapping[]; targetKeyMappings?: readonly KeyMapping[] }) {
  const source = keyMappingRows(relation.sourceKeyMappings).map(keyMappingLabel);
  const target = keyMappingRows(relation.targetKeyMappings).map(keyMappingLabel);
  if (!source.length && !target.length) return null;
  return { source, target };
}

/**
 * 一张表可能属于哪些已登记的数据资源。纯函数，不连库。
 *
 * get_table_ddl 在模型没给 data_source 时用它自动定位 —— 模型常常只拿到一个表名，
 * 硬要它先反查出资源名是多一轮往返。判据与来源绑定一致：先看有没有对象类型绑到这张表，
 * 都没有就退一步按模式名匹配（来源还没补齐绑定时就靠这条兜底）。
 */
export function dataSourcesForTable(definition: OntologyDefinition, dataSources: readonly DataSourceRecord[], schema: string, table: string): DataSourceRecord[] {
  const wantTable = (table ?? "").trim().toUpperCase();
  if (!wantTable) return [];
  const wantSchema = (schema ?? "").trim().toUpperCase();
  const ids = new Set<string>();
  let mentioned = false;
  for (const entity of definition.entityTypes) {
    for (const source of entitySources(entity)) {
      if ((source.view ?? "").trim().toUpperCase() !== wantTable) continue;
      const sourceSchema = (source.schema ?? "").trim().toUpperCase();
      if (wantSchema && sourceSchema && sourceSchema !== wantSchema) continue;
      mentioned = true;
      const id = (source.dataSourceId ?? "").trim();
      if (id) ids.add(id);
    }
  }
  const bound = dataSources.filter((item) => ids.has(item.id));
  if (bound.length) return bound;
  /*
   * 只有「表名确实被某条来源引用、但那条来源没绑资源（或绑飞了）」才走模式名兜底。
   * 表名谁都没引用时返回空 —— 那多半是表名写错了，该让调用方报「定位不出」，别硬塞一个资源去连。
   */
  if (!mentioned || !wantSchema) return [];
  return dataSources.filter((item) => (item.schema_name ?? "").trim().toUpperCase() === wantSchema);
}

/**
 * 一张表被哪些对象类型绑着、各自映射了哪些列。
 *
 * 为什么要有它：表的可达路径一直是"对象类型 → 它绑的表"，模型拿一张表名进来时
 * **查不到这张表是什么**（清单里没有"枚举库表"这种能力，也不该有）。
 * 反过来给一份"这张表被谁用、哪几列被映射了"，模型立刻能判断"是不是表名写错了 / 该看哪个对象类型"。
 * 纯函数：只读定义，不连库。
 */
export function objectTypesBoundTo(definition: OntologyDefinition, dataSourceId: string, schema: string, table: string, knownSourceIds?: readonly string[]) {
  const bindings: { object_type: string; source_role: string; primary_key: string[]; mapped_columns: string[]; mapped_column_count: number; binding: SourceTableBinding }[] = [];
  for (const entity of definition.entityTypes) {
    entitySources(entity).forEach((source, index) => {
      const binding = sourceTableBinding(source, { dataSourceId, schema, table, knownSourceIds });
      if (!binding) return;
      const columns = [...new Set(entity.properties
        .filter((property) => property.sourceField && (!property.sourceId || property.sourceId === source.id))
        .map((property) => property.sourceField as string))];
      bindings.push({
        object_type: entity.name,
        source_role: sourceRoleLabel(index),
        primary_key: source.primaryKey.filter(Boolean),
        /*
         * **给全，不截断**（2026-10-10 用户口径：「列清单不要设上限把尾巴砍掉」）。
         * 以前只列前 30 列，结果 51 列的表里从第 31 列起（含 U_TYPE 这种关键口径列）永远看不见，
         * 模型只能再调一次 get_object_type 反查 —— 省了小钱、赔了一次往返。
         */
        mapped_columns: columns,
        mapped_column_count: columns.length,
        binding,
      });
    });
  }
  return bindings;
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
/** 边的基数只在"这条边来自关系类型本身"时才有：接口承接的关系由接口约束描述，不带这一项。 */
export type TypeGraphEdge = { relation: string; from: string; to: string; hop: number; via_interface?: string; cardinality?: string; key_mapping?: { source: string[]; target: string[] } };

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
  const links: { name: string; fromId: string; toId: string; viaInterface: string; cardinality?: string; keyMapping?: { source: string[]; target: string[] } }[] = [
    ...definition.relationshipTypes.map((item) => ({ name: item.name, fromId: item.sourceEntityTypeId, toId: item.targetEntityTypeId, viaInterface: "", cardinality: item.cardinality ?? "", keyMapping: keyMappingsOf(item) ?? undefined })),
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
      return {
        relation: link.name,
        from,
        to,
        hop: Math.max(fromHop, toHop),
        ...(link.viaInterface ? { via_interface: link.viaInterface } : {}),
        // 基数：这条边起点端 → 终点端 是一对一 / 一对多 / ……；没标注就不带这一项。
        ...("cardinality" in link && link.cardinality ? { cardinality: link.cardinality } : {}),
        // 键映射：这条边两端在数据上按哪几个属性对上；没配就不带（别挂空数组）。
        ...(link.keyMapping ? { key_mapping: link.keyMapping } : {}),
      };
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

  // 批量入口只负责编排，单项仍走下面原有实现，保证旧参数与单项返回字段完全不变。
  if (name === "search_schema") {
    const rawQueries = Array.isArray(args.queries) ? args.queries : Array.isArray(args.query) ? args.query : null;
    const queries = rawQueries
      ? [...new Set(rawQueries.map((item) => String(item).trim()).filter(Boolean))]
      : [];
    if (queries.length) {
      const { queries: _queries, query: _query, ...baseArgs } = args;
      const outcomes = await Promise.all(queries.map((query) => runReasoningTool(name, { ...baseArgs, query }, context)));
      type Match = Record<string, unknown> & { kind?: string; name?: string; score?: number };
      const merged = new Map<string, Match>();
      const matchedQueries = new Map<string, string[]>();
      const queryScores = new Map<string, Record<string, number>>();
      const noMatchQueries: string[] = [];
      for (let index = 0; index < outcomes.length; index += 1) {
        const payload = outcomes[index].payload as { matches?: Match[]; no_match?: boolean };
        const query = queries[index];
        if (payload.no_match) noMatchQueries.push(query);
        for (const match of payload.matches ?? []) {
          const key = `${String(match.kind ?? "")}:${String(match.name ?? "")}`;
          const previous = merged.get(key);
          if (!previous || Number(match.score ?? 0) > Number(previous.score ?? 0)) merged.set(key, { ...match });
          matchedQueries.set(key, [...new Set([...(matchedQueries.get(key) ?? []), query])]);
          queryScores.set(key, { ...(queryScores.get(key) ?? {}), [query]: Number(match.score ?? 0) });
        }
      }
      const matches = [...merged.entries()].map(([key, match]) => ({
        ...match,
        matched_queries: matchedQueries.get(key) ?? [],
        query_scores: queryScores.get(key) ?? {},
      }));
      const firstPayload = outcomes[0]?.payload as Record<string, unknown> | undefined;
      return {
        payload: {
          queries,
          matches,
          /* 去重之后的条数，与单关键词那条路径同一个字段名。 */
          total_matched: matches.length,
          ...(noMatchQueries.length ? { no_match_queries: noMatchQueries } : {}),
          hint: "本次按多个关键词检索后已按 kind + name 去重；matched_queries 说明每个概念由哪些关键词命中，query_scores 保留各关键词的评分。",
          note: firstPayload?.note ?? "本平台里表只能通过对象类型到达；不要枚举数据源里的表和列，需要换角度查就用 search_schema、get_object_type。",
        },
        evidence: outcomes.flatMap((outcome) => outcome.evidence).filter((item, index, all) => all.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) === index),
      };
    }
  }

  if (name === "get_object_type") {
    const rawNames = Array.isArray(args.type_names) ? args.type_names : Array.isArray(args.type_name) ? args.type_name : null;
    const names = rawNames ? [...new Set(rawNames.map((item) => String(item).trim()).filter(Boolean))] : [];
    if (names.length) {
      const { type_names: _typeNames, type_name: _typeName, ...baseArgs } = args;
      const outcomes = await Promise.all(names.map((type_name) => runReasoningTool(name, { ...baseArgs, type_name }, context)));
      return {
        payload: { object_types: names, objects: outcomes.map((outcome) => outcome.payload), note: "objects 数组中的每一项都是单独调用 get_object_type 的完整结果，字段未删减。" },
        evidence: outcomes.flatMap((outcome) => outcome.evidence),
      };
    }
  }

  if (name === "get_table_ddl") {
    const rawTables = Array.isArray(args.tables) ? args.tables : Array.isArray(args.table) ? args.table : null;
    const tables = rawTables ? [...new Set(rawTables.map((item) => String(item).trim()).filter(Boolean))] : [];
    if (tables.length) {
      const { tables: _tables, table: _table, ...baseArgs } = args;
      const outcomes = await Promise.all(tables.map((table) => runReasoningTool(name, { ...baseArgs, table }, context)));
      return {
        payload: { tables, results: outcomes.map((outcome) => outcome.payload), note: "results 数组中的每一项都是单独调用 get_table_ddl 的完整结果，DDL、列画像与反向引用均保留。" },
        evidence: outcomes.flatMap((outcome) => outcome.evidence),
      };
    }
  }

  switch (name) {
    case "search_schema": {
      const query = typeof args.query === "string" ? args.query : "";
      /*
       * 条数（2026-10-10 用户口径：「列清单不要设上限把尾巴砍掉」）。
       *
       * 这里是**排序检索**，不是清单：实测"用户"这种词命中 583 条、183KB —— 全给会把上下文直接撑爆
       * （还会撞上历史回放的上限，等于尾巴照样断，而且更不可解释）。所以：
       * - 默认给前 50 条（覆盖住实际问法：业务词一般命中几条到几十条）；
       * - 调用方**可以**要更多，最多 ${MAX_SEARCH_MATCHES} 条（要全量就给够大）；
       * - **永远如实报出**命中总数与被省掉的条数（total_matched / omitted）—— 尾巴可以不给，但不能隐形。
       */
      const requestedMax = args.max_concepts ?? args.limit;
      const maxConcepts = requestedMax === undefined || requestedMax === null || requestedMax === ""
        ? DEFAULT_SEARCH_MATCHES
        : Math.min(MAX_SEARCH_MATCHES, Math.max(1, Math.floor(Number(requestedMax))));
      const requested = Array.isArray(args.kinds) ? args.kinds.map((item) => String(item).trim().toUpperCase()) : [];
      const kinds = requested.filter((item): item is ConceptKind => (CONCEPT_KINDS as string[]).includes(item));
      const scopeType = typeof args.object_type === "string" && args.object_type.trim() ? args.object_type.trim() : "";
      const includeValues = args.include_values !== false;
      /** 取值索引只读平台库里已缓存的画像；取不到（没建库 / 还没采过）就当没有，不让检索失败。 */
      const valueIndex = includeValues ? await cachedColumnValueIndex(definition).catch(() => null) : null;
      let concepts = schemaConcepts(definition, runtimeTypes, context.dataSources ?? [], valueIndex);
      if (scopeType) {
        if (!definition.entityTypes.some((item) => item.name === scopeType)) throw new Error(`本体里没有对象类型「${scopeType}」。先用 search_schema 确认名字。`);
        concepts = concepts.filter((item) => item.references?.includes(scopeType));
      }
      /*
       * 「整个本体都没命中」要和「命中了」分开说。以前只看 matches.length —— 但没命中时
       * rankSchemaConcepts 会给一批兜底推荐（实例数权重也会让结果非空），于是 hint 永远说
       * "这些是本体里的真实定义"，模型只能靠换词反复试探（2026-10-10 用户报的就是这个）。
       */
      const noMatch = !schemaQueryHasStrongHit(concepts, query);
      // 先按同一个查询词排全部，再决定要不要截 —— 这样"总数"才是真的（不是截断后的长度）。
      const allRanked = rankSchemaConcepts(concepts, query, Number.POSITIVE_INFINITY, { kinds });
      const ranked = Number.isFinite(maxConcepts) ? allRanked.slice(0, maxConcepts) : allRanked;
      const omitted = allRanked.length - ranked.length;
      /*
       * 没命中时，把返回项也一律标成 fallback —— 否则 hint 说"这些是兜底、别当成命中"，
       * 列表里却写着 matched=description（零星词重合造成的），模型读的是列表、不是提示。
       */
      const matches = noMatch
        ? ranked.map((item) => ({ ...item, matched: "fallback" as const, reason: "整串关键词没有命中；这条是按本体概念清单（或零星词重合）兜底给的，不代表本体内有对应概念。" }))
        : ranked;
      const valueTables = valueIndex?.size ?? 0;
      return {
        payload: {
          query,
          matches,
          /* 命中总数 = 排序后的真实条数；只有调用方自己要收窄时才会有 omitted。 */
          total_matched: allRanked.length,
          ...(omitted > 0
            ? {
              omitted,
              omitted_note: `命中一共 ${allRanked.length} 条，这里给了分数最高的前 ${ranked.length} 条，还有 ${omitted} 条没给（列表按分数排序，没给的是分数最低的那些）。要接着看就把 max_concepts 调大（最多 ${MAX_SEARCH_MATCHES}），或者用更具体的业务词 / kinds 收窄再搜 —— 别因为"只看到这些"就下"本体里没有"的结论。`,
            }
            : {}),
          hint: noMatch
            ? `「${query}」在对象类型 / 属性 / 关系类型 / 动作 / 接口 / 指标的名字、说明与已缓存的列取值里**都没有命中**。下面这些是按本体概念清单**兜底**给的（不代表本体里有对应概念），别当成命中结果，也别拿它硬凑口径。换个更贴业务的原词再试；如果确认本体内没这个概念，就如实说"本体里还没有这个口径"。`
            : "这些名字是本体里的真实定义，后续查询只能用它们。matched=name 是名字命中；matched=value 是**某列的取值**命中（bound_table + source_column 就是落点，可直接拿去 run_sql 过滤）；要字段级细节调 get_object_type。",
          ...(noMatch ? { no_match: true } : {}),
          // 表只能通过对象类型到达：明确写出来，免得模型退回"直接枚举数据源里的表"。
          note: "本平台里表只能通过对象类型到达；不要枚举数据源里的表和列，需要换角度查就用 search_schema、get_object_type。",
          ...(includeValues && !valueTables
            ? { values_note: "还没有任何列的取值画像（列画像是按天缓存的采样结果）：想按业务码值（例如「互联网专线」）检索，先对相关对象类型绑定的表调一次 get_table_ddl，画像会随表结构一起给出。" }
            : {}),
        },
        // 属性不是可寻址的实体，不做证据；类型、动作、接口、指标才是。
        evidence: matches
          .filter((match) => match.kind !== "PROPERTY")
          .map((match) => ({ kind: match.kind as "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "INTERFACE" | "METRIC", id: match.name, label: match.name })),
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
      /*
       * 没绑 / 绑飞了的来源：模式名唯一对得上一个本机资源时兜底给出资源名。
       * 否则模型只看到 data_source 是空串，会卡在"知道表名、不知道 get_table_ddl 的 data_source 填什么"。
       */
      const resourceNamesBySchema = new Map<string, string[]>();
      for (const item of context.dataSources ?? []) {
        const key = (item.schema_name ?? "").trim().toUpperCase();
        if (!key) continue;
        resourceNamesBySchema.set(key, [...(resourceNamesBySchema.get(key) ?? []), item.name]);
      }
      const sourceRoleById = new Map(sources.map((source, index) => [source.id, sourceRoleLabel(index)]));
      const properties = type.properties.map((property) => ({
        name: property.name,
        display_name: property.displayName ?? "",
        description: property.description ?? "",
        data_type: property.dataType,
        required: property.required,
        unique: property.unique,
        // 取值枚举（码值 + 含义）：口径从列注释搬到定义层，模型不用猜码值。
        ...(property.enumValues?.length ? { enum_values: property.enumValues.map((item) => ({ value: item.value, label: item.label })) } : {}),
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
       * 数量关系：声明的是「起点 → 终点」。入边是从终点这一侧看过去的，要**翻过来说**
       * （否则模型会把"一个客户有多个专线"读成"一个专线属于多个客户"，聚合就重复计数了）。
       */
      const cardinalityOf = (relation: (typeof touching)[number], reversed: boolean) => {
        const value = relation.cardinality ?? "";
        if (!value) return {};
        const from = typeNameById.get(reversed ? relation.targetEntityTypeId : relation.sourceEntityTypeId) ?? "";
        const to = typeNameById.get(reversed ? relation.sourceEntityTypeId : relation.targetEntityTypeId) ?? "";
        return { cardinality: value, cardinality_label: cardinalityLabel(value), cardinality_from_here: cardinalityPhrase(value, from, to, { reversed }) };
      };
      /*
       * 一跳关系：出边、入边分开列。模型问"A 一圈都连着谁"是最常见的追问，
       * 提前给到就省掉一次遍历；要多跳再走 traverse_object_types（最多 5 跳）。
       */
      const oneHop = {
        outgoing: touching.filter((item) => item.sourceEntityTypeId === type.id).map((item) => { const keyMapping = keyMappingsOf(item); return { relation: item.name, ...neighbor(item.targetEntityTypeId), ...(keyMapping ? { key_mapping: keyMapping } : {}), ...cardinalityOf(item, false) }; }),
        incoming: touching.filter((item) => item.targetEntityTypeId === type.id).map((item) => { const keyMapping = keyMappingsOf(item); return { relation: item.name, ...neighbor(item.sourceEntityTypeId), ...(keyMapping ? { key_mapping: keyMapping } : {}), ...cardinalityOf(item, true) }; }),
        /*
         * 接口带来的关系：实现接口就承接接口的关系约束（Palantir 语义），
         * 所以"实现方一跳能到谁"必须把它算进来 —— 否则实现方看着像孤立的类型。
         */
        via_interfaces: interfaceDerivedLinks(definition)
          .filter((link) => link.fromId === type.id || link.toId === type.id)
          .map((link) => ({ relation: link.name, via_interface: link.viaInterface, ...neighbor(link.fromId === type.id ? link.toId : link.fromId) })),
        note: "这里只列一跳，两个方向都列（关系类型是双向的，不用另建反向关系）。via_interfaces 是这个对象类型**实现接口**拿到的关系：接口的关系约束由实现方落地，对端就是约束里那个对象类型，回答连通性时要算上。key_mapping 是这条关系类型声明过的键映射（连接属性 → 该端对象类型的属性，`外键 X` 表示连接键长在对象类型上），它说明两类对象在数据上按哪几个字段对得上；没配的关系类型不带这一项，那只是还没填，不代表连不上。cardinality / cardinality_from_here 是这条关系的**数量关系**：前者是声明原样（起点 → 终点），后者是「从当前这个对象类型看过去」的说法 —— 按某个类型聚合时先看它，1:N 就说明走一次会放大，别重复计数；没标注就不带这两项。看两跳及以上用 traverse_object_types（最多 5 跳，可限定对象类型、关系类型与方向）。",
      };
      const actions = definition.actionTypes
        .filter((item) => item.scopeEntityTypeId === type.id)
        .map((item) => ({ name: item.name, code: item.code, params: item.params.map((param) => `${param.name}:${param.dataType}`) }));
      /*
       * 指标：这个对象类型上定义的业务口径。模型答"这类数怎么算 / 有没有现成口径"时直接引用它，
       * 不用再从列注释里反推 —— 单位、红冲这些边界就写在 filters / unit 里。
       */
      const metrics = (definition.metrics ?? [])
        .filter((item) => item.entityTypeId === type.id)
        .map((item) => ({
          name: item.name,
          description: describeBriefly(item.description, 120),
          aggregation: item.aggregation,
          property: item.property,
          filters: item.filters.map((filter) => `${filter.property}${filter.operator}${filter.value}`),
          dimensions: item.dimensions,
          time_property: item.timeProperty,
          unit: item.unit,
          status: item.status ?? "draft",
          owner: item.owner ?? "",
        }));
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
          metrics,
          ...(metrics.length ? { metrics_note: "metrics 是这个对象类型上定义的指标（业务口径）：aggregation + property 是怎么算，filters 是口径边界，dimensions 是能按哪些属性分组，unit 是单位。引用口径时以它为准，不要自己从列注释里另立一套。" } : {}),
          sources: sources.map((source, index) => {
            const boundName = resourceNameById.get(source.dataSourceId) ?? "";
            const schemaCandidates = boundName ? [] : (resourceNamesBySchema.get((source.schema ?? "").trim().toUpperCase()) ?? []);
            return {
              role: sourceRoleLabel(index),
              // 绑好了就用绑定的资源名；没绑（或绑飞了）时，模式名唯一对得上一个资源就兜底给出 —— 模型靠这个名字调 get_table_ddl / run_sql。
              data_source: boundName || (schemaCandidates.length === 1 ? schemaCandidates[0] : ""),
              // 让模型分清"填好了"和"还没填"：unbound 是配置缺口，不是没有数据。
              binding: boundName ? "bound" : "unbound",
              ...(boundName ? {} : { binding_note: schemaCandidates.length === 1 ? "这条来源还没正式绑定数据资源，资源名是按模式名唯一匹配兜底给的；正式出数前请补齐绑定。" : "这条来源还没绑定数据资源，也匹配不出唯一的资源；请在「对象 / 本体」页点「补齐数据资源绑定」。" }),
              schema: source.schema,
              view: source.view,
              primary_key: source.primaryKey,
              title_field: source.titleField,
            };
          }),
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
          /*
           * 每项按固定列序：
           * nodes = [对象类型名, 分组, 跳数, 描述, [绑定的表]]；
           * edges = [关系类型名, 起点, 终点, 跳数, 经哪个接口, 基数, 键映射]（没有经接口 / 没标基数 / 没配键映射就是空串）。
           */
          nodes: traversal.nodes.map((node) => [node.name, node.group, node.hop, node.description, node.bound_tables]),
          edges: traversal.edges.map((edge) => [edge.relation, edge.from, edge.to, edge.hop, edge.via_interface ?? "", edge.cardinality ?? "", edge.key_mapping ?? ""]),
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
      const table = String(args.table ?? "").trim();
      if (!table) throw new Error("table 不能为空。");
      const requestedSource = String(args.data_source ?? "").trim();
      let record: DataSourceRecord;
      if (requestedSource) {
        record = resolveDataSource(context, requestedSource);
      } else {
        /*
         * 不给 data_source 时按「模式.表」自动定位。模型常常只拿到一个表名，
         * 硬要它先反查出资源名是多一轮往返（而且资源名以前只能从概念清单末尾人工读）。
         */
        const dot = table.lastIndexOf(".");
        const schemaPart = dot > 0 ? table.slice(0, dot).trim() : "";
        const tablePart = (dot > 0 ? table.slice(dot + 1) : table).trim();
        const candidates = dataSourcesForTable(definition, context.dataSources ?? [], schemaPart, tablePart);
        if (!candidates.length) {
          throw new Error(`没有指定 data_source，也定位不出「${table}」属于哪个已登记的数据资源：本体里没有对象类型绑到这张表，也没有模式名对得上的资源。先确认表名（模式.表）有没有写错，或用 search_schema 反查。`);
        }
        if (candidates.length > 1) {
          throw new Error(`没有指定 data_source，「${table}」在多个数据资源里都对得上：${candidates.map((item) => `「${item.name}」`).join("、")}。请明确指定一个。`);
        }
        record = candidates[0];
      }
      const startedAt = Date.now();
      const { openDataSource } = await import("@/lib/data-sources");
      const connector = await openDataSource(record);
      if (!connector.describeTableDdl) throw new Error(`数据资源「${record.name}」是 ${record.kind}，不支持查看表结构。`);
      const ddl = await connector.describeTableDdl({ name: table, schema: record.schema_name || undefined });
      /*
       * 列画像：只对**被对象类型绑定的表**做，按天缓存、采样而非全表统计。
       * 画像失败（大表超时、没绑定、驱动不支持）不能连带把表结构也搞失败 —— 它只是加分项。
       */
      // 本机已登记的资源 id：把「指向已删资源的悬空来源」也算成待补，见 sourceTableBinding。
      const knownSourceIds = (context.dataSources ?? []).map((item) => item.id);
      let profile: Awaited<ReturnType<typeof ensureColumnProfile>> | null = null;
      try {
        profile = await ensureColumnProfile({ definition, record, view: { schema: ddl.schema || record.schema_name, name: ddl.name }, refresh: args.refresh === true, knownSourceIds });
      } catch (error) {
        profile = { profile: null, cached: false, warning: `列画像没取到（表结构照常可用）：${error instanceof Error ? error.message : "未知错误"}` };
      }
      // 属性声明的取值枚举 vs 实际采样：对不上（典型是「注释说非空即全球通、实际只有 0/1」）当场点破。
      const enumWarnings = profile?.profile
        ? enumProfileWarnings(definition, profile.profile.schema, profile.profile.table, profile.profile.columns)
        : [];
      /*
       * 反向引用：这张表被哪些对象类型绑着、各映射了哪几列。
       * 表只能通过对象类型到达，所以"某个表名没人认领"时这就是唯一的排错线索。
       */
      const objectKind = ddl.schema || record.schema_name;
      const boundObjectTypes = objectTypesBoundTo(definition, record.id, objectKind, ddl.name, knownSourceIds);
      return {
        payload: {
          data_source: record.name,
          data_source_kind: record.kind,
          // 这一步常常要几秒（远端 Oracle 读数据字典 + 采样），如实给出来让模型知道贵不贵。
          elapsed_ms: Date.now() - startedAt,
          schema: ddl.schema,
          table: ddl.name,
          object_kind: ddl.kind,
          ddl_source: ddl.source,
          ddl: ddl.ddl,
          notes: ddl.notes,
          /*
           * 每项按固定列序：[对象类型名, 它映射到这张表的列, 来源角色, 这个对象类型的主键列, 映射列总数, 绑定状态]。
           * 第 5 项是映射列总数，和第 2 项（列清单）一起给：**清单现在给全、不截断**（2026-10-10 用户口径），
           * 两者应当一致 —— 真出现不一致就说明某一处又加了上限，那是 bug。
           * 第 6 项 binding 空串 = 绑好了；「未绑定数据资源」= dataSourceId 还没绑到本机资源（导入后没补齐），
           * 表身份是靠「模式.表」兜底认出来的 —— 要给用户指这条路，别把它当成"表不存在"。
           */
          bound_object_types: boundObjectTypes.map((item) => [item.object_type, item.mapped_columns, item.source_role, item.primary_key, item.mapped_column_count, item.binding === "bound" ? "" : "未绑定数据资源"]),
          ...(boundObjectTypes.some((item) => item.binding !== "bound")
            ? { bound_object_types_binding_note: "上面标了「未绑定数据资源」的来源，dataSourceId 还没绑到本机资源（导入后没补齐绑定）：表身份是靠「模式.表」兜底认出来的。要跑数先到「对象 / 本体」页点「补齐数据资源绑定」。" }
            : {}),
          bound_object_types_note: boundObjectTypes.length
            ? "这张表被上面这些对象类型绑定：object_type 是对象类型名，mapped_columns 是它映射到这张表的列，source_role 说明它是主来源还是补充来源。primary_key 是**本体建模声明的对象主键**，不是数据库唯一约束 —— 数据到底唯不唯一看 column_profile 的 distinct 与 sample_size。要字段细节与关系用 get_object_type。"
            : "没有任何对象类型绑定这张表。本平台里表只能通过对象类型到达：先确认表名（模式.表）有没有写错，再用 search_schema / get_object_type 反查正确的那张表；别把这张表当成「本体里的对象」。",
          ...(ddl.truncatedAt ? { truncated_at: ddl.truncatedAt, truncated_note: `原始语句超过 ${ddl.truncatedAt} 字符，上面是截断后的。` } : {}),
          ...(profile?.profile
            ? {
              column_profile: {
                sampled_at: profile.profile.sampledAt,
                cached: profile.cached,
                sample_size: profile.profile.sampleSize,
                // 每列按固定列序：[列名, 取值种数, 空值比例, 取值清单]；高基数列没有第 4 项（没存取值）。
                columns: profile.profile.columns.map((column) => (column.highCardinality
                  ? [column.name, column.distinct, column.nullRate]
                  : [column.name, column.distinct, column.nullRate, column.values])),
                distinct_basis: "采样（非全表精确值）",
                note: `列画像是**采样**结果（前 ${profile.profile.sampleSize} 行，按天缓存），distinct 是采样里的取值种数、不是全表精确统计；high_cardinality=true 的列没存取值。distinct 等于 sample_size 只能说**采样内**唯一，不能推断全表唯一 / 数据库约束。写 WHERE 时用它确认码值，别拿它当精确基数。`,
              },
            }
            : {}),
          ...(profile?.warning ? { column_profile_warning: profile.warning } : {}),
          ...(enumWarnings.length ? { enum_profile_warnings: enumWarnings } : {}),
          ...(profile?.profile?.coverage?.length
            ? {
              sample_coverage: profile.profile.coverage,
              sample_coverage_note: "sample_coverage 是这个日期列采样覆盖到的日期与每日期行数。column_profile 的取值清单是把这些日期**混在一起**统计的：某个取值只说明采样里出现过，不代表每个日期都有（反过来，清单里没有也不代表那天没有）。按日期过滤前先用 run_sql 确认那天真有这个值。",
            }
            : {}),
          ...(profile?.profile?.columns.some((column) => column.padded)
            ? {
              padded_columns: profile.profile.columns.filter((column) => column.padded).map((column) => column.name),
              padded_columns_note: "这些列的取值带首尾空格（Oracle CHAR 右填充）：比较 / join 记得 TRIM，漏了就静默丢行。",
            }
            : {}),
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
      const startedAt = Date.now();
      const { openDataSource } = await import("@/lib/data-sources");
      const connector = await openDataSource(record);
      if (!connector.runReadOnlyQuery) throw new Error(`数据资源「${record.name}」是 ${record.kind}，不支持 SQL 查询。`);
      const result = await connector.runReadOnlyQuery(sql, { limit });
      return {
        payload: {
          data_source: record.name,
          data_source_kind: record.kind,
          // 这次查询实际花了多久：模型据此判断"这条语句贵不贵、下次要不要合并成一条 CTE"。
          elapsed_ms: Date.now() - startedAt,
          schema: record.schema_name || "",
          // 语句被平台改写过（去尾分号、套行数上限）才回显；与入参一致时不必重复模型自己刚发的东西。
          ...(result.statement.trim() === sql.trim() ? {} : { executed_statement: result.statement }),
          returned: result.rows.length,
          row_limit: result.rowLimit,
          columns: result.columns,
          /*
           * rows 是**二维数组**，每行按 columns 的顺序排列 —— 列名只在 columns 里出现一次。
           * 信息与"每行一个对象"完全等价，只是行里不再重复一遍键名（实测 100 行 × 5 列省 62%）。
           */
          rows: result.rows.map((row) => result.columns.map((column) => row[column])),
          truncated: result.truncated,
          // 截断了就要说人话：模型只看到一个 true 时，
          // 很容易把"前 100 行"当成"一共就这么多"，进而下一个错结论。
          ...(result.truncated
            ? { truncation_note: `结果已被截断：只返回了前 ${result.rows.length} 行（本次上限 ${result.rowLimit}），表里还有更多行。要全貌就用更精确的 WHERE、聚合或更强的取数上限重新查；把"前 ${result.rows.length} 行"当成全量会得出错误结论。` }
            : {}),
          note: readOnlyPolicyNote(record.kind),
          // 只读事务起没起得来要如实报：起不来时只剩语句检查在挡，不能让人以为库里有保险。起得来就不必每次说。
          ...(result.readOnlyTransaction ? {} : { read_only_transaction: false, warning: "这个驱动起不了只读事务，本次只有语句检查在挡，请只读使用。" }),
        },
        // 查询出来的行不是本体里的对象，不能当"证据"引用；要引用对象请走本体那边。
        evidence: [],
      };
    }

    /*
     * 实例工具：走**对象服务**（索引优先，没有就按数据来源回源），
     * 于是模型看到的对象与对象页/对象服务接口是同一批、同一套身份。
     */
    case "query_object_instance": {
      const typeName = String(args.type_name ?? "");
      if (!typeName) throw new Error("type_name 不能为空。");
      if (!definition.entityTypes.some((item) => item.name === typeName)) throw new Error(`本体里没有对象类型「${typeName}」。`);
      const limit = clamp(args.limit, 20, 50);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : null;
      let result: { rows: ObjectRecord[]; origin: string; total: number | null; warnings: string[] } = {
        rows: [],
        origin: "none",
        total: null,
        warnings: [],
      };
      try {
        result = await queryObjects(objectContextOf(context), { entityType: typeName, text: search ?? undefined, limit });
      } catch (error) {
        result.warnings = [error instanceof Error ? error.message : "对象服务读取失败。"];
      }
      // 对象服务没有这条数据来源、索引里也没有时，退回图库里已发布的那份对象，别让工具整个失败。
      if (!result.rows.length && result.origin === "none") {
        const nodes = await store.listEntities({ label: typeName, search, limit });
        result = {
          rows: nodes.slice(0, limit).map((node) => ({
            objectId: node.id,
            entityType: node.labels[0] ?? typeName,
            primaryKey: {},
            title: "",
            properties: node.properties,
            origin: "index" as const,
            objectRef: node.id,
            warnings: [],
          })),
          origin: nodes.length ? "index" : "none",
          total: nodes.length,
          warnings: result.warnings,
        };
      }
      const instances = result.rows.slice(0, limit).map(instanceOf);
      return {
        payload: {
          object_type: typeName,
          returned: instances.length,
          instances,
          source: result.origin === "source" ? "数据资源（按主键回源，未落库）" : result.origin === "index" ? "本体索引" : "无",
          total_matched: result.total,
          note: "回答时只引用上面出现过的 object_id；_origin 为 source 的对象是实时读业务库拿到的，本体里没有它的副本。",
          warnings: result.warnings,
        },
        evidence: instances.map((item) => ({ kind: "OBJECT" as const, id: item._instance_identity.object_id, label: item._instance_identity.title || item._instance_identity.object_type })),
      };
    }

    case "query_instance_subgraph": {
      const typeNames = Array.isArray(args.type_names) ? args.type_names.map(String) : [];
      const relationshipTypes = Array.isArray(args.relationship_types) ? args.relationship_types.map(String) : [];
      const nodeLimit = clamp(args.node_limit, 60, 200);
      const search = typeof args.search === "string" && args.search.trim() ? args.search.trim() : null;
      const warnings: string[] = [];
      // 节点走对象服务（索引 / 数据源），关系仍来自本体图里已有的关系实例。
      const allScopeTypes = typeNames.length ? typeNames : definition.entityTypes.map((item) => item.name);
      const scopeTypes = allScopeTypes.slice(0, 12);
      // 一次只取前 12 个类型是**取数的量级控制**：这次没取的类型要说出来，别让模型以为本体里没有它们。
      if (allScopeTypes.length > scopeTypes.length) {
        warnings.push(`这次只从 ${scopeTypes.length} 个对象类型里取对象（共 ${allScopeTypes.length} 个可取的）：没取的 ${allScopeTypes.length - scopeTypes.length} 个是「${allScopeTypes.slice(scopeTypes.length, scopeTypes.length + 5).join("、")}${allScopeTypes.length - scopeTypes.length > 5 ? " 等" : ""}」。要指定取哪些就传 type_names。`);
      }
      const perType = Math.max(5, Math.ceil(nodeLimit / Math.max(1, scopeTypes.length)));
      const objectContext = objectContextOf(context);
      const collected: ObjectRecord[] = [];
      for (const typeName of scopeTypes) {
        try {
          const result = await queryObjects(objectContext, { entityType: typeName, text: search ?? undefined, limit: perType });
          collected.push(...result.rows);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`${typeName}：${error instanceof Error ? error.message : "读取失败。"}`);
        }
      }
      const records = collected.slice(0, nodeLimit);
      const nodeIds = new Set(records.map((record) => record.objectId));
      const graph = await store.readGraph({ labels: typeNames, relationshipTypes, search, nodeLimit: nodeLimit * 3 });
      const graphRelationships = graph.relationships.filter((item) => nodeIds.has(item.source) && nodeIds.has(item.target));
      /*
       * 关系类型配了数据来源（D2）就按对象主键回业务库取边 —— 否则"数据源来的节点没有连线"
       * 会让模型以为 AB 之间没关系。按对象类型分组问，一个类型一次查询。
       */
      const liveLinks: { id: string; type: string; source: string; target: string }[] = [];
      const seedByType = new Map<string, Record<string, string>[]>();
      for (const record of records) {
        if (!Object.keys(record.primaryKey).length) continue;
        seedByType.set(record.entityType, [...(seedByType.get(record.entityType) ?? []), record.primaryKey]);
      }
      for (const [entityType, keys] of seedByType) {
        try {
          const result = await queryLinks(objectContext, { seed: { entityType, keys }, relationshipType: relationshipTypes[0], limit: nodeLimit });
          for (const link of result.links) {
            if (!nodeIds.has(link.source.objectId) || !nodeIds.has(link.target.objectId)) continue;
            liveLinks.push({ id: link.linkRef, type: link.relationshipType, source: link.source.objectId, target: link.target.objectId });
          }
        } catch (error) {
          warnings.push(`${entityType} 的关系实例读取失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      const seenRelationship = new Set<string>();
      const relationships = [...graphRelationships.map((item) => ({ id: item.id, type: item.type, source: item.source, target: item.target })), ...liveLinks]
        .filter((item) => (seenRelationship.has(item.id) ? false : (seenRelationship.add(item.id), true)))
        .slice(0, nodeLimit * 2);
      // 图库里还有、但对象服务没取到的节点（例如没绑来源也没进索引的旧对象）也一并带上，别凭空丢信息。
      for (const node of graph.nodes) {
        if (records.length >= nodeLimit) break;
        if (nodeIds.has(node.id)) continue;
        nodeIds.add(node.id);
        records.push({
          objectId: node.id,
          entityType: node.labels[0] ?? "",
          primaryKey: {},
          title: "",
          properties: node.properties,
          origin: "index",
          objectRef: node.id,
          warnings: [],
        });
      }
      const nodes = records.map(instanceOf);
      return {
        payload: {
          node_count: nodes.length,
          relationship_count: relationships.length,
          nodes,
          relationships: relationships.map((relationship) => ({
            _instance_identity: { relationship_id: relationship.id, type: relationship.type },
            source_id: relationship.source,
            target_id: relationship.target,
          })),
          note: "节点可能来自数据源（_origin=source，实时读取、本体里没有副本）也可能来自本体索引；关系来自两处：本体索引里已存在的关系实例，以及**配了数据来源的关系类型**按对象主键回业务库取到的边。只有端点对象也在结果里的边才会带上。",
          warnings,
        },
        evidence: [
          ...nodes.map((node) => ({ kind: "OBJECT" as const, id: node._instance_identity.object_id, label: node._instance_identity.title })),
          ...relationships.map((relationship) => ({ kind: "RELATIONSHIP" as const, id: relationship.id, label: relationship.type })),
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

    case "list_metrics": {
      const typeName = typeof args.type_name === "string" && args.type_name.trim() ? args.type_name.trim() : null;
      const metricName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : null;
      const statusFilter = typeof args.status === "string" && args.status.trim() ? args.status.trim() : null;
      const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      const metrics = (definition.metrics ?? [])
        .filter((item) => (!typeName || typeNameById.get(item.entityTypeId) === typeName) && (!metricName || item.name === metricName) && (!statusFilter || (item.status ?? "draft") === statusFilter))
        .map((item) => ({
          name: item.name,
          description: item.description,
          scope_object_type: typeNameById.get(item.entityTypeId) ?? "",
          aggregation: item.aggregation,
          property: item.property,
          /** 口径边界：一条指标"算哪些行"由它决定（例如只看互联网专线、排除红冲）。 */
          filters: item.filters.map((filter) => ({ property: filter.property, operator: filter.operator, value: filter.value })),
          dimensions: item.dimensions,
          time_property: item.timeProperty,
          unit: item.unit,
          /** verified = 已验收可直接引用；draft = 还没定稿（老快照没这个字段，按 draft 算）。 */
          status: item.status ?? "draft",
          /** 这条口径的负责人 / 责任团队。 */
          owner: item.owner ?? "",
          tags: item.tags,
        }));
      return {
        payload: {
          metrics,
          note: "指标只描述业务口径（怎么算），不是某一次查询的结果。要出数就按 aggregation + property + filters 落成只读 SQL 走 run_sql；scope_object_type 是它作用的对象类型，绑定的表在 get_object_type 里。status=verified 才算已验收口径；draft 是还没定稿的（老快照默认也算 draft），引用前先跟用户确认，别把测试残留 / 配置示例当正式口径。",
        },
        evidence: metrics.map((metric) => ({ kind: "METRIC" as const, id: metric.name, label: metric.name })),
      };
    }

    default:
      throw new Error(`没有叫「${name}」的工具。`);
  }
}
