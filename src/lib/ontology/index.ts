import { z } from "zod";
import { LEGACY_PRIMARY_SOURCE_ID } from "@/lib/ontology/sources";
import { MODEL_DATA_TYPES } from "@/lib/shared/common/model-data-type";
import { entityDictionarySchema, dictionaryIssues } from "./dictionaries";

/**
 * 本体定义（类 / 关系类型 / 属性规则 / 动作 / 规则）。
 *
 * 这里只保留与图数据库无关的定义结构。落地到具体图库的读写能力
 * （校验必填、同步唯一约束与索引、整体替换图数据）由
 * @/lib/graph 的 GraphStore 适配器实现，不绑定任何一种图库的查询语言。
 *
 * 动作（actionTypes）与规则（rules）是本体的一等公民，不是某个类的字段：
 * 一个动作可以跨多个类写入，规则挂在动作上拦截写入。
 * 具体执行语义见 @/lib/action-engine。
 */
export const propertyDataTypeSchema = z.enum(MODEL_DATA_TYPES);

const propertySchema = z.object({
  /** 机器名：写入图库、接口与数据列映射都用它，改它会牵动多处，所以单独放。 */
  name: z.string().trim().min(1).max(120),
  /**
   * 界面上给人看的名字（Palantir 的 property display name）。
   * 数据列名往往是 STATIS_DATE 这种，显示名才是「统计日期」。留空就退回 name。
   */
  displayName: z.string().trim().max(120).default(""),
  /**
   * 这个属性是什么、口径怎么算。导入外部本体时会带上原文说明 ——
   * 外部文档里的取值枚举（例如产品分类的一长串编码）常常有几百字，所以上限放到 2000；
   * 卡在 300 只能靠截断，那等于静默丢原文。
   */
  description: z.string().max(2000).default(""),
  /**
   * 取值枚举（码值 + 含义）：把「1=全球通」这种只写在列注释里的口径搬到定义层。
   * search_schema 会把 label 当取值命中，模型不用再猜码值；get_object_type 原样带给模型。
   */
  enumValues: z.array(z.object({
    value: z.string().trim().min(1).max(200),
    /** 给人看 / 给模型读的含义；只写码值不写含义也行。 */
    label: z.string().trim().max(200).default(""),
  })).max(200).optional(),
  dataType: propertyDataTypeSchema,
  required: z.boolean().default(false),
  /**
   * 这个属性是不是对象类型主键的一部分（勾多个 = 复合主键）。
   * 绑了数据来源的类型以来源声明的 `sources[].primaryKey` 列为准；
   * 这条标记给**没绑来源**的对象类型认身份用（导入外部本体时主键列就打上它）。
   */
  primaryKey: z.boolean().default(false),
  /** 加这一项之前主键标记存在 `unique` 上（沿用「必填 + 唯一」的导入约定）；读进来折成 `primaryKey`，老快照不用迁移。 */
  unique: z.boolean().optional(),
  indexed: z.boolean().default(false),
  /** 这个属性的值来自数据源里的哪一列；缺省或空表示还没映射（老快照里没有这一项）。 */
  sourceField: z.string().trim().max(200).optional(),
  /**
   * 这个属性取自哪一份来源（`entityTypes[].sources[].id`）。
   * 空表示主来源；加多来源之前的老快照没有这一项，读出来也按主来源算。
   */
  sourceId: z.string().trim().max(64).optional(),
}).transform(({ unique, ...property }) => ({
  ...property,
  primaryKey: property.primaryKey || unique === true,
}));

/**
 * 类的一份数据来源：一张表或视图，属性按列映射。
 * 对象不单独绑表 —— 一个对象就是这张表里的一行，所以绑定写在类上。
 * 空 dataSourceId 表示这份来源还没接上（纯建模也能用）。
 */
/**
 * 取数口径的**生成参数**（可选）。
 *
 * 为什么留这一份：口径的正文是 SQL，规则一存，界面就能回显人话（「按 CUST_ID 取最新一行（依据 STATIS_DATE）」）、
 * 平台也能校验「存下来的 SQL 和这条规则还是不是一回事」（手改过 SQL 就说清楚，别让界面写着最新、跑的却是别的）。
 * **不是必填**：口径允许手写 SQL，那时 `rule` 为 `null` —— 逃生舱一直留着。
 */
export const entitySourceRuleSchema = z.object({
  /** 分组键：一个对象对应哪几列唯一（一般就是对象主键的列，复合主键就是多列）。 */
  keyColumns: z.array(z.string().trim().max(200)).default([]),
  /** 取值依据列：按它取最新 / 最早的那一行。 */
  orderColumn: z.string().trim().max(200).default(""),
  direction: z.enum(["DESC", "ASC"]).default("DESC"),
});

export const entitySourceSchema = z.object({
  /** 这份来源在类里的标识：属性映射靠它指回来。只在本类内有意义，不是数据库对象。 */
  id: z.string().trim().min(1).max(64),
  dataSourceId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /**
   * 来源形态：
   * - `PHYSICAL`：直接读库里的表 / 视图（`view`，现状）；
   * - `DERIVED`：读一段**只读取数口径**（`sql`）—— 去重、聚合、拼装写在口径里，
   *   对象读的是口径的结果而不是原始行。源数据里主键不唯一时，正确做法就是这一档。
   *
   * 口径只允许 SELECT / WITH 开头（服务端 `assertReadOnlySql` 把关），执行时包成子查询。
   */
  kind: z.enum(["PHYSICAL", "DERIVED"]).default("PHYSICAL"),
  /** 读取路径：AUTO = ODS 完整可用时优先、否则源库；DIRECT = 始终源库；ODS = 必须读 ODS。 */
  readMode: z.enum(["AUTO", "DIRECT", "ODS"]).default("AUTO"),
  /** DERIVED 的取数口径：必须输出 `primaryKey` 里的列（可写 `*`，但隐式列会让口径跟源表结构漂移）。 */
  sql: z.string().trim().max(20000).default(""),
  /** 这条口径如果是「按规则生成」出来的，把生成参数留一份（手写 SQL 就是 null）。 */
  rule: entitySourceRuleSchema.nullable().default(null),
  /** 表/视图所在的容器：PG 的模式、Oracle 的模式；MySQL 留空。 */
  schema: z.string().trim().max(200).default(""),
  /**
   * 表 / 视图名。
   *
   * `PHYSICAL` 时它就是**取数对象**；`DERIVED` 时不参与取数（取数走 `sql`），而是这段口径的
   * **参考表**：界面按它拿真实列清单来生成 / 校验口径（挑"取哪一行"的依据列）。所以口径来源**也要留着它**。
   */
  view: z.string().trim().max(200).default(""),
  /**
   * 主来源：对象身份取这几列，支持复合主键；
   * 补充来源：这几列按顺序和主来源的主键列一一对齐，就是连接条件。
   */
  primaryKey: z.array(z.string().trim().max(200)).default([]),
  /** 对象标题取这一列，等价于 Palantir 的 title property；只有主来源用得上。 */
  titleField: z.string().trim().max(200).default(""),
});

/** 加多来源之前的老绑定：一个类只有一份来源，读进来当成主来源。 */
const legacyEntitySourceSchema = entitySourceSchema.omit({ id: true });

/**
 * 逻辑分组（业务域）：把对象类型按域归堆，图谱里按组画框。
 *
 * 存成一条记录而不是类上的一个字符串，是为了颜色能定下来、以后要改名也只有一处要改。
 * 分组**不参与推理**，纯展示层的归类。
 */
/**
 * 接口的关系约束（Palantir 的 interface link type constraint）。
 *
 * 接口只说"实现我的对象类型必须有一条第（起点=自己）这样的关系"，
 * 具体挂哪一条关系类型由实现方决定（关系类型本身写在 entityTypes / relationshipTypes 上）。
 */
export const interfaceLinkConstraintSchema = z.object({
  id: z.string().uuid(),
  /** 约束名：接口视角下这条关系叫什么（Palantir 的 API name）。 */
  name: z.string().trim().min(1).max(100),
  description: z.string().max(300).default(""),
  /** 另一端是具体对象类型还是另一个接口。 */
  targetKind: z.enum(["OBJECT_TYPE", "INTERFACE"]).default("OBJECT_TYPE"),
  targetId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** ONE = 每个实现对象应当只连一个；MANY = 可以连任意个。图库不做基数约束，只用于建模与提示。 */
  cardinality: z.enum(["ONE", "MANY"]).default("MANY"),
  /** 必填的约束：实现方没有满足它的关系类型时，发布前校验会拦下来。 */
  required: z.boolean().default(false),
});

/**
 * 接口（Palantir 的 Interface）：描述一类对象类型"长什么样、能干什么"的抽象契约。
 *
 * 与对象类型的区别（Palantir 的说法）：对象类型是具体的 —— 有属性、绑了数据、能被实例化；
 * 接口是抽象的 —— 只有属性与约束，不绑数据、不能直接实例化，只能由某个对象类型实现它。
 * 一个接口可以被多个对象类型实现，也可以继承多个别的接口（多继承）。
 *
 * 属性沿用 `propertySchema`：接口属性只关心 name / displayName / description / dataType / required，
 * `primaryKey` / `indexed` / `sourceField` 对接口没有意义（接口不绑数据），界面也不展示。
 */
/** 接口上的一条动作约束：实现方必须有一条动作跟它对上。 */
export const interfaceActionConstraintSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().max(100).default(""),
  description: z.string().max(500).default(""),
  required: z.boolean().default(true),
});

export const interfaceTypeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(""),
  /** 从无数据源的对象类型提取出来的接口；保留原对象类型作为底层关系兼容影子。 */
  promotedFromEntityTypeId: z.union([z.string().uuid(), z.literal("")]).optional(),
  /** 本接口自己声明的属性（不含继承来的）。required = 实现方必须提供同名属性。 */
  properties: z.array(propertySchema).default([]),
  /** 继承的接口：本接口继承谁；空数组表示没有父接口。可以写多个。 */
  extends: z.array(z.string().uuid()).default([]),
  linkConstraints: z.array(interfaceLinkConstraintSchema).default([]),
  /**
   * 动作约束（对齐 Palantir 的 interface action type constraints）：
   * 接口可以说"实现我的对象类型，必须有一个动作能干这件事"，实现方把它映射到自己的一条 actionType 上。
   * 和属性/关系约束一样，`required` 的没映射就不算实现，发布前校验会拦。
   */
  actionConstraints: z.array(interfaceActionConstraintSchema).default([]),
});
export const conceptGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  /** 分组框的强调色；留空就按它在清单里的位置取一个调色板色。 */
  color: z.string().trim().max(32).default(""),
});

/**
 * 指标（对齐 Palantir 的 Metric）：把一条业务口径固化成定义，而不是让它散在列注释里。
 *
 * 一条指标回答「这个数怎么算」：作用在哪个对象类型上、按哪个属性聚合、固定过滤是什么、
 * 能按哪些维度看、单位是什么。它**只描述口径、不存数** —— 真实数值由模型或应用按这份定义
 * 去对象类型绑定的源表查（本体这一层不推理实例）。
 *
 * 为什么要有它：像「互联网专线条数」「短彩信欠费金额」这类问题，答案原来是让模型从
 * 属性注释里反推（`ZX_COUNT` 要 SUM 还是 COUNT、欠费要不要含红冲）——口径读一次就定下来，
 * 比每次重新推一遍靠谱。
 */
/**
 * 指标「怎么算」的那一半。**可以为空** —— 空 = 只描述、不出数（见 metricSchema）。
 *
 * 过滤 / 维度 / 时间维度都挂在这里而不是挂在指标上：它们都是"计算的一部分"，
 * 没有计算口径时它们不存在，这样"填了维度却没选计算落点"这类半截状态在结构上就不可能。
 */
export const metricCalculationSchema = z.object({
  /** 计算落在哪个对象类型上；**必须是这条指标关联的类型之一**（发布前校验会拦不一致的）。 */
  entityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** 聚合方式。COUNT 且 property 为空 = 数行数。 */
  aggregation: z.enum(["SUM", "COUNT", "COUNT_DISTINCT", "AVG", "MIN", "MAX"]).default("COUNT"),
  /** 被聚合的属性名；COUNT 行数时留空。 */
  property: z.string().trim().max(120).default(""),
  /**
   * 固定过滤：口径的一部分（例如「只看互联网专线」「排除红冲」）。
   * 值一律按字符串存，怎么比较交给下游按属性的数据类型处理。
   */
  filters: z.array(z.object({
    property: z.string().trim().min(1).max(120),
    operator: z.enum(["EQ", "NE", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN", "CONTAINS", "IS_NULL", "NOT_NULL"]).default("EQ"),
    value: z.string().max(500).default(""),
  })).default([]),
  /** 可以按哪些属性分组看（地市、产品、月份……）。 */
  dimensions: z.array(z.string().trim().max(120)).max(20).default([]),
  /** 时间维度：按哪个属性看趋势；留空表示不是时序指标。**它同时算一个可用维度**（不用再重复勾一次）。 */
  timeProperty: z.string().trim().max(120).default(""),
});

/** 指标的正文形状：**关联（多个对象类型）+ 计算（可空）**。 */
const metricBodySchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  /** 这条指标量的是什么、口径边界是什么。 */
  description: z.string().max(500).default(""),
  /**
   * **关联**的对象类型（多个）：「这个指标和谁有关」。
   * 关联决定它出现在哪些类型的上下文里（检索、对象类型详情、list_metrics 的过滤），
   * **不等于能算** —— 能不能出数只看 `calculation`。
   */
  entityTypeIds: z.array(z.string().uuid()).max(50).default([]),
  /**
   * **怎么算**；`null` = 只描述、不出数（合法形态：模型能讲清这个口径是什么，但不能拿它出数）。
   * 要用它出数就必须配上计算口径，且落点必须是上面关联的类型之一。
   */
  calculation: metricCalculationSchema.nullable().default(null),
  /** 单位类型与单位，原样保留外部定义（bkn 的 unit_type / unit）。 */
  unitType: z.string().trim().max(32).default(""),
  unit: z.string().trim().max(32).default(""),
  /**
   * 状态位：verified = 已验收、可以直接引用；draft = 还没定稿（测试残留、配置示例、新口径都先落这里）。
   * 模型靠它分辨「哪条口径可信」，不用每次把描述读完再自己判断。
   */
  status: z.enum(["draft", "verified"]).default("draft"),
  /** 这条口径的负责人 / 责任团队：出数有疑问找谁。 */
  owner: z.string().trim().max(120).default(""),
  tags: z.array(z.string().trim().max(32)).max(12).default([]),
});

/**
 * 指标。**关联（多类型）与计算（可空）是两件事**，老快照里它们被挤在一个 `entityTypeId` 字段上，
 * 这里按"原始输入里有没有新字段"判断新老，老形状折成新形状 —— 老快照不用迁移（和 `unique → primaryKey` 同一手法）。
 */
export const metricSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const { entityTypeId: legacyScope, aggregation, property, filters, dimensions, timeProperty, ...rest } = value;
  if ("entityTypeIds" in value || "calculation" in value) return rest;
  const scope = typeof legacyScope === "string" ? legacyScope.trim() : "";
  return {
    ...rest,
    entityTypeIds: scope ? [scope] : [],
    calculation: scope ? { entityTypeId: scope, aggregation, property, filters, dimensions, timeProperty } : null,
  };
}, metricBodySchema);

/**
 * 关系类型的键映射：这条关系类型靠哪些属性（列）接到某一个对象类型上。
 *
 * 一行 = 关系类型这一侧的连接属性（连接表的列名）→ 对象类型这一侧的属性。
 * 写多行就是复合键。对齐 Palantir 的 link type Key：
 * - 多对多（有一张连接表）：连接表的列 → 两端对象类型的主键属性；
 * - 一对一 / 多对一（外键长在对象类型上）：`linkProperty` 留空，直接写那个外键属性。
 * 空数组 = 只声明了业务语义，没说数据上怎么连 —— 纯类型层建模可以不填，发布前不会因此被拦。
 */
export const relationshipKeyMappingSchema = z.object({
  /**
   * 关系类型这一侧的连接属性 / 连接列名。
   * 留空表示这一侧的连接键长在对象类型自己身上（外键式关系类型），两侧按顺序一一对应。
   */
  linkProperty: z.string().trim().max(200).default(""),
  /** 这一侧对象类型上的属性名。 */
  entityProperty: z.string().trim().max(200).default(""),
});

/**
 * 关系类型的**数据来源**（Palantir 的 link type backing datasource，backlog D2）：
 * 关系实例（边）从哪儿读出来。
 *
 * 三种支撑方式里平台先做两种（第三种"由对象自己支撑"用不到额外配置，先不做）：
 * - `JOIN_TABLE`：多对多，有一张中间表。两端的键映射写「连接表的列 → 对象类型的主键属性」；
 * - `FOREIGN_KEY`：外键长在某一端对象类型的表上。两端的键映射都不写连接列（`linkProperty` 留空），
 *   外键那一端填外键属性，另一端填被引用的属性；`view` / `dataSourceId` 留空就用外键所在端的**主来源**，
 *   `foreignKeySide = AUTO` 时外键在哪一端也按键映射推断 —— 外键式**可以整块不配**。
 *
 * 没配这一项、两端键映射也空 = 这条关系类型只在类型层声明了业务语义，读不出实例。**不配不算错**。
 * **中间表式（多对多）必须配**：连接行在第三张表里，键映射只说"哪一列对上哪一端"，没有别的地方能知道那张表是谁。
 */
export const relationshipSourceSchema = z.object({
  mode: z.enum(["JOIN_TABLE", "FOREIGN_KEY"]).default("JOIN_TABLE"),
  /** 关系实例存在哪个数据资源里。 */
  dataSourceId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** 表/视图所在的容器（Oracle / PG 的模式）；MySQL 留空。 */
  schema: z.string().trim().max(200).default(""),
  /** 连接表（JOIN_TABLE）或持有外键的那张表（FOREIGN_KEY 留空 = 用外键端对象类型自己的主来源）。 */
  view: z.string().trim().max(200).default(""),
  /** FOREIGN_KEY：外键长在哪一端；AUTO = 按两端键映射推断（推不出来才要求人指定）。 */
  foreignKeySide: z.enum(["SOURCE", "TARGET", "AUTO"]).default("AUTO"),
});

/** 「还没配数据来源」的那一份。zod 的 `.default()` 不会回头再解析内层默认值，所以这里写全。 */
export const EMPTY_LINK_SOURCE: RelationshipSource = { mode: "JOIN_TABLE", dataSourceId: "", schema: "", view: "", foreignKeySide: "AUTO" };

/**
 * 一个类的数据来源清单，也就是 Palantir 的多来源对象类型（column-wise MDO）。
 *
 * `sources[0]` 是主来源：对象的身份（主键）和标题由它决定；
 * 后面的每份补充来源都按主键逐列对齐连接过去，只往对象上补属性。
 * 只做建模、还没接数据的类可以一份来源都不挂。
 */
export const entitySourcesSchema = z.array(entitySourceSchema).default([]);

/** 动作参数：指向一个已有对象（ENTITY_REF），或者一个字面量（VALUE）。 */
export const actionParameterSchema = z.object({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["ENTITY_REF", "VALUE"]),
  entityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  dataType: propertyDataTypeSchema.default("TEXT"),
  required: z.boolean().default(true),
});

/**
 * 动作里指向一个对象，三种来源：
 * SUBJECT = 动作主对象（接受动作的那个对象实例，Palantir 里的 object context）；
 * PARAM = 动作入参；
 * EDIT = 本次动作前一步新建出来的对象（别名）。
 */
export const actionRefSchema = z.object({
  kind: z.enum(["SUBJECT", "PARAM", "EDIT"]),
  code: z.string().trim().default(""),
});

/** 写入属性的取值来源。 */
export const actionValueSchema = z.object({
  kind: z.enum(["PARAM", "CONST", "NOW"]),
  code: z.string().trim().default(""),
  value: z.string().default(""),
});

/**
 * 动作对图的一次操作。四种操作覆盖"新建对象 / 改属性 / 删除对象 / 连关系"，
 * 也就是把过去散落在 API 调用里的写事务写成声明式模板。
 */
export const actionEditSchema = z.object({
  op: z.enum(["CREATE_ENTITY", "SET_PROPERTY", "DELETE_ENTITY", "CREATE_RELATIONSHIP"]),
  /** CREATE_ENTITY 的别名，后续操作与规则条件用它引用这个新对象。 */
  alias: z.string().trim().default(""),
  entityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  relationshipTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  entityRef: actionRefSchema.default({ kind: "PARAM", code: "" }),
  sourceRef: actionRefSchema.default({ kind: "PARAM", code: "" }),
  targetRef: actionRefSchema.default({ kind: "PARAM", code: "" }),
  assignments: z.array(z.object({ property: z.string().trim().min(1), value: actionValueSchema })).default([]),
});

export const actionTypeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  /** 稳定的机器名，将来暴露给 AI 工具时就是工具名。 */
  code: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(""),
  /**
   * 作用的类：动作定义在这个类上，也只能在这个类的对象上执行。
   * 空字符串表示还没选（校验会拦下来），兼容加字段之前存下来的动作。
   */
  scopeEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  params: z.array(actionParameterSchema).default([]),
  edits: z.array(actionEditSchema).default([]),
});

/**
 * 规则条件：取某个主体（入参对象或本次新建的对象）的一个属性，
 * 可选先沿一条关系跳到邻域对象，再和常量比较。
 */
export const ruleConditionSchema = z.object({
  subject: z.object({
    kind: z.enum(["SUBJECT", "PARAM", "EDIT"]),
    code: z.string().trim().default(""),
    /** 非空表示先沿这条关系跳到邻域（任一邻域对象命中即算命中）；空表示就取主体自身。 */
    relationshipTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    direction: z.enum(["OUT", "IN"]).default("OUT"),
  }),
  property: z.string().trim().min(1).max(120),
  operator: z.enum(["EQUALS", "NOT_EQUALS", "IS_TRUTHY", "IS_FALSY", "IS_EMPTY", "IS_NOT_EMPTY"]),
  compareValue: z.string().default(""),
});

/**
 * 规则命中后的效果，三档：
 * HIDE  = 这个动作不出现在该对象上（适用性，只看主对象自身已有的属性）；
 * BLOCK = 拒绝执行，并给出原因（提交校验，可以看本次新建出来的对象）；
 * WARN  = 只提示，不拦。
 */
export const ruleEffectSchema = z.enum(["HIDE", "BLOCK", "WARN"]);

export const ontologyRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  effect: ruleEffectSchema.default("BLOCK"),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  /** 绑定的动作；空字符串表示对所有动作生效。 */
  actionId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** 旧数据里的「级别 + 写路径闸门」，读取时归一成 effect，不再写回。 */
  severity: z.enum(["BLOCKER", "WARNING"]).optional(),
  gate: z.boolean().optional(),
  conditions: z.array(ruleConditionSchema).default([]),
  /** 拦截或提示时给用户看的原因。 */
  message: z.string().max(500).default(""),
}).transform((rule) => {
  const { severity, gate, ...rest } = rule;
  if (!severity) return rest;
  return { ...rest, effect: severity === "BLOCKER" ? (gate === false ? "WARN" as const : "BLOCK" as const) : "WARN" as const };
});

export const ontologyDefinitionSchema = z.object({
  /** 逻辑分组清单；对象类型用 `groupId` 指回来。空数组 = 还没分组。 */
  groups: z.array(conceptGroupSchema).default([]),
  /**
   * 接口清单（抽象契约）。对象类型用 `implements` 指回来表示"我实现了它"。
   * 加这一项之前的老快照读出来是空数组。
   */
  interfaces: z.array(interfaceTypeSchema).default([]),
  /**
   * 指标清单（业务口径）。加这一项之前的老快照读出来是空数组。
   * 指标挂在某个对象类型上，只描述"怎么算"，不等于某一次查询的结果。
   */
  metrics: z.array(metricSchema).default([]),
  entityTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    displayProperty: z.string().max(120).optional().default(""),
    /** 所属逻辑分组；空字符串表示还没归组。 */
    groupId: z.union([z.string().uuid(), z.literal("")]).default(""),
    /**
     * 实现的接口（`interfaces[].id`）。可以写多个：Palantir 里一个对象类型能实现多个接口，
     * 分别服务不同的应用场景。声明实现之后必须满足接口的属性与关系约束（发布前校验会查）。
     */
    implements: z.array(z.string().uuid()).default([]),
    /**
     * 接口属性的**显式映射**（对齐 Palantir）：接口属性名 → 本对象类型自己的属性名。
     *
     * 为什么需要它：Palantir 实现接口时要"声明一份映射"，接口属性 `name` 可以落到实现方的
     * `CUST_NAME` 上，**不要求同名**。我们原来只会同名匹配，业务表里列名对不上就没法实现。
     * 没写映射的接口属性仍按同名匹配 —— 老数据零迁移，`properties: {}` 等于"全走同名"。
     */
    interfaceMappings: z.array(z.object({
      interfaceId: z.string().uuid(),
      properties: z.record(z.string(), z.string()).default({}),
      /** 接口的动作约束名 → 本对象类型上的动作 id（必须是作用在它自己身上的动作）。 */
      actions: z.record(z.string(), z.string()).default({}),
    })).default([]),
    properties: z.array(propertySchema).default([]),
    sources: entitySourcesSchema,
    dictionaries: z.array(entityDictionarySchema).optional(),
    /**
     * 这个对象类型的**默认读法**（2026-10-12 用户要求，对齐 S4）：
     * - `FEDERATED`（默认）：查询时按对象类型定义实时投影业务数据，不复制整版对象到索引；
     * - `AUTO`：虚拟查询优先；只有调用方明确点名索引时才读物化索引；
     * - `INDEXED`：只读索引；没整份物化就明确报错，**不静默回源**（行为可预测，配"不许半份"的口径）；
     * 代价：虚拟查询不能跨类型 join、多跳遍历不完整、聚合受限；需要这些能力时显式配置 INDEXED。
     */
    indexPolicy: z.enum(["AUTO", "INDEXED", "FEDERATED"]).default("FEDERATED"),
    /** 加多来源之前的老字段；读进来自动折成 sources[0]，写回时不再输出。 */
    source: legacyEntitySourceSchema.optional(),
  }).superRefine((entity, context) => {
    for (const message of dictionaryIssues(entity.dictionaries ?? [], entity.properties)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["dictionaries"], message });
    }
  }).transform(({ source, ...entity }) => {
    if (entity.sources.length || !source) return entity;
    const bound = Boolean(source.dataSourceId || source.view || source.primaryKey.length || source.titleField);
    return { ...entity, sources: bound ? [{ ...source, id: LEGACY_PRIMARY_SOURCE_ID }] : [] };
  })).default([]),
  relationshipTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    /** 这条关系类型表达什么业务含义（和类的 description 对齐）。 */
    description: z.string().max(500).default(""),
    sourceEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    targetEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    properties: z.array(propertySchema).default([]),
    /**
     * 起点侧的键映射：连接属性 → 起点对象类型的属性。空数组 = 还没配（不是错误）。
     * 加这一项之前的老快照读出来是空数组。
     */
    sourceKeyMappings: z.array(relationshipKeyMappingSchema).default([]),
    /** 终点侧的键映射：连接属性 → 终点对象类型的属性。 */
    targetKeyMappings: z.array(relationshipKeyMappingSchema).default([]),
    /** 关系实例的数据来源；没配就是"只建模、不取实例"。 */
    linkSource: relationshipSourceSchema.default(EMPTY_LINK_SOURCE),
    /**
     * 数量关系（Palantir 的 link type cardinality）：起点端 → 终点端 是 1:1 / 1:N / N:1 / N:N。
     * 空串 = 还没标注（不标不影响发布）。它只说数据上的数量，
     * **不改变「关系类型是双向的」**：两个方向都能走，它回答的是"走一次会放大几倍"。
     * 加这一项之前的老快照读出来是空串。
     */
    cardinality: z.union([z.enum(["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"]), z.literal("")]).default(""),
  })).default([]),
  actionTypes: z.array(actionTypeSchema).default([]),
  rules: z.array(ontologyRuleSchema).default([]),
});

export type OntologyDefinition = z.infer<typeof ontologyDefinitionSchema>;

export type EntitySource = z.infer<typeof entitySourceSchema>;
export type ConceptGroup = z.infer<typeof conceptGroupSchema>;
export type InterfaceType = z.infer<typeof interfaceTypeSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type InterfaceLinkConstraint = z.infer<typeof interfaceLinkConstraintSchema>;
export type InterfaceActionConstraint = z.infer<typeof interfaceActionConstraintSchema>;
export type RelationshipKeyMapping = z.infer<typeof relationshipKeyMappingSchema>;
export type RelationshipSource = z.infer<typeof relationshipSourceSchema>;
