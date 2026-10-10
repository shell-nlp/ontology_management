import type { OntologyDefinition } from "@/lib/ontology";
import { entitySources } from "@/lib/ontology/sources";
import { QueryDslError } from "./errors";
import type { LogicalPlan, ResolvedEntity, ResolvedExpr, ResolvedField, ResolvedFilter, ResolvedMetric, ResolvedSelectItem, ResolvedValue } from "./ast";
import type { CompareOperator, FieldRef, FilterValue, QueryDsl, QueryExpr } from "./schema";

const METRIC_OPERATOR: Record<string, CompareOperator> = {
  EQ: "eq",
  NE: "ne",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
  IN: "in",
  NOT_IN: "not_in",
  CONTAINS: "contains",
  IS_NULL: "is_null",
  NOT_NULL: "is_not_null",
};

function entityError(name: string) {
  return new QueryDslError("UNKNOWN_ENTITY", `本体里没有对象类型「${name}」。`, "先用 search_schema 确认真实对象类型名。");
}

function resolveEntity(definition: OntologyDefinition, name: string, alias: string): ResolvedEntity {
  const entity = definition.entityTypes.find((item) => item.name === name);
  if (!entity) throw entityError(name);

  const sources = entitySources(entity);
  const primary = sources[0];
  if (!primary?.dataSourceId || !primary.view) {
    throw new QueryDslError(
      "ENTITY_NOT_BOUND",
      `对象类型「${entity.name}」还没有绑定可查询的数据资源。`,
      "先到「对象 / 本体」页补齐数据资源与表绑定。",
    );
  }

  const properties = new Map(entity.properties.map((property) => {
    const sourceField = (property.sourceField ?? property.name).trim();
    return [property.name, {
      name: property.name,
      dataType: property.dataType,
      sourceField,
      sourceId: (property.sourceId ?? "").trim(),
      column: sourceField || property.name,
      enumValues: property.enumValues ?? [],
    }];
  }));

  return {
    alias,
    entityTypeId: entity.id,
    entityTypeName: entity.name,
    primarySourceId: primary.id,
    dataSourceId: primary.dataSourceId,
    schema: primary.schema,
    table: primary.view,
    primaryKey: [...primary.primaryKey],
    titleField: primary.titleField,
    properties,
  };
}

function resolveField(entity: ResolvedEntity, ref: FieldRef): ResolvedField {
  if (ref.alias !== entity.alias) {
    throw new QueryDslError("INVALID_QUERY", `查询里没有别名「${ref.alias}」对应的对象类型。`, "v1 只支持根对象类型上的属性。");
  }
  const property = entity.properties.get(ref.property);
  if (!property) {
    throw new QueryDslError(
      "UNKNOWN_PROPERTY",
      `对象类型「${entity.entityTypeName}」里没有属性「${ref.property}」。`,
      "先用 get_object_type 或 search_schema 确认属性名。",
    );
  }
  if (property.sourceId && property.sourceId !== entity.primarySourceId) {
    throw new QueryDslError(
      "SECONDARY_SOURCE_UNSUPPORTED",
      `属性「${property.name}」来自补充来源，v1 先只支持对象类型的主来源。`,
      "多来源 JOIN 会在 P0.5 接入。",
    );
  }
  return {
    ...property,
    alias: entity.alias,
    entityTypeId: entity.entityTypeId,
    entityTypeName: entity.entityTypeName,
  };
}

function resolveValue(value: FilterValue | undefined, op: CompareOperator): ResolvedValue | undefined {
  if (op === "is_null" || op === "is_not_null") return undefined;
  if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${op}」缺少比较值。`);
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && "param" in value) return value;
  return value;
}

function resolveExpr(entity: ResolvedEntity, expr: QueryExpr): ResolvedExpr {
  if ("and" in expr) return { kind: "and", items: expr.and.map((item) => resolveExpr(entity, item)) };
  if ("or" in expr) return { kind: "or", items: expr.or.map((item) => resolveExpr(entity, item)) };
  if ("not" in expr) return { kind: "not", item: resolveExpr(entity, expr.not) };
  const value = resolveValue(expr.value, expr.op);
  return {
    kind: "condition",
    field: resolveField(entity, expr.field),
    op: expr.op,
    ...(value === undefined ? {} : { value }),
  };
}

function metricFilterValue(op: CompareOperator, value: string): ResolvedValue | undefined {
  if (op === "is_null" || op === "is_not_null") return undefined;
  if (op === "in" || op === "not_in") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}

function resolveMetricFilters(entity: ResolvedEntity, metric: OntologyDefinition["metrics"][number]): ResolvedFilter[] {
  return metric.filters.map((item) => {
    const op = METRIC_OPERATOR[item.operator];
    if (!op) throw new QueryDslError("INVALID_QUERY", `指标「${metric.name}」使用了暂不支持的过滤操作符「${item.operator}」。`);
    const value = metricFilterValue(op, item.value);
    return {
      kind: "condition",
      field: resolveField(entity, { alias: entity.alias, property: item.property }),
      op,
      ...(value === undefined ? {} : { value }),
    };
  });
}

function resolveMetric(
  definition: OntologyDefinition,
  entity: ResolvedEntity,
  name: string,
  groupBy: ResolvedField[],
): ResolvedMetric {
  const metric = definition.metrics.find((item) => item.name === name);
  if (!metric) {
    throw new QueryDslError("UNKNOWN_METRIC", `本体里没有指标「${name}」。`, "先用 list_metrics 确认指标名。");
  }
  if (metric.entityTypeId !== entity.entityTypeId) {
    const scope = definition.entityTypes.find((item) => item.id === metric.entityTypeId)?.name ?? "未指定";
    throw new QueryDslError(
      "METRIC_SCOPE_MISMATCH",
      `指标「${metric.name}」作用在对象类型「${scope}」上，不能用在「${entity.entityTypeName}」上。`,
    );
  }
  const dimensions = metric.dimensions.map((property) => resolveField(entity, { alias: entity.alias, property }));
  for (const field of groupBy) {
    if (!dimensions.some((dimension) => dimension.name === field.name)) {
      throw new QueryDslError(
        "METRIC_DIMENSION_MISMATCH",
        `指标「${metric.name}」不允许按属性「${field.name}」分组。`,
        `可用维度：${metric.dimensions.join("、") || "无"}。`,
      );
    }
  }
  return {
    id: metric.id,
    name: metric.name,
    description: metric.description,
    aggregation: metric.aggregation,
    ...(metric.property ? { property: resolveField(entity, { alias: entity.alias, property: metric.property }) } : {}),
    filters: resolveMetricFilters(entity, metric),
    dimensions,
    status: metric.status,
    unit: metric.unit,
  };
}

function resolveSelect(
  definition: OntologyDefinition,
  entity: ResolvedEntity,
  item: QueryDsl["select"][number],
  groupBy: ResolvedField[],
): ResolvedSelectItem {
  if ("field" in item) return { kind: "field", field: resolveField(entity, item.field), as: item.as };
  if ("metric" in item) return { kind: "metric", metric: resolveMetric(definition, entity, item.metric, groupBy), as: item.as };
  return {
    kind: "aggregate",
    aggregate: item.aggregate,
    ...(item.property ? { field: resolveField(entity, { alias: item.on ?? entity.alias, property: item.property }) } : {}),
    on: item.on ?? entity.alias,
    as: item.as,
  };
}

function isAggregate(item: ResolvedSelectItem): boolean {
  return item.kind === "metric" || item.kind === "aggregate";
}

export function resolveQueryDsl(definition: OntologyDefinition, query: QueryDsl): LogicalPlan {
  const root = resolveEntity(definition, query.from.object_type, query.from.alias);
  if (query.relationships.length) {
    throw new QueryDslError(
      "RELATIONSHIP_UNSUPPORTED",
      "当前 DSL 中间层还不支持关系查询；v1 先支持单对象类型查询。",
      "关系 JOIN 会在 P0.5 接入。",
    );
  }

  const groupBy = query.group_by.map((ref) => resolveField(root, ref));
  const select = query.select.map((item) => resolveSelect(definition, root, item, groupBy));
  const aggregateCount = select.filter(isAggregate).length;
  if (query.kind === "records" && aggregateCount) {
    throw new QueryDslError("INVALID_QUERY", "kind=records 不能包含指标或聚合输出。");
  }
  if (query.kind === "aggregate" && !aggregateCount) {
    throw new QueryDslError("INVALID_QUERY", "kind=aggregate 至少要有一个指标或聚合输出。");
  }
  if (query.kind === "aggregate") {
    for (const item of select) {
      if (item.kind === "field" && !groupBy.some((field) => field.name === item.field.name)) {
        throw new QueryDslError("INVALID_QUERY", `聚合查询里的字段「${item.as}」必须出现在 group_by 中。`);
      }
    }
  }

  return {
    query,
    root,
    ...(query.where ? { where: resolveExpr(root, query.where) } : {}),
    select,
    groupBy,
    warnings: [],
  };
}