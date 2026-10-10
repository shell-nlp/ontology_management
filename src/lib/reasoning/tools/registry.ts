import { type DataSourceRecord } from "@/lib/datasource/types";
import { type GraphStore, type RuntimeTypeSet } from "@/lib/framework/graph/types";
import { type OntologyDefinition } from "@/lib/ontology";
import { type ToolSpec } from "@/lib/reasoning/types";

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

export type ConceptKind = "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "PROPERTY" | "INTERFACE" | "METRIC";

/** 允许在 search_schema 的 kinds 里出现的取值（从类型定义里取一份运行时白名单）。 */
export const CONCEPT_KINDS: ConceptKind[] = ["OBJECT_TYPE", "RELATION_TYPE", "ACTION", "PROPERTY", "INTERFACE", "METRIC"];

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
export const DEFAULT_SEARCH_MATCHES = 50;

export const MAX_SEARCH_MATCHES = 1000;

/** 「取数行数上限」留空时的兜底：一次最多取这么多行，防止一条语句把内存拉爆。 */
export const SQL_ROW_CEILING = 5000;

/**
 * run_sql 自己的默认行数（模型不传 limit 时用它）。
 * 与连接器的 `DEFAULT_QUERY_ROWS` 保持一致：**默认 100 行**，
 * 超过就靠多取一行判出来，返回里标 `truncated: true` 并附一段人话提示。
 */
export const DEFAULT_SQL_ROWS = 100;

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
  {
    name: "run_query",
    description:
      '按本体查询 DSL 执行只读查询，是结构化问数的优先入口。query 只使用对象类型、属性、关系类型、指标和参数，不接受 SQL、表名、列名。结构示例：{"version":"1.0","kind":"aggregate","from":{"object_type":"对象类型名"},"relationships":[{"alias":"area","type":"关系类型名","direction":"forward","optional":true}],"where":{"and":[{"field":{"alias":"root","property":"属性名"},"op":"eq","value":{"param":"p"}}]},"select":[{"field":{"alias":"root","property":"维度名"},"as":"维度"},{"metric":"指标名","as":"结果"}],"group_by":[{"alias":"root","property":"维度名"}],"order_by":[{"ref":"结果","direction":"desc"}],"limit":100}。DSL 暂不支持或需要排障时，仍可使用 run_sql。',
    parameters: {
      type: "object",
      properties: {
        query: { type: "object", description: "本体查询 DSL JSON（version / kind / from / where / select / group_by / order_by / limit）" },
      },
      required: ["query"],
    },
  },
  /*
   * 两个实例工具：2026-09-14 曾用 `disabled` 把它们挡在模型与 MCP 之外；2026-09-19 对象服务落地后
   * 已撤销该标记（`disabled` 现在是"平台级停用"的口子，当前没有任何工具在用）。
   * 它们现在由工具开关控制：出厂默认关闭（`tool-policy.ts` 的 `DEFAULT_DISABLED_TOOLS`），
   * 管理员可在「MCP 调试」里按全局默认或按本体打开。
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
