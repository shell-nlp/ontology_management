import type { OntologyDefinition } from "@/lib/ontology";
import { planLinkSource } from "@/lib/ontology/link-source";
import { entitySources } from "@/lib/ontology/sources";
import { flipCardinality } from "@/lib/ontology/relationship-cardinality";
import { QueryDslError } from "./errors";
import type {
  LogicalPlan,
  ResolvedEntity,
  ResolvedExpr,
  ResolvedField,
  ResolvedFilter,
  ResolvedMetric,
  ResolvedRelationship,
  ResolvedSelectItem,
  ResolvedSource,
  ResolvedValue,
} from "./ast";
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

function resolveEntity(entity: OntologyDefinition["entityTypes"][number], alias: string): ResolvedEntity {
  const sources = entitySources(entity);
  const primary = sources[0];
  if (!primary?.dataSourceId || !primary.view) {
    throw new QueryDslError(
      "ENTITY_NOT_BOUND",
      `对象类型「${entity.name}」还没有绑定可查询的数据资源。`,
      "先到「对象 / 本体」页补齐数据资源与表绑定。",
    );
  }

  const resolvedSources: ResolvedSource[] = sources.map((source, index) => {
    if (!source.dataSourceId || !source.view) {
      throw new QueryDslError("ENTITY_NOT_BOUND", `对象类型「${entity.name}」的补充来源「${source.view || source.id}」没有绑定完整。`);
    }
    if (source.dataSourceId !== primary.dataSourceId) {
      throw new QueryDslError(
        "CROSS_SOURCE_JOIN_UNSUPPORTED",
        `对象类型「${entity.name}」的补充来源落在另一个数据资源上，v1 不支持跨数据资源 MDO。`,
      );
    }
    if (index > 0 && source.primaryKey.length !== primary.primaryKey.length) {
      throw new QueryDslError(
        "SECONDARY_SOURCE_UNSUPPORTED",
        `对象类型「${entity.name}」的补充来源连接键数与主来源不一致。`,
        "补充来源的 primaryKey 必须和主来源逐列对齐。",
      );
    }
    return {
      id: source.id,
      alias: index === 0 ? alias : `${alias}__src${index}`,
      schema: source.schema,
      table: source.view,
      primaryKey: [...source.primaryKey],
      titleField: source.titleField,
      primary: index === 0,
    };
  });

  const properties = new Map(entity.properties.map((property) => {
    const sourceField = (property.sourceField ?? property.name).trim();
    const ownerId = (property.sourceId ?? "").trim() || primary.id;
    const owner = resolvedSources.find((source) => source.id === ownerId);
    if (!owner) {
      throw new QueryDslError("INVALID_QUERY", `属性「${property.name}」指向的对象来源「${ownerId}」不存在。`);
    }
    return [property.name, {
      name: property.name,
      dataType: property.dataType,
      sourceField,
      sourceId: owner.id,
      sourceAlias: owner.alias,
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
    sources: resolvedSources,
    properties,
  };
}

function resolveRootEntity(definition: OntologyDefinition, name: string, alias: string): ResolvedEntity {
  const entity = definition.entityTypes.find((item) => item.name === name);
  if (!entity) throw entityError(name);
  return resolveEntity(entity, alias);
}

function resolveField(entities: Map<string, ResolvedEntity>, ref: FieldRef): ResolvedField {
  const entity = entities.get(ref.alias);
  if (!entity) {
    throw new QueryDslError("INVALID_QUERY", `查询里没有别名「${ref.alias}」对应的对象类型。`, "先检查 relationships 里的 alias / from 是否按顺序声明。");
  }
  const property = entity.properties.get(ref.property);
  if (!property) {
    throw new QueryDslError(
      "UNKNOWN_PROPERTY",
      `对象类型「${entity.entityTypeName}」里没有属性「${ref.property}」。`,
      "先用 get_object_type 或 search_schema 确认属性名。",
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

function resolveExpr(entities: Map<string, ResolvedEntity>, expr: QueryExpr): ResolvedExpr {
  if ("and" in expr) return { kind: "and", items: expr.and.map((item) => resolveExpr(entities, item)) };
  if ("or" in expr) return { kind: "or", items: expr.or.map((item) => resolveExpr(entities, item)) };
  if ("not" in expr) return { kind: "not", item: resolveExpr(entities, expr.not) };
  const value = resolveValue(expr.value, expr.op);
  return {
    kind: "condition",
    field: resolveField(entities, expr.field),
    op: expr.op,
    ...(value === undefined ? {} : { value }),
  };
}

function metricFilterValue(op: CompareOperator, value: string): ResolvedValue | undefined {
  if (op === "is_null" || op === "is_not_null") return undefined;
  if (op === "in" || op === "not_in") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return value;
}

function resolveMetricFilters(
  entities: Map<string, ResolvedEntity>,
  entityAlias: string,
  metric: OntologyDefinition["metrics"][number],
): ResolvedFilter[] {
  return metric.filters.map((item) => {
    const op = METRIC_OPERATOR[item.operator];
    if (!op) throw new QueryDslError("INVALID_QUERY", `指标「${metric.name}」使用了暂不支持的过滤操作符「${item.operator}」。`);
    const value = metricFilterValue(op, item.value);
    return {
      kind: "condition",
      field: resolveField(entities, { alias: entityAlias, property: item.property }),
      op,
      ...(value === undefined ? {} : { value }),
    };
  });
}

function resolveMetric(
  definition: OntologyDefinition,
  entities: Map<string, ResolvedEntity>,
  entityAlias: string,
  name: string,
  groupBy: ResolvedField[],
): ResolvedMetric {
  const entity = entities.get(entityAlias);
  if (!entity) throw new QueryDslError("INVALID_QUERY", `指标作用别名「${entityAlias}」不存在。`);
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
  const dimensions = metric.dimensions.map((property) => resolveField(entities, { alias: entityAlias, property }));
  for (const field of groupBy) {
    if (!dimensions.some((dimension) => dimension.alias === field.alias && dimension.name === field.name)) {
      throw new QueryDslError(
        "METRIC_DIMENSION_MISMATCH",
        `指标「${metric.name}」不允许按「${field.alias}.${field.name}」分组。`,
        `可用维度：${metric.dimensions.join("、") || "无"}。`,
      );
    }
  }
  return {
    id: metric.id,
    name: metric.name,
    description: metric.description,
    aggregation: metric.aggregation,
    ...(metric.property ? { property: resolveField(entities, { alias: entityAlias, property: metric.property }) } : {}),
    filters: resolveMetricFilters(entities, entityAlias, metric),
    dimensions,
    status: metric.status,
    unit: metric.unit,
  };
}

function resolveSelect(
  definition: OntologyDefinition,
  entities: Map<string, ResolvedEntity>,
  rootAlias: string,
  item: QueryDsl["select"][number],
  groupBy: ResolvedField[],
): ResolvedSelectItem {
  if ("field" in item) return { kind: "field", field: resolveField(entities, item.field), as: item.as };
  if ("metric" in item) {
    const on = item.on ?? rootAlias;
    return { kind: "metric", metric: resolveMetric(definition, entities, on, item.metric, groupBy), as: item.as };
  }
  const on = item.on ?? rootAlias;
  return {
    kind: "aggregate",
    aggregate: item.aggregate,
    ...(item.property ? { field: resolveField(entities, { alias: on, property: item.property }) } : {}),
    on,
    as: item.as,
  };
}

function isUnsafeCardinality(value: string): boolean {
  return !value || value === "ONE_TO_MANY" || value === "MANY_TO_MANY";
}

function resolveRelationships(
  definition: OntologyDefinition,
  root: ResolvedEntity,
  query: QueryDsl,
): { entities: Map<string, ResolvedEntity>; relationships: ResolvedRelationship[]; warnings: string[] } {
  const entities = new Map<string, ResolvedEntity>([[root.alias, root]]);
  const relationships: ResolvedRelationship[] = [];
  const warnings: string[] = [];

  for (const ref of query.relationships) {
    if (entities.has(ref.alias)) {
      throw new QueryDslError("INVALID_QUERY", `关系别名「${ref.alias}」重复。`);
    }
    const fromEntity = entities.get(ref.from);
    if (!fromEntity) {
      throw new QueryDslError("INVALID_QUERY", `关系「${ref.type}」的 from「${ref.from}」还没有声明。`, "relationships 必须按依赖顺序排列。");
    }
    const relation = definition.relationshipTypes.find((item) => item.name === ref.type);
    if (!relation) {
      throw new QueryDslError("UNKNOWN_RELATIONSHIP", `本体里没有关系类型「${ref.type}」。`, "先用 get_object_type 或 traverse_object_types 确认关系名。");
    }
    if (ref.direction === "both") {
      throw new QueryDslError("INVALID_QUERY", `关系「${ref.type}」不能同时按两个方向展开，请明确 forward 或 backward。`);
    }

    let targetEntityTypeId = "";
    if (ref.direction === "forward") {
      if (relation.sourceEntityTypeId !== fromEntity.entityTypeId) {
        throw new QueryDslError("INVALID_QUERY", `关系「${ref.type}」的 forward 方向不能从对象类型「${fromEntity.entityTypeName}」出发。`);
      }
      targetEntityTypeId = relation.targetEntityTypeId;
    } else {
      if (relation.targetEntityTypeId !== fromEntity.entityTypeId) {
        throw new QueryDslError("INVALID_QUERY", `关系「${ref.type}」的 backward 方向不能从对象类型「${fromEntity.entityTypeName}」出发。`);
      }
      targetEntityTypeId = relation.sourceEntityTypeId;
    }

    const targetEntity = definition.entityTypes.find((item) => item.id === targetEntityTypeId);
    if (!targetEntity) {
      throw new QueryDslError("UNKNOWN_ENTITY", `关系「${ref.type}」指向的对象类型不存在。`);
    }
    const toEntity = resolveEntity(targetEntity, ref.alias);
    if (toEntity.dataSourceId !== root.dataSourceId) {
      throw new QueryDslError(
        "CROSS_SOURCE_JOIN_UNSUPPORTED",
        `关系「${ref.type}」跨数据资源：根对象在「${root.dataSourceId}」，目标在「${toEntity.dataSourceId}」。`,
        "v1 不做跨数据资源 JOIN。",
      );
    }

    const plan = planLinkSource(definition, relation);
    if (!plan.ok) {
      throw new QueryDslError("INVALID_QUERY", plan.reason, "先到「关系类型」里补齐数据来源和键映射。");
    }
    if (plan.dataSourceId !== root.dataSourceId) {
      throw new QueryDslError(
        "CROSS_SOURCE_JOIN_UNSUPPORTED",
        `关系「${ref.type}」的连接表在另一个数据资源上，v1 不做跨数据资源 JOIN。`,
      );
    }

    const effectiveCardinality = ref.direction === "forward" ? relation.cardinality : flipCardinality(relation.cardinality);
    if (isUnsafeCardinality(effectiveCardinality)) {
      warnings.push(`关系「${ref.type}」的基数${effectiveCardinality ? `为 ${effectiveCardinality}` : "未标注"}，可能放大行数。`);
    }

    relationships.push({
      alias: ref.alias,
      relationId: relation.id,
      relationName: relation.name,
      fromAlias: ref.from,
      toAlias: ref.alias,
      direction: ref.direction,
      optional: ref.optional,
      sourceEntityTypeId: relation.sourceEntityTypeId,
      targetEntityTypeId: relation.targetEntityTypeId,
      effectiveCardinality,
      fromEntity,
      toEntity,
      plan,
    });
    entities.set(ref.alias, toEntity);
  }
  return { entities, relationships, warnings };
}

function isAggregate(item: ResolvedSelectItem): boolean {
  return item.kind === "metric" || item.kind === "aggregate";
}

export function resolveQueryDsl(definition: OntologyDefinition, query: QueryDsl): LogicalPlan {
  const root = resolveRootEntity(definition, query.from.object_type, query.from.alias);
  const resolvedRelationships = resolveRelationships(definition, root, query);

  if (query.kind === "aggregate") {
    const unsafe = resolvedRelationships.relationships.find((item) => isUnsafeCardinality(item.effectiveCardinality));
    if (unsafe) {
      throw new QueryDslError(
        "CARDINALITY_UNSAFE",
        `关系「${unsafe.relationName}」的基数可能放大行数，聚合查询拒绝执行，避免重复计数。`,
        "改用不会放大的关系方向，或补一个明确的对象去重口径。",
      );
    }
  }

  const groupBy = query.group_by.map((ref) => resolveField(resolvedRelationships.entities, ref));
  const select = query.select.map((item) => resolveSelect(definition, resolvedRelationships.entities, root.alias, item, groupBy));
  const aggregateCount = select.filter(isAggregate).length;
  if (query.kind === "records" && aggregateCount) {
    throw new QueryDslError("INVALID_QUERY", "kind=records 不能包含指标或聚合输出。");
  }
  if (query.kind === "aggregate" && !aggregateCount) {
    throw new QueryDslError("INVALID_QUERY", "kind=aggregate 至少要有一个指标或聚合输出。");
  }
  if (query.kind === "aggregate") {
    for (const item of select) {
      if (item.kind === "field" && !groupBy.some((field) => field.alias === item.field.alias && field.name === item.field.name)) {
        throw new QueryDslError("INVALID_QUERY", `聚合查询里的字段「${item.as}」必须出现在 group_by 中。`);
      }
    }
  }

  return {
    query,
    root,
    entities: resolvedRelationships.entities,
    relationships: resolvedRelationships.relationships,
    ...(query.where ? { where: resolveExpr(resolvedRelationships.entities, query.where) } : {}),
    select,
    groupBy,
    warnings: resolvedRelationships.warnings,
  };
}