import { In } from "typeorm";
import { clickHouseConfig } from "@/lib/infrastructure/object-index/clickhouse/config";
import { clickHouseQuery, type ClickHouseParams } from "@/lib/infrastructure/object-index/clickhouse/client";
import { OdsSourceEntity, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import type { LogicalPlan, ResolvedExpr, ResolvedField, ResolvedMetric, ResolvedRelationship, ResolvedScalar, ResolvedValue } from "@/lib/query-dsl/ast";
import type { OdsQueryExecutor } from "@/lib/query-dsl/contract";
import { QueryDslError } from "@/lib/query-dsl/errors";

type OdsConfig = Pick<OdsSourceEntity, "id" | "dataSourceId" | "schemaName" | "tableName" | "chTable" | "status" | "enabled" | "columns" | "lastSyncAt">;
type Route = {
  configs: Map<string, OdsConfig>;
  aliases: Map<string, OdsConfig>;
  links: Map<string, OdsConfig>;
};

class Bag {
  readonly params: ClickHouseParams = {};
  #index = 0;
  add(value: ResolvedScalar): string {
    const key = `p${++this.#index}`;
    this.params[key] = value === null ? "" : String(value);
    return `{${key}:String}`;
  }
}

function identifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function tableKey(dataSourceId: string, schema: string, table: string) {
  return `${dataSourceId}\u0000${schema}\u0000${table}`;
}

function configColumns(config: OdsConfig): string[] {
  if (!Array.isArray(config.columns)) return [];
  return config.columns.map((column) => String((column as { name?: unknown }).name ?? "").trim()).filter(Boolean);
}

function odsTable(config: OdsConfig) {
  const id = config.id.replace(/'/g, "''");
  // Filter each backing source before JOIN, preserving unmatched LEFT JOIN rows.
  return `(SELECT * FROM ${identifier(clickHouseConfig().database)}.${identifier(config.chTable)} FINAL WHERE _source_id = '${id}' AND _is_deleted = 0)`;
}

function requiredColumns(plan: LogicalPlan) {
  const byAlias = new Map<string, Set<string>>();
  const add = (alias: string, column: string) => {
    if (!alias || !column) return;
    const columns = byAlias.get(alias) ?? new Set<string>();
    columns.add(column);
    byAlias.set(alias, columns);
  };
  const addField = (field: ResolvedField) => add(field.sourceAlias, field.column);
  const addExpr = (expr: ResolvedExpr) => {
    if (expr.kind === "condition") addField(expr.field);
    else if (expr.kind === "not") addExpr(expr.item);
    else for (const item of expr.items) addExpr(item);
  };
  for (const entity of plan.entities.values()) {
    for (const source of entity.sources) for (const column of source.primaryKey) add(source.alias, column);
  }
  if (plan.where) addExpr(plan.where);
  for (const item of plan.select) {
    if (item.kind === "field" || item.kind === "label") addField(item.field);
    else if (item.kind === "metric") {
      if (item.metric.property) addField(item.metric.property);
      for (const filter of item.metric.filters) addExpr(filter);
      for (const dimension of item.metric.dimensions) addField(dimension);
    } else if (item.field) addField(item.field);
  }
  for (const field of plan.groupBy) addField(field);
  for (const order of plan.query.order_by) {
    const selected = plan.select.find((item) => item.as === order.ref);
    if (selected?.kind === "field" || selected?.kind === "label") addField(selected.field);
    else if (!selected) {
      const property = [...plan.root.properties.values()].find((item) => item.name === order.ref);
      if (property) add(plan.root.alias, property.column);
    }
  }
  for (const relation of plan.relationships) {
    if (relation.plan.mode === "FOREIGN_KEY") {
      const holderId = relation.plan.keyHolder === "SOURCE" ? relation.sourceEntityTypeId : relation.targetEntityTypeId;
      const holderAlias = holderId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
      const referencedAlias = relation.plan.foreignKeys.referenced.entityTypeId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
      for (const column of relation.plan.holder.keyColumns) add(holderAlias, column);
      for (const column of relation.plan.foreignKeys.keyColumns) add(referencedAlias, column);
      for (const column of relation.plan.foreignKeys.rowColumns) add(holderAlias, column);
    } else {
      const linkAlias = `${relation.alias}__link`;
      for (const column of relation.plan.columns) add(linkAlias, column);
      const sourceAlias = relation.plan.source.entityTypeId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
      const targetAlias = relation.plan.target.entityTypeId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
      for (const pair of relation.plan.source.pairs) add(sourceAlias, pair.keyColumn);
      for (const pair of relation.plan.target.pairs) add(targetAlias, pair.keyColumn);
    }
  }
  return byAlias;
}

async function resolveRoute(plan: LogicalPlan): Promise<Route | null> {
  const entities = [...plan.entities.values()];
  const sources = entities.flatMap((entity) => entity.sources.map((source) => ({ entity, source })));
  if (sources.some(({ source }) => source.sql || source.readMode === "DIRECT")) return null;
  const configs = await platformRepo(OdsSourceEntity).then((repo) => repo.find({
    where: { dataSourceId: In([...new Set(sources.map(({ source }) => source.dataSourceId))]), enabled: true },
  }));
  const byKey = new Map(configs.map((config) => [tableKey(config.dataSourceId, config.schemaName, config.tableName), config]));
  const aliases = new Map<string, OdsConfig>();
  const required = requiredColumns(plan);
  for (const { entity, source } of sources) {
    const config = byKey.get(tableKey(source.dataSourceId, source.schema, source.table));
    if (!config || config.status !== "READY") return null;
    const available = new Set(configColumns(config).map((column) => column.toLowerCase()));
    const needed = [...new Set([...source.primaryKey, ...(required.get(source.alias) ?? [])])];
    if (needed.some((column) => !available.has(column.toLowerCase()))) return null;
    aliases.set(source.alias, config);
  }
  const links = new Map<string, OdsConfig>();
  for (const relation of plan.relationships) {
    if (relation.plan.mode !== "JOIN_TABLE") continue;
    const config = byKey.get(tableKey(relation.plan.dataSourceId, relation.plan.table.schema, relation.plan.table.name));
    if (!config || config.status !== "READY") return null;
    const available = new Set(configColumns(config).map((column) => column.toLowerCase()));
    const needed = required.get(`${relation.alias}__link`) ?? new Set(relation.plan.columns);
    if ([...needed].some((column) => !available.has(column.toLowerCase()))) return null;
    links.set(`${relation.alias}__link`, config);
  }
  return { configs: byKey, aliases, links };
}

function columnRef(field: ResolvedField) {
  return `${identifier(field.sourceAlias)}.${identifier(field.column)}`;
}

function comparable(field: ResolvedField) {
  const column = columnRef(field);
  if (field.dataType === "TEXT" || field.dataType === "JSON" || field.dataType === "TEXT_ARRAY") return `trimBoth(toString(${column}))`;
  return column;
}

function parameterValue(plan: LogicalPlan, value: ResolvedValue): ResolvedScalar {
  if (value && typeof value === "object" && !Array.isArray(value) && "param" in value) {
    if (!Object.prototype.hasOwnProperty.call(plan.query.parameters, value.param)) {
      throw new QueryDslError("INVALID_QUERY", `查询参数「${value.param}」没有在 parameters 里提供值。`);
    }
    return plan.query.parameters[value.param];
  }
  return value as ResolvedScalar;
}

function typedValue(field: ResolvedField, value: ResolvedValue, plan: LogicalPlan, bag: Bag) {
  const raw = parameterValue(plan, value);
  if (raw === null) return "NULL";
  const placeholder = bag.add(raw);
  if (field.dataType === "INTEGER" || field.dataType === "DECIMAL") return `toFloat64OrNull(${placeholder})`;
  if (field.dataType === "BOOLEAN") return `toUInt8OrZero(${placeholder})`;
  if (field.dataType === "DATE") return `toDateOrNull(${placeholder})`;
  if (field.dataType === "DATETIME") return `parseDateTimeBestEffortOrNull(${placeholder})`;
  return placeholder;
}

function enumValues(field: ResolvedField, label: string) {
  return field.enumValues.filter((item) => item.label === label).map((item) => item.value);
}

function compileCondition(plan: LogicalPlan, expr: Extract<ResolvedExpr, { kind: "condition" }>, bag: Bag): string {
  const column = columnRef(expr.field);
  const comparableColumn = comparable(expr.field);
  const value = expr.value;
  switch (expr.op) {
    case "eq":
    case "ne":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      if (parameterValue(plan, value) === null) return expr.op === "ne" ? `${column} IS NOT NULL` : `${column} IS NULL`;
      const operator = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[expr.op];
      return `${comparableColumn} ${operator} ${typedValue(expr.field, value, plan, bag)}`;
    }
    case "in":
    case "not_in": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const values = Array.isArray(value) ? value : [value];
      if (!values.length) return expr.op === "in" ? "1 = 0" : "1 = 1";
      return `${comparableColumn} ${expr.op === "in" ? "IN" : "NOT IN"} (${values.map((item) => typedValue(expr.field, item, plan, bag)).join(", ")})`;
    }
    case "contains":
    case "starts_with":
    case "ends_with": {
      if (value === undefined) throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」缺少比较值。`);
      const raw = parameterValue(plan, value);
      if (typeof raw !== "string") throw new QueryDslError("INVALID_QUERY", `操作符「${expr.op}」只支持字符串。`);
      const pattern = bag.add(raw);
      if (expr.op === "contains") return `position(toString(${column}), ${pattern}) > 0`;
      return expr.op === "starts_with"
        ? `startsWith(toString(${column}), ${pattern})`
        : `endsWith(toString(${column}), ${pattern})`;
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
      if (!values.length) throw new QueryDslError("INVALID_QUERY", `属性「${expr.field.name}」没有枚举标签「${raw}」。`);
      return `${comparableColumn} IN (${values.map((item) => typedValue(expr.field, item, plan, bag)).join(", ")})`;
    }
    case "in_range": {
      if (!Array.isArray(value) || value.length !== 2) throw new QueryDslError("INVALID_QUERY", "in_range 需要提供 [from, to] 两个值。");
      return `(${comparableColumn} >= ${typedValue(expr.field, value[0], plan, bag)} AND ${comparableColumn} <= ${typedValue(expr.field, value[1], plan, bag)})`;
    }
  }
}

function compileExpr(plan: LogicalPlan, expr: ResolvedExpr, bag: Bag): string {
  if (expr.kind === "condition") return compileCondition(plan, expr, bag);
  if (expr.kind === "not") return `NOT (${compileExpr(plan, expr.item, bag)})`;
  return `(${expr.items.map((item) => compileExpr(plan, item, bag)).join(expr.kind === "and" ? " AND " : " OR ")})`;
}

function aggregateExpression(plan: LogicalPlan, aggregation: ResolvedMetric["aggregation"], field: ResolvedField | undefined, filters: ResolvedExpr[], bag: Bag) {
  const condition = filters.length ? compileExpr(plan, { kind: "and", items: filters }, bag) : "";
  const column = field ? columnRef(field) : "";
  const filtered = condition ? `CASE WHEN ${condition} THEN ${column} END` : column;
  if (aggregation === "COUNT") return field ? `count(${filtered})` : condition ? `countIf(${condition})` : "count()";
  if (!field) throw new QueryDslError("INVALID_QUERY", `聚合「${aggregation}」必须指定 property。`);
  if (aggregation === "COUNT_DISTINCT") return `uniqExact(${filtered})`;
  return `${aggregation}(${filtered})`;
}

function labelExpression(field: ResolvedField, plan: LogicalPlan, bag: Bag) {
  if (!field.enumValues.length) throw new QueryDslError("INVALID_QUERY", `属性「${field.name}」没有定义 enumValues，不能用 LABEL(...) 输出标签。`);
  const column = comparable(field);
  return `CASE ${field.enumValues.map((item) => `WHEN ${column} = ${typedValue(field, item.value, plan, bag)} THEN ${bag.add(item.label)}`).join(" ")} ELSE NULL END`;
}

function compileSelect(plan: LogicalPlan, bag: Bag) {
  const items: string[] = [];
  const columns: string[] = [];
  const warnings: string[] = [];
  const labels = new Map<string, string>();
  const labelOf = (field: ResolvedField) => {
    const key = `${field.alias}|${field.name}`;
    const cached = labels.get(key);
    if (cached) return cached;
    const built = labelExpression(field, plan, bag);
    labels.set(key, built);
    return built;
  };
  for (const item of plan.select) {
    if (item.kind === "field") items.push(`${columnRef(item.field)} AS ${identifier(item.as)}`);
    else if (item.kind === "label") items.push(`${labelOf(item.field)} AS ${identifier(item.as)}`);
    else if (item.kind === "metric") {
      items.push(`${aggregateExpression(plan, item.metric.aggregation, item.metric.property, item.metric.filters, bag)} AS ${identifier(item.as)}`);
      if (item.metric.status === "draft") warnings.push(`指标「${item.metric.name}」状态为 draft，尚未验收。`);
    } else {
      items.push(`${aggregateExpression(plan, item.aggregate, item.field, [], bag)} AS ${identifier(item.as)}`);
      warnings.push(`输出「${item.as}」使用临时聚合口径，未引用已定义指标。`);
    }
    columns.push(item.as);
  }
  return { items, columns, warnings, labelOf };
}

function orderExpression(plan: LogicalPlan, ref: string, labelOf: (field: ResolvedField) => string) {
  const selected = plan.select.find((item) => item.as === ref);
  if (selected?.kind === "field") return columnRef(selected.field);
  if (selected?.kind === "label") return labelOf(selected.field);
  if (selected) return identifier(selected.as);
  const property = [...plan.root.properties.values()].find((item) => item.name === ref);
  if (property) return columnRef({ ...property, alias: plan.root.alias, entityTypeId: plan.root.entityTypeId, entityTypeName: plan.root.entityTypeName });
  throw new QueryDslError("INVALID_QUERY", `排序字段「${ref}」既不是输出列，也不是对象类型的属性。`);
}

function qualified(alias: string, column: string) {
  return `${identifier(alias)}.${identifier(column)}`;
}

function compileEntityJoins(route: Route, entity: LogicalPlan["root"]) {
  const primary = entity.sources.find((source) => source.primary) ?? entity.sources[0];
  const primaryConfig = primary ? route.aliases.get(primary.alias) : undefined;
  if (!primary || !primaryConfig) return [];
  return entity.sources.filter((source) => !source.primary).flatMap((source) => {
    const config = route.aliases.get(source.alias);
    if (!config) return [];
    const conditions = source.primaryKey.map((key, index) => `${qualified(source.alias, key)} = ${qualified(primary.alias, primary.primaryKey[index])}`);
    return [`LEFT JOIN ${odsTable(config)} AS ${identifier(source.alias)} ON ${conditions.join(" AND ")}`];
  });
}

function compileRelationshipJoin(route: Route, relation: ResolvedRelationship) {
  const plan = relation.plan;
  const targetSource = relation.toEntity.sources.find((source) => source.alias === relation.toAlias) ?? relation.toEntity.sources[0];
  const targetConfig = targetSource ? route.aliases.get(targetSource.alias) : undefined;
  if (!targetConfig) return [];
  if (plan.mode === "FOREIGN_KEY") {
    const holderId = plan.keyHolder === "SOURCE" ? relation.sourceEntityTypeId : relation.targetEntityTypeId;
    const referencedId = plan.foreignKeys.referenced.entityTypeId;
    const holderAlias = holderId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
    const referencedAlias = referencedId === relation.fromEntity.entityTypeId ? relation.fromAlias : relation.toAlias;
    const conditions = plan.foreignKeys.rowColumns.map((rowColumn, index) => `${qualified(referencedAlias, plan.foreignKeys.keyColumns[index])} = ${qualified(holderAlias, rowColumn)}`);
    return [`${relation.optional ? "LEFT JOIN" : "JOIN"} ${odsTable(targetConfig)} AS ${identifier(relation.toAlias)} ON ${conditions.join(" AND ")}`];
  }
  const linkAlias = `${relation.alias}__link`;
  const linkConfig = route.links.get(linkAlias);
  if (!linkConfig) return [];
  const existingSide = relation.direction === "forward" ? plan.source : plan.target;
  const newSide = relation.direction === "forward" ? plan.target : plan.source;
  const linkConditions = existingSide.pairs.map((pair) => `${qualified(linkAlias, pair.rowColumn)} = ${qualified(relation.fromAlias, pair.keyColumn)}`);
  const newConditions = newSide.pairs.map((pair) => `${qualified(relation.toAlias, pair.keyColumn)} = ${qualified(linkAlias, pair.rowColumn)}`);
  return [
    `${relation.optional ? "LEFT JOIN" : "JOIN"} ${odsTable(linkConfig)} AS ${identifier(linkAlias)} ON ${linkConditions.join(" AND ")}`,
    `${relation.optional ? "LEFT JOIN" : "JOIN"} ${odsTable(targetConfig)} AS ${identifier(relation.toAlias)} ON ${newConditions.join(" AND ")}`,
  ];
}

export function createClickHouseOdsQueryExecutor(): OdsQueryExecutor {
  return {
    async executeLogicalQuery(plan) {
      if (!plan.root.sources.length) return null;
      const route = await resolveRoute(plan).catch(() => null);
      if (!route) return null;
      const bag = new Bag();
      const select = compileSelect(plan, bag);
      const rootSource = plan.root.sources.find((source) => source.primary) ?? plan.root.sources[0];
      const rootConfig = rootSource ? route.aliases.get(rootSource.alias) : undefined;
      if (!rootSource || !rootConfig) return null;
      const joins = [...compileEntityJoins(route, plan.root)];
      for (const relation of plan.relationships) {
        joins.push(...compileRelationshipJoin(route, relation), ...compileEntityJoins(route, relation.toEntity));
      }
      const conditions: string[] = [];
      if (plan.where) conditions.push(compileExpr(plan, plan.where, bag));
      const group = plan.query.kind === "aggregate" && plan.groupBy.length
        ? ` GROUP BY ${plan.groupBy.map((field) => plan.select.some((item) => item.kind === "label" && item.field.alias === field.alias && item.field.name === field.name) ? select.labelOf(field) : columnRef(field)).join(", ")}`
        : "";
      const order = plan.query.order_by.length
        ? ` ORDER BY ${plan.query.order_by.map((item) => `${orderExpression(plan, item.ref, select.labelOf)} ${item.direction.toUpperCase()}`).join(", ")}`
        : "";
      const limit = plan.query.limit;
      const statement = `SELECT ${select.items.join(", ")} FROM ${odsTable(rootConfig)} AS ${identifier(plan.root.alias)}${joins.length ? ` ${joins.join(" ")}` : ""}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}${group}${order} LIMIT ${limit + 1}`;
      const started = Date.now();
      const raw = await clickHouseQuery<Record<string, unknown>>(statement, { params: bag.params, settings: { join_use_nulls: "1" } });
      const truncated = raw.length > limit;
      const rows = raw.slice(0, limit);
      return {
        data_source: "ClickHouse ODS",
        data_source_kind: "CLICKHOUSE",
        statement,
        columns: select.columns,
        rows: rows.map((row) => select.columns.map((column) => row[column])),
        returned: rows.length,
        row_limit: limit,
        truncated,
        elapsed_ms: Date.now() - started,
        warnings: [...plan.warnings, ...select.warnings, "结果来自 ClickHouse ODS 源表镜像，不是对象实例副本。"],
      };
    },
  };
}
