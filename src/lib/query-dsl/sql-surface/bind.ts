import type { OntologyDefinition } from "@/lib/ontology";
import { QueryDslError } from "../errors";
import { unknownPropertyHint } from "../property-hint";
import { parseQueryDsl, type QueryDsl } from "../schema";
import { parseOntologySql, type SqlCaseValue, type SqlCondition, type SqlExpr, type SqlFieldRef, type SqlQueryAst, type SqlSelectItem, type SqlValue } from "./parse";

/**
 * 本体 SQL 的**语义绑定**：拿本体定义把语法树变成与 JSON DSL **同一份** `QueryDsl`。
 *
 * 这一步是"表层 SQL、内核本体"的分界线，也是 SQL 形状必须补上的东西 —— SQL 里 `客户数`
 * 到底指属性还是指标、`账户.账号` 里的 `账户` 指哪个实体，只有本体知道。绑定之后，
 * 下游（resolve → 编译 → 只读执行 → 基数校验）一行都不用改。
 */

/** 别名解析表：SQL 里能用来限定字段的名字 → DSL 里的实体别名（顺带带上这个实体本身，字段校验不用再查一遍）。 */
type AliasBinding = { alias: string; entityTypeName: string; entity: OntologyDefinition["entityTypes"][number] | null };

function suggest(name: string, candidates: readonly string[]): string {
  const needle = name.trim().toLowerCase();
  const hits = candidates.filter((item) => {
    const value = item.toLowerCase();
    return value.includes(needle) || needle.includes(value);
  });
  if (!hits.length) return "";
  return `本体里有：${hits.slice(0, 6).join("、")}。`;
}

function entityType(definition: OntologyDefinition, name: string) {
  return definition.entityTypes.find((item) => item.name === name) ?? null;
}

function relationType(definition: OntologyDefinition, name: string) {
  return definition.relationshipTypes.find((item) => item.name === name) ?? null;
}

function typeNameOfId(definition: OntologyDefinition, id: string) {
  return definition.entityTypes.find((item) => item.id === id)?.name ?? "";
}

/**
 * 建别名表。
 *
 * 允许的写法（每种都只指向一个实体，不存在歧义）：
 * - `root`（DSL 口径）与 FROM 的那个**对象类型名** → 根实体；
 * - 每个 JOIN 的**别名**（省略时用关系类型名）→ 这次连接出来的那个端点；
 * - 关系类型名本身也认（哪怕写了别名的 JOIN），因为 `JOIN 客户拥有账户` 读起来就是"连到另一端"。
 */
function buildAliases(definition: OntologyDefinition, ast: SqlQueryAst) {
  const root = entityType(definition, ast.objectType);
  if (!root) {
    throw new QueryDslError("UNKNOWN_ENTITY", `本体里没有对象类型「${ast.objectType}」。${suggest(ast.objectType, definition.entityTypes.map((item) => item.name))}`);
  }
  const byName = new Map<string, AliasBinding>();
  const add = (name: string, alias: string, entityTypeName: string, entity: OntologyDefinition["entityTypes"][number] | null) => {
    if (!name) return;
    const existing = byName.get(name);
    if (existing && existing.alias !== alias) {
      throw new QueryDslError("INVALID_QUERY", `别名「${name}」同时对上了两个实体（${existing.alias} / ${alias}）：请用 AS 给其中一个换个别名。`);
    }
    byName.set(name, { alias, entityTypeName, entity });
  };
  add("root", ast.rootAlias, root.name, root);
  add(ast.objectType, ast.rootAlias, root.name, root);
  // 自己写的别名（AS line）也要能用 `line.属性` 限定 —— 别名表里必须有这一项。
  add(ast.rootAlias, ast.rootAlias, root.name, root);

  ast.joins.forEach((join, index) => {
    const relation = relationType(definition, join.relation);
    if (!relation) {
      throw new QueryDslError("UNKNOWN_RELATIONSHIP", `本体里没有关系类型「${join.relation}」。${suggest(join.relation, definition.relationshipTypes.map((item) => item.name))}`);
    }
    const sourceName = typeNameOfId(definition, relation.sourceEntityTypeId);
    const targetName = typeNameOfId(definition, relation.targetEntityTypeId);
    // forward 连到终点、backward 连到起点；both 两边都算，取终点当"这次连出来的实体"（与 DSL 的默认读法一致）。
    const entityTypeName = join.direction === "backward" ? sourceName : targetName;
    if (!entityTypeName) {
      throw new QueryDslError("INVALID_QUERY", `关系类型「${join.relation}」的端点对象类型不存在（第 ${index + 1} 个 JOIN）。`);
    }
    const endpoint = entityType(definition, entityTypeName);
    add(join.alias, join.alias, entityTypeName, endpoint);
    add(join.relation, join.alias, entityTypeName, endpoint);
  });
  return { root, byName };
}

function toDslValue(value: SqlValue): unknown {
  switch (value.kind) {
    case "string": return value.value;
    case "number": return value.value;
    case "boolean": return value.value;
    case "null": return null;
    case "param": return { param: value.name };
  }
}

function toDslField(ref: SqlFieldRef, byName: Map<string, AliasBinding>) {
  const binding = byName.get(ref.explicitAlias ? ref.alias : "root");
  if (!binding) {
    throw new QueryDslError("INVALID_QUERY", `认不出别名「${ref.alias}」指哪个实体。可以写：${[...new Set([...byName.values()].map((item) => item.alias))].join("、")}。`);
  }
  /*
   * 属性在这里就核一遍（而不是丢给 resolve）：表层的错误要能指出"是哪个实体上没有哪个属性"，
   * 并顺手给候选 —— SQL 形状最容易错的就是把别的类型的属性名写到这个别名下面。
   */
  const entity = binding.entity;
  if (entity && !entity.properties.some((candidate) => candidate.name === ref.property)) {
    throw new QueryDslError("UNKNOWN_PROPERTY", `对象类型「${entity.name}」上没有属性「${ref.property}」。${unknownPropertyHint(entity.name, entity.properties, ref.property)}`);
  }
  return { alias: binding.alias, property: ref.property };
}

/** LIKE 模式 → DSL 的 contains / starts_with / ends_with；其它模式如实拒绝，不做静默近似。 */
function likeOperator(pattern: string): { op: "contains" | "starts_with" | "ends_with"; value: string } {
  const head = pattern.startsWith("%");
  const tail = pattern.endsWith("%");
  const core = pattern.replace(/^%+/, "").replace(/%+$/, "");
  if (!core) throw new QueryDslError("INVALID_QUERY", `LIKE 模式「${pattern}」没有可比的正文：不能只写 %。`);
  if (head && tail) return { op: "contains", value: core };
  if (head) return { op: "ends_with", value: core };
  if (tail) return { op: "starts_with", value: core };
  throw new QueryDslError("INVALID_QUERY", `LIKE 只支持 '%值%'（包含）、'值%'（开头）、'%值'（结尾）三种模式，收到「${pattern}」；要精确相等请用 =。`);
}

function toDslCondition(condition: SqlCondition, byName: Map<string, AliasBinding>): unknown {
  if (condition.kind === "label") return { field: toDslField(condition.field, byName), op: "enum_label", value: toDslValue(condition.value) };
  if (condition.kind === "compare") return { field: toDslField(condition.field, byName), op: condition.op, value: toDslValue(condition.value) };
  if (condition.kind === "null") return { field: toDslField(condition.field, byName), op: condition.negated ? "is_not_null" : "is_null" };
  if (condition.kind === "in") return { field: toDslField(condition.field, byName), op: condition.negated ? "not_in" : "in", value: condition.values.map(toDslValue) };
  if (condition.kind === "between") return { field: toDslField(condition.field, byName), op: "in_range", value: [toDslValue(condition.from), toDslValue(condition.to)] };
  const mapped = likeOperator(condition.pattern);
  return { field: toDslField(condition.field, byName), op: mapped.op, value: mapped.value };
}

function toDslExpr(expr: SqlExpr, byName: Map<string, AliasBinding>): unknown {
  if (expr.kind === "and") return { and: expr.items.map((item) => toDslExpr(item, byName)) };
  if (expr.kind === "or") return { or: expr.items.map((item) => toDslExpr(item, byName)) };
  if (expr.kind === "not") return { not: toDslExpr(expr.item, byName) };
  return toDslCondition(expr, byName);
}

function toDslSelectItem(item: SqlSelectItem, byName: Map<string, AliasBinding>, definition: OntologyDefinition): { dsl: unknown; aggregated: boolean } {
  if (item.kind === "aggregate") {
    const caseValue = (value: SqlCaseValue) => value.kind === "field" ? { field: toDslField(value.field, byName) } : { value: toDslValue(value) };
    const field = item.field ? toDslField(item.field, byName) : undefined;
    return {
      aggregated: true,
      dsl: {
        aggregate: item.aggregate,
        ...(item.case ? { case: { branches: item.case.branches.map((branch) => ({ when: toDslExpr(branch.when, byName), then: caseValue(branch.then) })), else: caseValue(item.case.otherwise) } } : {}),
        ...(field ? { property: field.property } : {}),
        ...(field && field.alias !== "root" ? { on: byName.get(field.alias)?.entityTypeName } : {}),
        as: item.as,
      },
    };
  }
  if (item.kind === "label") {
    const field = toDslField(item.field, byName);
    return { aggregated: false, dsl: { label: field, as: item.as } };
  }
  if (item.kind === "field") {
    const field = toDslField(item.field, byName);
    return { aggregated: false, dsl: { field, as: item.as } };
  }
  /*
   * 裸名字：先看这个名字在**它所在的那个实体**上是不是属性，是就按字段取；
   * 不是再看本体里有没有同名指标。两个都没有时把两条路都写进错误里 —— 这是模型最容易猜错的一处。
   */
  const binding = byName.get("root")!;
  const entity = entityType(definition, binding.entityTypeName);
  const property = entity?.properties.find((candidate) => candidate.name === item.name) ?? null;
  if (property) return { aggregated: false, dsl: { field: { alias: binding.alias, property: property.name }, as: item.as } };
  const metric = definition.metrics.find((candidate) => candidate.name === item.name) ?? null;
  if (metric) {
    return { aggregated: true, dsl: { metric: metric.name, ...(binding.alias !== "root" ? { on: binding.entityTypeName } : {}), as: item.as } };
  }
  const candidates = [...(entity?.properties ?? []).map((candidate) => candidate.name), ...definition.metrics.map((candidate) => candidate.name)];
  throw new QueryDslError(
    "UNKNOWN_PROPERTY",
    `认不出「${item.name}」：它既不是对象类型「${binding.entityTypeName}」的属性，也不是本体的指标。`
    + `${suggest(item.name, candidates) || unknownPropertyHint(binding.entityTypeName, entity?.properties ?? [], item.name)}`,
  );
}

/**
 * 语法树 + 本体定义 → `QueryDsl`（再走一遍既有的结构校验，拿到默认值）。
 *
 * `kind` 由 select 自动判定：有指标或聚合就是 aggregate，否则是 records ——
 * 让人（和模型）不必再手写一个 kind 字段，这正是 SQL 形状该省掉的东西。
 */
export function bindOntologySql(ast: SqlQueryAst, definition: OntologyDefinition, parameters: Record<string, unknown> = {}): QueryDsl {
  const { byName } = buildAliases(definition, ast);
  const items = ast.select.map((item) => toDslSelectItem(item, byName, definition));
  const aggregated = items.some((item) => item.aggregated);
  const outputNames = items.map((item) => (item.dsl as { as: string }).as);
  const orderBy = ast.orderBy.map((order) => {
    if (outputNames.includes(order.ref)) return { ref: order.ref, direction: order.direction };
    // ORDER BY 也可能直接写属性：换成它对应的输出列名；输出里没有这一列就如实报错。
    const candidate = ast.select.find((item) => item.kind === "field" && item.field.property === order.ref)
      ?? ast.select.find((item) => (item.kind === "aggregate" ? item.field?.property === order.ref : false));
    if (candidate) return { ref: (items[ast.select.indexOf(candidate)].dsl as { as: string }).as, direction: order.direction };
    throw new QueryDslError("INVALID_QUERY", `ORDER BY 的「${order.ref}」不在输出里。可以先给它起个别名（AS 名字）再按别名排；当前输出：${outputNames.join("、")}。`);
  });

  return parseQueryDsl({
    version: "1.0",
    parameters,
    kind: aggregated ? "aggregate" : "records",
    from: { object_type: ast.objectType, alias: ast.rootAlias },
    relationships: ast.joins.map((join, index) => ({
      // `from` 是"从哪个实体出发"：第一个 JOIN 从根出发，后面的从上一个 JOIN 出发 —— 与 SQL 里链式 JOIN 的读法一致。
      from: index === 0 ? ast.rootAlias : ast.joins[index - 1].alias,
      alias: join.alias,
      type: join.relation,
      direction: join.direction,
      optional: join.optional,
    })),
    ...(ast.where ? { where: toDslExpr(ast.where, byName) } : {}),
    select: items.map((item) => item.dsl),
    group_by: ast.groupBy.map((field) => toDslField(field, byName)),
    order_by: orderBy,
    ...(ast.limit === undefined ? {} : { limit: ast.limit }),
  });
}

/** 表层的两个函数合起来就是"文本 → QueryDsl"：先把 SQL 解析成语法树，再绑到本体上。 */
export function toQueryDsl(sql: string, definition: OntologyDefinition, parameters: Record<string, unknown> = {}): QueryDsl {
  return bindOntologySql(parseOntologySql(sql), definition, parameters);
}
