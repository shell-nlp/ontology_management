import { z } from "zod";
import { QueryDslError } from "./errors";

const scalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const parameterRefSchema = z.strictObject({ param: z.string().trim().min(1) });
const filterValueSchema = z.union([scalarSchema, parameterRefSchema, z.array(scalarSchema).min(1)]);

const fieldRefSchema = z.strictObject({
  alias: z.string().trim().min(1).default("root"),
  property: z.string().trim().min(1),
});

export const compareOperatorSchema = z.enum([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
  "is_null",
  "is_not_null",
  "enum_label",
  "in_range",
]);

const filterConditionSchema = z.strictObject({
  field: fieldRefSchema,
  op: compareOperatorSchema,
  value: filterValueSchema.optional(),
});

export type QueryExpr =
  | { and: QueryExpr[] }
  | { or: QueryExpr[] }
  | { not: QueryExpr }
  | z.infer<typeof filterConditionSchema>;

const queryExprSchema: z.ZodType<QueryExpr, z.ZodTypeDef, unknown> = z.lazy(() => z.union([
  z.strictObject({ and: z.array(queryExprSchema).min(1) }),
  z.strictObject({ or: z.array(queryExprSchema).min(1) }),
  z.strictObject({ not: queryExprSchema }),
  filterConditionSchema,
]));

const selectItemSchema = z.union([
  z.strictObject({ field: fieldRefSchema, as: z.string().trim().min(1) }),
  z.strictObject({ metric: z.string().trim().min(1), on: z.string().trim().min(1).optional(), as: z.string().trim().min(1) }),
  z.strictObject({
    aggregate: z.enum(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX"]),
    property: z.string().trim().min(1).optional(),
    on: z.string().trim().min(1).optional(),
    as: z.string().trim().min(1),
  }),
]);

const relationshipRefSchema = z.strictObject({
  alias: z.string().trim().min(1),
  type: z.string().trim().min(1),
  from: z.string().trim().min(1).default("root"),
  direction: z.enum(["forward", "backward", "both"]).default("forward"),
  optional: z.boolean().default(true),
});

export const queryDslSchema = z.strictObject({
  version: z.literal("1.0"),
  kind: z.enum(["records", "aggregate"]),
  from: z.strictObject({
    object_type: z.string().trim().min(1),
    alias: z.string().trim().min(1).default("root"),
  }),
  relationships: z.array(relationshipRefSchema).default([]),
  where: queryExprSchema.optional(),
  select: z.array(selectItemSchema).min(1),
  group_by: z.array(fieldRefSchema).default([]),
  order_by: z.array(z.strictObject({
    ref: z.string().trim().min(1),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })).default([]),
  limit: z.number().int().min(1).max(5000).default(100),
  parameters: z.record(z.string(), scalarSchema).default({}),
});

export type CompareOperator = z.infer<typeof compareOperatorSchema>;
export type FilterValue = z.infer<typeof filterValueSchema>;
export type QueryDsl = z.infer<typeof queryDslSchema>;
export type FieldRef = z.infer<typeof fieldRefSchema>;
export type SelectItem = z.infer<typeof selectItemSchema>;
export type RelationshipRef = z.infer<typeof relationshipRefSchema>;
export type FilterCondition = z.infer<typeof filterConditionSchema>;

/**
 * select 的三种形态。模型最容易在这儿猜错（实测写过 {"count":true}），
 * 所以校验失败时把能写成什么样直接写进错误里 —— 只回一句英文 issue，模型只能接着猜。
 */
const SELECT_SHAPE_HINT =
  "select 每项只接受三种形态：{\"field\":{\"alias\":\"root\",\"property\":\"属性名\"},\"as\":\"列名\"}"
  + " / {\"metric\":\"指标名\",\"as\":\"列名\"}"
  + " / {\"aggregate\":\"COUNT|COUNT_DISTINCT|SUM|AVG|MIN|MAX\",\"property\":\"属性名（COUNT 可省）\",\"as\":\"列名\"}。"
  + "没有 {\"count\":true} 这种简写；要算个数就写 {\"aggregate\":\"COUNT\",\"as\":\"列名\"}。";

/** 把 union 折叠成最像的那一支的路径，别把三岔的英文 issue 全糊给模型。 */
function issuePaths(issue: z.ZodIssue): string[] {
  const node = issue as { code?: string; unionErrors?: z.ZodError[]; path: (string | number)[] };
  if (node.code === "invalid_union" && node.unionErrors?.length) {
    const best = [...node.unionErrors].sort((left, right) => left.issues.length - right.issues.length)[0];
    return best.issues.flatMap(issuePaths);
  }
  return [node.path.join(".")];
}

export function parseQueryDsl(input: unknown): QueryDsl {
  const parsed = queryDslSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  /*
   * ZodError 默认的 message 是 issues 的 JSON 串（一坨 invalid_union + 英文 message），
   * 模型读不懂、也没法照着改。换成错在哪几个路径 + 能写成什么样。
   */
  const paths = [...new Set(parsed.error.issues.flatMap(issuePaths).filter(Boolean))];
  const where = paths.length ? `问题在：${paths.slice(0, 6).join("、")}。` : "";
  throw new QueryDslError("INVALID_QUERY", `查询 DSL 结构不合法。${where}${SELECT_SHAPE_HINT}`);
}