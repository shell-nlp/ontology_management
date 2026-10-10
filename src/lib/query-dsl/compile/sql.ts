import type { DataSourceKind } from "@/lib/datasource/types";
import type { LogicalPlan, ResolvedExpr, ResolvedField, ResolvedMetric, ResolvedRelationship, ResolvedScalar, ResolvedValue } from "../ast";
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

function entityTableRef(entity: LogicalPlan["root"], kind: DataSourceKind): string {
  const source = entity.sources.find((item) => item.primary) ?? entity.sources[0];
  if (!source) throw new QueryDslError("ENTITY_NOT_BOUND", `对象类型「${entity.entityTypeName}」没有物理来源。`);
  return [source.schema, source.table].filter(Boolean).map((part) => quoteIdentifier(kind, part)).join(".");
}

function sourceTableRef(table: { schema: string; name: string }, kind: DataSourceKind): string {
  return [table.schema, table.name].filter(Boolean).map((part) => quoteIdentifier(kind, part)).join(".");
}

function tableRef(plan: LogicalPlan, kind: DataSourceKind): string {
  return `${entityTableRef(plan.root, kind)} ${quoteIdentifier(kind, plan.root.alias)}`;
}

function columnRef(field: ResolvedField, kind: DataSourceKind): string {
  return `${quoteIdentifier(kind, field.sourceAlias)}.${quoteIdentifier(kind, field.column)}`;
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

function qualifiedColumn(alias: string, column: string, kind: DataSourceKind): string {
  return `${quoteIdentifier(kind, alias)}.${quoteIdentifier(kind, column)}`;
}

function joinKeyword(optional: boolean): string {
  return optional ? "LEFT JOIN" : "JOIN";
}

function compileEntitySourceJoins(entity: LogicalPlan["root"], kind: DataSourceKind): string[] {
  const primary = entity.sources.find((item) => item.primary) ?? entity.sources[0];
  if (!primary) return [];
  return entity.sources.filter((source) => !source.primary).map((source) => {
    const conditions = source.primaryKey.map((key, index) =>
      `${qualifiedColumn(source.alias, key, kind)} = ${qualifiedColumn(primary.alias, primary.primaryKey[index], kind)}`,
    );
    const table = [source.schema, source.table].filter(Boolean).map((part) => quoteIdentifier(kind, part)).join(".");
    return `LEFT JOIN ${table} ${quoteIdentifier(kind, source.alias)} ON ${conditions.join(" AND ")}`;
  });
}
function compileRelationshipJoin(rel: ResolvedRelationship, kind: DataSourceKind): string[] {
  const plan = rel.plan;
  const newTable = entityTableRef(rel.toEntity, kind);
  const newAlias = quoteIdentifier(kind, rel.toAlias);

  if (plan.mode === "FOREIGN_KEY") {
    const holderId = plan.keyHolder === "SOURCE" ? rel.sourceEntityTypeId : rel.targetEntityTypeId;
    const referencedId = plan.foreignKeys.referenced.entityTypeId;
    const holderAlias = holderId === rel.fromEntity.entityTypeId ? rel.fromAlias : rel.toAlias;
    const referencedAlias = referencedId === rel.fromEntity.entityTypeId ? rel.fromAlias : rel.toAlias;
    const conditions = plan.foreignKeys.rowColumns.map((rowColumn, index) =>
      `${qualifiedColumn(referencedAlias, plan.foreignKeys.keyColumns[index], kind)} = ${qualifiedColumn(holderAlias, rowColumn, kind)}`,
    );
    return [`${joinKeyword(rel.optional)} ${newTable} ${newAlias} ON ${conditions.join(" AND ")}`];
  }

  const existingSide = rel.direction === "forward" ? plan.source : plan.target;
  const newSide = rel.direction === "forward" ? plan.target : plan.source;
  const linkAlias = `${rel.alias}__link`;
  const linkTable = sourceTableRef(plan.table, kind);
  const linkConditions = existingSide.pairs.map((pair) =>
    `${qualifiedColumn(linkAlias, pair.rowColumn, kind)} = ${qualifiedColumn(rel.fromAlias, pair.keyColumn, kind)}`,
  );
  const newConditions = newSide.pairs.map((pair) =>
    `${qualifiedColumn(rel.toAlias, pair.keyColumn, kind)} = ${qualifiedColumn(linkAlias, pair.rowColumn, kind)}`,
  );
  return [
    `${joinKeyword(rel.optional)} ${linkTable} ${quoteIdentifier(kind, linkAlias)} ON ${linkConditions.join(" AND ")}`,
    `${joinKeyword(rel.optional)} ${newTable} ${newAlias} ON ${newConditions.join(" AND ")}`,
  ];
}
export function compileQuerySql(plan: LogicalPlan, kind: DataSourceKind): CompiledSqlQuery {
  const bag = new ParameterBag();
  const select = compileSelect(plan, kind, bag);
  const where = plan.where ? ` WHERE ${compileExpr(plan, plan.where, kind, bag)}` : "";
  const joins = [
    ...compileEntitySourceJoins(plan.root, kind),
    ...plan.relationships.flatMap((rel) => [...compileRelationshipJoin(rel, kind), ...compileEntitySourceJoins(rel.toEntity, kind)]),
  ].join(" ");
  const group = plan.query.kind === "aggregate" && plan.groupBy.length
    ? ` GROUP BY ${plan.groupBy.map((field) => columnRef(field, kind)).join(", ")}`
    : "";
  const order = plan.query.order_by.length
    ? ` ORDER BY ${plan.query.order_by.map((item) => `${resolveOrderExpression(plan, item.ref, kind)} ${item.direction.toUpperCase()}`).join(", ")}`
    : "";

  return {
    statement: `SELECT ${select.items.join(", ")} FROM ${tableRef(plan, kind)}${joins ? ` ${joins}` : ""}${where}${group}${order}`,
    parameters: bag.all(),
    dataSourceId: plan.root.dataSourceId,
    columns: select.columns,
    limit: plan.query.limit,
    warnings: [...plan.warnings, ...select.warnings],
  };
}