import type { LogicalPlan, ResolvedExpr, ResolvedField, ResolvedMetric, ResolvedScalar, ResolvedValue } from "@/lib/query-dsl/ast";
import { QueryDslError } from "@/lib/query-dsl/errors";

export type CompiledClickHouseQuery = {
  statement: string;
  params: Record<string, string>;
  columns: string[];
  limit: number;
  warnings: string[];
};

type ClickHouseValueType = "String" | "Int64" | "Float64" | "UInt8";

class ParameterBag {
  private readonly values: Record<string, string> = {};
  private index = 0;

  add(value: ResolvedScalar, type: ClickHouseValueType): string {
    const key = `p${++this.index}`;
    this.values[key] = value === null ? "" : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    return `{${key}:${type}}`;
  }

  all(): Record<string, string> {
    return { ...this.values };
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parameterValue(plan: LogicalPlan, value: ResolvedValue): ResolvedScalar {
  if (value && typeof value === "object" && !Array.isArray(value) && "param" in value) {
    const name = value.param;
    if (!Object.prototype.hasOwnProperty.call(plan.query.parameters, name)) {
      throw new QueryDslError("INVALID_QUERY", `查询参数「${name}」没有在 parameters 里提供值。`);
    }
    return plan.query.parameters[name];
  }
  return value as ResolvedScalar;
}

function valueType(field: ResolvedField): ClickHouseValueType {
  if (field.dataType === "INTEGER") return "Int64";
  if (field.dataType === "DECIMAL") return "Float64";
  if (field.dataType === "BOOLEAN") return "UInt8";
  return "String";
}

function propertyKey(field: ResolvedField, bag: ParameterBag): string {
  return bag.add(field.name, "String");
}

function propertyColumn(field: ResolvedField): string {
  return `${quote(field.alias)}.properties`;
}

function propertyExpr(field: ResolvedField, bag: ParameterBag): string {
  const column = propertyColumn(field);
  const key = propertyKey(field, bag);
  if (field.dataType === "INTEGER") return `JSONExtractInt(${column}, ${key})`;
  if (field.dataType === "DECIMAL") return `JSONExtractFloat(${column}, ${key})`;
  if (field.dataType === "BOOLEAN") return `JSONExtractBool(${column}, ${key})`;
  return `JSONExtractString(${column}, ${key})`;
}

function propertyRaw(field: ResolvedField, bag: ParameterBag): string {
  return `JSONExtractRaw(${propertyColumn(field)}, ${propertyKey(field, bag)})`;
}

function propertyHas(field: ResolvedField, bag: ParameterBag): string {
  return `JSONHas(${propertyColumn(field)}, ${propertyKey(field, bag)})`;
}

function propertyValid(field: ResolvedField, bag: ParameterBag): string {
  return `(${propertyHas(field, bag)} AND ${propertyRaw(field, bag)} <> 'null')`;
}

function comparableExpr(field: ResolvedField, bag: ParameterBag): string {
  const expression = propertyExpr(field, bag);
  if (field.dataType === "TEXT") return `trimBoth(${expression})`;
  if (field.dataType === "DATE") return `toDateOrNull(${expression})`;
  if (field.dataType === "DATETIME") return `parseDateTimeBestEffortOrNull(${expression})`;
  return expression;
}

function addValue(bag: ParameterBag, field: ResolvedField, value: ResolvedScalar): string {
  const placeholder = bag.add(value, valueType(field));
  if (field.dataType === "DATE") return `toDate(${placeholder})`;
  if (field.dataType === "DATETIME") return `parseDateTimeBestEffort(${placeholder})`;
  return placeholder;
}

function compileCondition(plan: LogicalPlan, expr: Extract<ResolvedExpr, { kind: "condition" }>, bag: ParameterBag): string {
  const column = comparableExpr(expr.field, bag);
  const valid = propertyValid(expr.field, bag);
  const value = expr.value;

  switch (expr.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const raw = parameterValue(plan, value);
      if (raw === null) return "0";
      const operator = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[expr.op];
      return `(${valid} AND ${column} ${operator} ${addValue(bag, expr.field, raw)})`;
    }
    case "in":
    case "not_in": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const values = Array.isArray(value) ? value : [value];
      const resolved = values.map((item) => parameterValue(plan, item));
      if (resolved.some((item) => item === null)) throw new QueryDslError("INVALID_QUERY", "IN / NOT IN 不支持 null，请改用 IS NULL / IS NOT NULL。");
      if (!resolved.length) return expr.op === "in" ? "0" : "1";
      return `(${valid} AND ${column} ${expr.op === "in" ? "IN" : "NOT IN"} (${resolved.map((item) => addValue(bag, expr.field, item)).join(", ")}))`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const raw = parameterValue(plan, value);
      if (typeof raw !== "string") throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」只支持字符串。`);
      const parameter = bag.add(raw, "String");
      const match = expr.op === "contains"
        ? `position(${column}, ${parameter}) > 0`
        : expr.op === "starts_with"
          ? `startsWith(${column}, ${parameter})`
          : `endsWith(${column}, ${parameter})`;
      return `(${valid} AND ${match})`;
    }
    case "is_null":
      return `(NOT ${propertyHas(expr.field, bag)} OR ${propertyRaw(expr.field, bag)} = 'null')`;
    case "is_not_null":
      return propertyValid(expr.field, bag);
    case "enum_label": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", "enum_label 缺少标签。");
      const raw = parameterValue(plan, value);
      if (typeof raw !== "string") throw new QueryDslError("INVALID_QUERY", "enum_label 只支持字符串标签。");
      const values = expr.field.enumValues.filter((item) => item.label === raw).map((item) => item.value);
      if (!values.length) throw new QueryDslError("INVALID_QUERY", `属性「${expr.field.name}」没有枚举标签「${raw}」。`);
      return `(${valid} AND ${column} ${values.length === 1 ? "=" : "IN"} ${values.length === 1 ? addValue(bag, expr.field, values[0]) : `(${values.map((item) => addValue(bag, expr.field, item)).join(", ")})`})`;
    }
    case "in_range": {
      if (!Array.isArray(value) || value.length !== 2) throw new QueryDslError("INVALID_QUERY", "in_range 需要提供 [from, to] 两个值。");
      const from = parameterValue(plan, value[0]);
      const to = parameterValue(plan, value[1]);
      if (from === null || to === null) throw new QueryDslError("INVALID_QUERY", "in_range 的两个值都不能是 null。");
      return `(${valid} AND ${column} >= ${addValue(bag, expr.field, from)} AND ${column} <= ${addValue(bag, expr.field, to)})`;
    }
  }
}

function compileExpr(plan: LogicalPlan, expr: ResolvedExpr, bag: ParameterBag): string {
  if (expr.kind === "condition") return compileCondition(plan, expr, bag);
  if (expr.kind === "not") return `NOT (${compileExpr(plan, expr.item, bag)})`;
  const joiner = expr.kind === "and" ? " AND " : " OR ";
  return `(${expr.items.map((item) => compileExpr(plan, item, bag)).join(joiner)})`;
}

function filtersExpr(plan: LogicalPlan, filters: ResolvedExpr[], bag: ParameterBag): string {
  if (!filters.length) return "";
  if (filters.length === 1) return compileExpr(plan, filters[0], bag);
  return compileExpr(plan, { kind: "and", items: filters }, bag);
}

function aggregateExpression(
  plan: LogicalPlan,
  aggregation: ResolvedMetric["aggregation"],
  field: ResolvedField | undefined,
  filters: ResolvedExpr[],
  bag: ParameterBag,
): string {
  const filter = filtersExpr(plan, filters, bag);
  if (aggregation === "COUNT") {
    if (!field) return filter ? `countIf(${filter})` : "count()";
    const condition = filter ? `(${propertyValid(field, bag)} AND ${filter})` : propertyValid(field, bag);
    return `countIf(${condition})`;
  }
  if (!field) throw new QueryDslError("INVALID_QUERY", `聚合「${aggregation}」必须指定 property。`);
  const condition = filter ? `(${propertyValid(field, bag)} AND ${filter})` : propertyValid(field, bag);
  const expression = propertyExpr(field, bag);
  if (aggregation === "COUNT_DISTINCT") return `uniqExactIf(${expression}, ${condition})`;
  return `${aggregation.toLowerCase()}If(${expression}, ${condition})`;
}

/**
 * 标签表达式：码值 → `enumValues` 里的中文标签（与 SQL 编译器的 `labelExpression` 同一口径）。
 * 认不出的码值给 NULL（`multiIf` 的兜底），和 `LABEL(属性) = '标签'` 的过滤语义一致。
 */
function labelExpression(field: ResolvedField, bag: ParameterBag): string {
  if (!field.enumValues.length) {
    throw new QueryDslError("INVALID_QUERY", `属性「${field.name}」没有定义 enumValues，不能用 LABEL(...) 输出标签。`);
  }
  const column = comparableExpr(field, bag);
  const branches = field.enumValues.map((item) => `${column} = ${addValue(bag, field, item.value)}, ${bag.add(item.label, "String")}`);
  return `multiIf(${branches.join(", ")}, NULL)`;
}

function compileSelect(plan: LogicalPlan, bag: ParameterBag, labelExprOf: (field: ResolvedField) => string): { items: string[]; columns: string[]; warnings: string[] } {
  const items: string[] = [];
  const columns: string[] = [];
  const warnings: string[] = [];
  for (const item of plan.select) {
    if (item.kind === "field") {
      items.push(`${propertyExpr(item.field, bag)} AS ${quote(item.as)}`);
    } else if (item.kind === "label") {
      items.push(`${labelExprOf(item.field)} AS ${quote(item.as)}`);
    } else if (item.kind === "metric") {
      items.push(`${aggregateExpression(plan, item.metric.aggregation, item.metric.property, item.metric.filters, bag)} AS ${quote(item.as)}`);
      if (item.metric.status === "draft") warnings.push(`指标「${item.metric.name}」状态为 draft，尚未验收。`);
    } else {
      items.push(`${aggregateExpression(plan, item.aggregate, item.field, [], bag)} AS ${quote(item.as)}`);
      warnings.push(`输出「${item.as}」使用临时聚合口径，未引用已定义指标。`);
    }
    columns.push(item.as);
  }
  return { items, columns, warnings };
}

function resolveOrderExpression(plan: LogicalPlan, ref: string, bag: ParameterBag): string {
  const selected = plan.select.find((item) => item.as === ref);
  if (selected?.kind === "field") return propertyExpr(selected.field, bag);
  if (selected) return quote(ref);
  const property = [...plan.root.properties.values()].find((item) => item.name === ref);
  if (property) return propertyExpr({ ...property, alias: plan.root.alias, entityTypeId: plan.root.entityTypeId, entityTypeName: plan.root.entityTypeName }, bag);
  throw new QueryDslError("INVALID_QUERY", `排序字段「${ref}」既不是输出列，也不是对象类型的属性。`);
}

function joinKeyword(optional: boolean): string {
  return optional ? "LEFT JOIN" : "JOIN";
}

function compileRelationshipJoin(
  rel: LogicalPlan["relationships"][number],
  database: string,
  target: string,
  bag: ParameterBag,
): string[] {
  const linkAlias = `${rel.alias}__link`;
  const link = `${database}.object_links AS ${quote(linkAlias)} FINAL`;
  const entries = `${database}.object_entries AS ${quote(rel.toAlias)} FINAL`;
  const relation = bag.add(rel.relationName, "String");
  const entityType = bag.add(rel.toEntity.entityTypeName, "String");
  const from = quote(rel.fromAlias);
  const linkId = quote(linkAlias);
  const to = quote(rel.toAlias);
  const existingKey = rel.direction === "forward" ? "source_key" : "target_key";
  const newKey = rel.direction === "forward" ? "target_key" : "source_key";
  const keyword = joinKeyword(rel.optional);
  return [
    `${keyword} ${link} ON ${linkId}.target_id = ${target} AND ${linkId}.relationship_type = ${relation} AND ${linkId}.${existingKey} = ${from}.object_key`,
    `${keyword} ${entries} ON ${to}.target_id = ${target} AND ${to}.entity_type = ${entityType} AND ${to}.object_key = ${linkId}.${newKey}`,
  ];
}

export function compileLogicalQueryForClickHouse(plan: LogicalPlan, targetId: string, database: string): CompiledClickHouseQuery {
  if (plan.select.some((item) => item.kind === "aggregate" && item.case)) throw new QueryDslError("INVALID_QUERY", "CASE 条件聚合请使用 ODS / 业务源虚拟查询；旧对象物化索引不支持该表达式。");
  const bag = new ParameterBag();
  const target = bag.add(targetId, "String");
  const root = quote(plan.root.alias);
  const rootType = bag.add(plan.root.entityTypeName, "String");
  const from = [`${database}.object_entries AS ${root} FINAL`];
  const conditions = [`${root}.target_id = ${target}`, `${root}.entity_type = ${rootType}`];
  for (const relationship of plan.relationships) from.push(...compileRelationshipJoin(relationship, database, target, bag));
  if (plan.where) conditions.push(compileExpr(plan, plan.where, bag));

  /*
   * 标签维度要把**同一个标签表达式**放进 GROUP BY：ClickHouse 不接受"选中的表达式不在 GROUP BY 里"，
   * 而且它是按表达式结构匹配的 —— SELECT 与 GROUP BY 必须**一字不差**（占位符编号也要一样），
   * 所以这里缓存同一份字符串给两边用。
   */
  const labelCache = new Map<string, string>();
  const labelExprOf = (field: ResolvedField): string => {
    const key = `${field.alias}|${field.name}`;
    const cached = labelCache.get(key);
    if (cached) return cached;
    const built = labelExpression(field, bag);
    labelCache.set(key, built);
    return built;
  };
  const labelFields = new Set<string>();
  for (const item of plan.select) if (item.kind === "label") labelFields.add(`${item.field.alias}|${item.field.name}`);
  const select = compileSelect(plan, bag, labelExprOf);
  const group = plan.query.kind === "aggregate" && plan.groupBy.length
    ? ` GROUP BY ${plan.groupBy.map((field) => (labelFields.has(`${field.alias}|${field.name}`) ? labelExprOf(field) : propertyExpr(field, bag))).join(", ")}`
    : "";
  const order = plan.query.order_by.length
    ? ` ORDER BY ${plan.query.order_by.map((item) => `${resolveOrderExpression(plan, item.ref, bag)} ${item.direction.toUpperCase()}`).join(", ")}`
    : "";
  const fetchLimit = Math.min(plan.query.limit + 1, 5001);

  return {
    statement: `SELECT ${select.items.join(", ")} FROM ${from.join(" ")} WHERE ${conditions.join(" AND ")}${group}${order} LIMIT ${fetchLimit}`,
    params: bag.all(),
    columns: select.columns,
    limit: plan.query.limit,
    warnings: [...plan.warnings, ...select.warnings],
  };
}
