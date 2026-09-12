import { z } from "zod";

/**
 * 本体定义（对象类 / 关系类 / 属性规则 / 动作 / 规则）。
 *
 * 这里只保留与图数据库无关的定义结构。落地到具体图库的读写能力
 * （校验必填、同步唯一约束与索引、整体替换图数据）由
 * @/lib/graph 的 GraphStore 适配器实现，不再和 Cypher 绑定。
 *
 * 动作（actionTypes）与规则（rules）是本体的一等公民，不是某个对象类型的字段：
 * 一个动作可以跨多个对象类型写入，规则挂在动作上拦截写入。
 * 具体执行语义见 @/lib/action-engine。
 */
export const propertyDataTypeSchema = z.enum(["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"]);

const propertySchema = z.object({
  name: z.string().trim().min(1).max(120),
  dataType: propertyDataTypeSchema,
  required: z.boolean().default(false),
  unique: z.boolean().default(false),
  indexed: z.boolean().default(false),
});

/** 动作参数：指向一个已有对象（ENTITY_REF），或者一个字面量（VALUE）。 */
export const actionParameterSchema = z.object({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["ENTITY_REF", "VALUE"]),
  entityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
  dataType: propertyDataTypeSchema.default("TEXT"),
  required: z.boolean().default(true),
});

/** 动作里指向一个对象：来自入参（PARAM），或本次动作前一步新建的对象（EDIT 别名）。 */
export const actionRefSchema = z.object({
  kind: z.enum(["PARAM", "EDIT"]),
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
  params: z.array(actionParameterSchema).default([]),
  edits: z.array(actionEditSchema).default([]),
});

/**
 * 规则条件：取某个主体（入参对象或本次新建的对象）的一个属性，
 * 可选先沿一条关系跳到邻域对象，再和常量比较。
 */
export const ruleConditionSchema = z.object({
  subject: z.object({
    kind: z.enum(["PARAM", "EDIT"]),
    code: z.string().trim().default(""),
    /** 非空表示先沿这条关系跳到邻域（任一邻域对象命中即算命中）；空表示就取主体自身。 */
    relationshipTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    direction: z.enum(["OUT", "IN"]).default("OUT"),
  }),
  property: z.string().trim().min(1).max(120),
  operator: z.enum(["EQUALS", "NOT_EQUALS", "IS_TRUTHY", "IS_FALSY", "IS_EMPTY", "IS_NOT_EMPTY"]),
  compareValue: z.string().default(""),
});

export const ontologyRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  /** BLOCKER = 紧急（拦住写入），WARNING = 提示（只提醒）。 */
  severity: z.enum(["BLOCKER", "WARNING"]).default("WARNING"),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  /** 绑定的动作；空字符串表示对所有动作生效。 */
  actionId: z.union([z.string().uuid(), z.literal("")]).default(""),
  /** 写路径闸门：勾选后命中即拒绝执行，否则只作为提示。 */
  gate: z.boolean().default(true),
  conditions: z.array(ruleConditionSchema).default([]),
  /** 拦截时给用户看的原因。 */
  message: z.string().max(500).default(""),
});

export const ontologyDefinitionSchema = z.object({
  entityTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    displayProperty: z.string().max(120).optional().default(""),
    properties: z.array(propertySchema).default([]),
  })).default([]),
  relationshipTypes: z.array(z.object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    sourceEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    targetEntityTypeId: z.union([z.string().uuid(), z.literal("")]).default(""),
    properties: z.array(propertySchema).default([]),
  })).default([]),
  actionTypes: z.array(actionTypeSchema).default([]),
  rules: z.array(ontologyRuleSchema).default([]),
});

export type OntologyDefinition = z.infer<typeof ontologyDefinitionSchema>;
