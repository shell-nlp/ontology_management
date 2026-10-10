import type { DataSourceKind } from "@/lib/datasource/types";
import type { LogicalPlan, ResolvedExpr, ResolvedField, ResolvedMetric, ResolvedScalar, ResolvedValue } from "../ast";
import { QueryDslError } from "../errors";

export type CompiledSqlQuery = {
  statement: string;
  parameters: Record<string, ResolvedScalar>;
  dataSourceId: string;
  columns: string[];
  limit: number;
  warnings: string[];
};

class ParameterBag {
  private readonly values: Record<string, ResolvedScalar> = {};
  private index = 0;

  add(value: ResolvedScalar): string {
    const key = `p${++this.index}`;
    this.values[key] = value;
    return `:${key}`;
  }

  all(): Record<string, ResolvedScalar> {
    return { ...this.values };
  }
}

function quoteIdentifier(kind: DataSourceKind, value: string): string {
  if (kind === "MYSQL") return `\`${value.replaceAll("`", "``")}\``;
  return `"${value.replaceAll('"', '""')}"`;
}

function tableRef(plan: LogicalPlan, kind: DataSourceKind): string {
  const table = [plan.root.schema, plan.root.table].filter(Boolean).map((part) => quoteIdentifier(kind, part)).join(".");
  return `${table} ${quoteIdentifier(kind, plan.root.alias)}`;
}

function columnRef(field: ResolvedField, kind: DataSourceKind): string {
  return `${quoteIdentifier(kind, field.alias)}.${quoteIdentifier(kind, field.column)}`;
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

function addValue(plan: LogicalPlan, bag: ParameterBag, value: ResolvedValue): string {
  return bag.add(parameterValue(plan, value));
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function enumValues(field: ResolvedField, label: string): string[] {
  return field.enumValues.filter((item) => item.label === label).map((item) => item.value);
}

function compileCondition(plan: LogicalPlan, expr: Extract<ResolvedExpr, { kind: "condition" }>, kind: DataSourceKind, bag: ParameterBag): string {
  const column = columnRef(expr.field, kind);
  const value = expr.value;

  switch (expr.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const operator = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[expr.op];
      return `${column} ${operator} ${addValue(plan, bag, value)}`;
    }
    case "in":
    case "not_in": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const values = Array.isArray(value) ? value : [value];
      if (!values.length) return expr.op === "in" ? "1 = 0" : "1 = 1";
      return `${column} ${expr.op === "in" ? "IN" : "NOT IN"} (${values.map((item) => addValue(plan, bag, item)).join(", ")})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const raw = parameterValue(plan, value);
      if (typeof raw !== "string") throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」只支持字符串。`);
      const pattern = expr.op === "contains" ? `%${escapeLike(raw)}%` : expr.op === "starts_with" ? `${escapeLike(raw)}%` : `%${escapeLike(raw)}`;
      return `${column} LIKE ${bag.add(pattern)} ESCAPE '\\'`;
    }
    case "is_null":
      return `${column} IS NULL`;
    case "is_not_null":
      return `${column} IS NOT NULL`;
    case "enum_label": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", "enum_label 缺少标签。");
      const raw = parameterValue(plan, value);
      if (typeof raw !== "string") throw new QueryDslError("INVALID_QUERY", "enum_label 只支持字符串标签。");
      const values = enumValues(expr.field, raw);
      if (!values.length) {
        throw new QueryDslError("INVALID_QUERY", `属性「${expr.field.name}」没有枚举标签「${raw}」。`, "先补 enumValues，或改用显式 eq / in。");
      }
      return values.length === 1 ? `${column} = ${bag.add(values[0])}` : `${column} IN (${values.map((item) => bag.add(item)).join(", ")})`;
    }
    case "in_range": {
      if (!Array.isArray(value) || value.length !== 2) throw new QueryDslError("INVALID_QUERY", "in_range 需要提供 [from, to] 两个值。");
      const from = addValue(plan, bag, value[0]);
      const to = addValue(plan, bag, value[1]);
      return `(${column} >= ${from} AND ${column} <= ${to})`;
    }
  }
}

function compileExpr(plan: LogicalPlan, expr: ResolvedExpr, kind: DataSourceKind, bag: ParameterBag): string {
  if (expr.kind === "condition") return compileCondition(plan, expr, kind, bag);
  if (expr.kind === "not") return `NOT (${compileExpr(plan, expr.item, kind, bag)})`;
  const joiner = expr.kind === "and" ? " AND " : " OR ";
  return `(${expr.items.map((item) => compileExpr(plan, item, kind, bag)).join(joiner)})`;
}

function expressionForFilters(plan: LogicalPlan, filters: ResolvedExpr[], kind: DataSourceKind, bag: ParameterBag): string {
  if (!filters.length) return "";
  if (filters.length === 1) return compileExpr(plan, filters[0], kind, bag);
  return compileExpr(plan, { kind: "and", items: filters }, kind, bag);
}

function aggregateExpression(
  plan: LogicalPlan,
  aggregation: ResolvedMetric["aggregation"],
  field: ResolvedField | undefined,
  filters: ResolvedExpr[],
  kind: DataSourceKind,
  bag: ParameterBag,
): string {
  const condition = expressionForFilters(plan, filters, kind, bag);
  const column = field ? columnRef(field, kind) : "";
  const wrapped = (value: string) => condition ? `CASE WHEN ${condition} THEN ${value} END` : value;

  if (aggregation === "COUNT") {
    if (!field) return condition ? `COUNT(CASE WHEN ${condition} THEN 1 END)` : "COUNT(*)";
    return `COUNT(${wrapped(column)})`;
  }
  if (!field) throw new QueryDslError("INVALID_QUERY", `聚合「${aggregation}」必须指定 property。`);
  if (aggregation === "COUNT_DISTINCT") return `COUNT(DISTINCT ${wrapped(column)})`;
  return `${aggregation}(${wrapped(column)})`;
}

function compileMetricExpression(plan: LogicalPlan, metric: ResolvedMetric, kind: DataSourceKind, bag: ParameterBag): string {
  return aggregateExpression(plan, metric.aggregation, metric.property, metric.filters, kind, bag);
}

function compileSelect(plan: LogicalPlan, kind: DataSourceKind, bag: ParameterBag): { items: string[]; columns: string[]; warnings: string[] } {
  const items: string[] = [];
  const columns: string[] = [];
  const warnings: string[] = [];
  for (const item of plan.select) {
    if (item.kind === "field") {
      items.push(`${columnRef(item.field, kind)} AS ${quoteIdentifier(kind, item.as)}`);
    } else if (item.kind === "metric") {
      items.push(`${compileMetricExpression(plan, item.metric, kind, bag)} AS ${quoteIdentifier(kind, item.as)}`);
      if (item.metric.status === "draft") warnings.push(`指标「${item.metric.name}」状态为 draft，尚未验收。`);
    } else {
      items.push(`${aggregateExpression(plan, item.aggregate, item.field, [], kind, bag)} AS ${quoteIdentifier(kind, item.as)}`);
      warnings.push(`输出「${item.as}」使用临时聚合口径，未引用已定义指标。`);
    }
    columns.push(item.as);
  }
  return { items, columns, warnings };
}

function resolveOrderExpression(plan: LogicalPlan, ref: string, kind: DataSourceKind): string {
  const selected = plan.select.find((item) => item.as === ref);
  if (selected?.kind === "field") return columnRef(selected.field, kind);
  if (selected) return quoteIdentifier(kind, selected.as);
  const property = [...plan.root.properties.values()].find((item) => item.name === ref);
  if (property) return columnRef({ ...property, alias: plan.root.alias, entityTypeId: plan.root.entityTypeId, entityTypeName: plan.root.entityTypeName }, kind);
  throw new QueryDslError("INVALID_QUERY", `排序字段「${ref}」既不是输出列，也不是对象类型的属性。`);
}

export function compileQuerySql(plan: LogicalPlan, kind: DataSourceKind): CompiledSqlQuery {
  const bag = new ParameterBag();
  const select = compileSelect(plan, kind, bag);
  const where = plan.where ? ` WHERE ${compileExpr(plan, plan.where, kind, bag)}` : "";
  const group = plan.query.kind === "aggregate" && plan.groupBy.length
    ? ` GROUP BY ${plan.groupBy.map((field) => columnRef(field, kind)).join(", ")}`
    : "";
  const order = plan.query.order_by.length
    ? ` ORDER BY ${plan.query.order_by.map((item) => `${resolveOrderExpression(plan, item.ref, kind)} ${item.direction.toUpperCase()}`).join(", ")}`
    : "";

  return {
    statement: `SELECT ${select.items.join(", ")} FROM ${tableRef(plan, kind)}${where}${group}${order}`,
    parameters: bag.all(),
    dataSourceId: plan.root.dataSourceId,
    columns: select.columns,
    limit: plan.query.limit,
    warnings: [...plan.warnings, ...select.warnings],
  };
}