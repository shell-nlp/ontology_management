import { z } from "zod";
import { LEGACY_PRIMARY_SOURCE_ID } from "@/lib/ontology-sources";

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
export const propertyDataTypeSchema = z.enum(["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"]);

const propertySchema = z.object({
  /** 机器名：写入图库、接口与数据列映射都用它，改它会牵动多处，所以单独放。 */
  name: z.string().trim().min(1).max(120),
  /**
   * 界面上给人看的名字（Palantir 的 property display name）。
   * 数据列名往往是 STATIS_DATE 这种，显示名才是「统计日期」。留空就退回 name。
   */
  displayName: z.string().trim().max(120).default(""),
  /** 这个属性是什么、口径怎么算。导入外部本体时会带上原文说明。 */
  description: z.string().max(300).default(""),
  dataType: propertyDataTypeSchema,
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
  /** 这个属性的值来自数据源里的哪一列；缺省或空表示还没映射（老快照里没有这一项）。 */
  sourceField: z.string().trim().max(200).optional(),
  /**
   * 这个属性取自哪一份来源（`entityTypes[].sources[].id`）。
   * 空表示主来源；加多来源之前的老快照没有这一项，读出来也按主来源算。
   */
  sourceId: z.string().trim().max(64).optional(),
});

/**
 * 类的一份数据来源：一张表或视图，属性按列映射。
 * 对象不单独绑表 —— 一个对象就是这张表里的一行，所以绑定写在类上。
 * 空 dataSourceId 表示这份来源还没接上（纯建模也能用）。
 */
export const entitySourceSchema = z.object({
  /** 这份来源在类里的标识：属性映射靠它指回来。只在本类内有意义，不是数据库对象。 */
  id: z.string().trim().min(1).max(64),
  dataSourceId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** 表/视图所在的容器：PG 的模式、Oracle 的模式；MySQL 留空。 */
  schema: z.string().trim().max(200).default(""),
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
export const conceptGroupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(40),
  /** 分组框的强调色；留空就按它在清单里的位置取一个调色板色。 */
  color: z.string().trim().max(32).default(""),
});

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
 * 动作对图的一次操作。三种操作覆盖"新建对象 / 改属性 / 连关系"，
 * 也就是把过去散落在 API 调用里的写事务写成声明式模板。
 */
export const actionEditSchema = z.object({
  op: z.enum(["CREATE_ENTITY", "SET_PROPERTY", "CREATE_RELATIONSHIP"]),
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
  entityTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    displayProperty: z.string().max(120).optional().default(""),
    /** 所属逻辑分组；空字符串表示还没归组。 */
    groupId: z.union([z.string().uuid(), z.literal("")]).default(""),
    /**
     * 父类：这个类继承谁。可填多个（多继承），用来表达「专线产品用户也是一种用户」。
     * 空数组表示这个类还没有层级（加字段之前的老快照读出来也是空数组）。
     */
    parents: z.array(z.string().uuid()).default([]),
    properties: z.array(propertySchema).default([]),
    sources: entitySourcesSchema,
    /** 加多来源之前的老字段；读进来自动折成 sources[0]，写回时不再输出。 */
    source: legacyEntitySourceSchema.optional(),
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
  })).default([]),
  actionTypes: z.array(actionTypeSchema).default([]),
  rules: z.array(ontologyRuleSchema).default([]),
});

export type OntologyDefinition = z.infer<typeof ontologyDefinitionSchema>;

export type EntitySource = z.infer<typeof entitySourceSchema>;
export type ConceptGroup = z.infer<typeof conceptGroupSchema>;
