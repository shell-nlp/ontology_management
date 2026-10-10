import { z } from "zod";

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

export function parseQueryDsl(input: unknown): QueryDsl {
  return queryDslSchema.parse(input);
}