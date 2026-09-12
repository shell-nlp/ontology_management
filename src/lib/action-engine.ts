import { randomUUID } from "node:crypto";
import { parsePropertyValues } from "@/lib/instance-property-editor";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 动作引擎。
 *
 * 一次动作 = 把声明的操作模板套到当前图上，先在内存里算出"执行后的样子"，
 * 再用挂在动作上的规则去检查这个结果，最后才决定落不落盘。
 *
 * 这样做的意义不在于"能用自然语言写库"，而在于：**平台里不存在这个动作，
 * 就没有对应的写入口**；而存在的动作，写法是固定模板，不靠调用方自觉。
 * 本文件是纯函数，不碰文件与数据库，便于单测与干跑。
 */

export type ActionNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type ActionRelationship = { id: string; sourceId: string; targetId: string; type: string; properties: Record<string, unknown> };
export type ActionGraph = { nodes: ActionNode[]; relationships: ActionRelationship[] };

export type ActionRunInput = { code: string; entityId?: string; value?: string };

export type ActionFinding = {
  ruleId: string;
  ruleName: string;
  severity: "BLOCKER" | "WARNING";
  message: string;
  /** 每条命中的条件一行，说明"哪来的证据"。 */
  evidence: string[];
};

export type ActionOutcome = {
  actionId: string;
  actionName: string;
  actionCode: string;
  /** PASSED 表示校验全过；BLOCKED 表示有闸门规则命中。 */
  verdict: "PASSED" | "BLOCKED";
  blockers: ActionFinding[];
  warnings: ActionFinding[];
  /** 这次动作会做哪些事，按顺序。 */
  steps: string[];
  createdEntities: { id: string; label: string; display: string }[];
  /** 要落盘的图：通过时是执行后的结果，被拦截时是原图。 */
  graph: ActionGraph;
};

/** 校验失败时抛这个，调用方据此把"被哪条规则拦住"回给用户。 */
export class ActionBlockedError extends Error {
  outcome: ActionOutcome;
  constructor(outcome: ActionOutcome) {
    super(outcome.blockers.map((item) => item.message || item.ruleName).join("；") || "动作被规则拦截。");
    this.name = "ActionBlockedError";
    this.outcome = outcome;
  }
}

const FALLBACK_DISPLAY_KEYS = ["名称", "name", "title", "id"];

export type ActionInvolvementEntry = { id: string; name: string; roles: string[] };
export type ActionInvolvement = { entityTypes: ActionInvolvementEntry[]; relationshipTypes: ActionInvolvementEntry[] };

/** 算关联只需要 id 与名称，不依赖完整定义，前端草稿定义也能直接传进来。 */
type InvolvementDefinition = {
  entityTypes: { id: string; name: string }[];
  relationshipTypes: { id: string; name: string }[];
};

type InvolvementAction = {
  params: { code: string; kind: "ENTITY_REF" | "VALUE"; entityTypeId: string }[];
  edits: { op: "CREATE_ENTITY" | "SET_PROPERTY" | "CREATE_RELATIONSHIP"; alias: string; entityTypeId: string; relationshipTypeId: string; entityRef: { kind: "PARAM" | "EDIT"; code: string } }[];
};

/**
 * 动作与对象类型 / 关系类型的关联。
 *
 * 这不是单独维护的一张关联表，而是从参数和操作模板推导出来的：
 * 入参引用哪个类型、这次新建哪个类型、改哪个类型的属性、建哪条关系。
 * 推导而不是存储，动作改了关联就跟着变，不会漂移。
 */
export function actionInvolvement(definition: InvolvementDefinition, action: InvolvementAction): ActionInvolvement {
  const entityTypes = new Map<string, Set<string>>();
  const relationshipTypes = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, role: string) => {
    if (!id) return;
    const roles = map.get(id) ?? new Set<string>();
    roles.add(role);
    map.set(id, roles);
  };
  const paramType = new Map(action.params.map((item) => [item.code, item.entityTypeId]));
  const aliasType = new Map<string, string>();
  for (const parameter of action.params) if (parameter.kind === "ENTITY_REF") add(entityTypes, parameter.entityTypeId, "入参");
  for (const edit of action.edits) {
    if (edit.op === "CREATE_ENTITY") {
      add(entityTypes, edit.entityTypeId, "新建");
      if (edit.alias) aliasType.set(edit.alias, edit.entityTypeId);
      continue;
    }
    if (edit.op === "SET_PROPERTY") {
      add(entityTypes, edit.entityRef.kind === "PARAM" ? paramType.get(edit.entityRef.code) ?? "" : aliasType.get(edit.entityRef.code) ?? "", "改属性");
      continue;
    }
    add(relationshipTypes, edit.relationshipTypeId, "建立关系");
  }
  const toEntries = (map: Map<string, Set<string>>, nameOf: (id: string) => string) =>
    [...map.entries()].map(([id, roles]) => ({ id, name: nameOf(id) || "（未选类型）", roles: [...roles] }));
  return {
    entityTypes: toEntries(entityTypes, (id) => definition.entityTypes.find((item) => item.id === id)?.name ?? ""),
    relationshipTypes: toEntries(relationshipTypes, (id) => definition.relationshipTypes.find((item) => item.id === id)?.name ?? ""),
  };
}

function fallbackDisplay(node: ActionNode) {
  for (const key of FALLBACK_DISPLAY_KEYS) {
    const value = node.properties[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

/** 对象在界面上的显示名：优先显示属性，其次常见命名键，最后退回类型名。 */
export function actionNodeDisplay(definition: OntologyDefinition, node: ActionNode | undefined) {
  if (!node) return "（对象不存在）";
  const type = definition.entityTypes.find((item) => node.labels.includes(item.name));
  const preferred = type?.displayProperty ? node.properties[type.displayProperty] : undefined;
  const text = typeof preferred === "string" && preferred.trim() ? preferred : fallbackDisplay(node);
  return text ? `${text}` : `${node.labels[0] ?? "对象"}`;
}

function managedLabel(definition: OntologyDefinition, node: ActionNode) {
  return definition.entityTypes.find((item) => node.labels.includes(item.name))?.name ?? node.labels[0] ?? "";
}

type ParameterResolution = { entityId: string | null; value: string | null };

function refKey(kind: "PARAM" | "EDIT", code: string) {
  return `${kind}:${code}`;
}

function rawFromAssignments(
  assignments: { property: string; value: { kind: "PARAM" | "CONST" | "NOW"; code: string; value: string } }[],
  params: Map<string, ParameterResolution>,
) {
  const raw: Record<string, unknown> = {};
  for (const assignment of assignments) {
    if (assignment.value.kind === "NOW") { raw[assignment.property] = new Date().toISOString(); continue; }
    if (assignment.value.kind === "CONST") { raw[assignment.property] = assignment.value.value; continue; }
    const param = params.get(assignment.value.code);
    if (!param) throw new Error(`取值引用了不存在的参数「${assignment.value.code}」。`);
    raw[assignment.property] = param.value ?? "";
  }
  return raw;
}

function matches(actual: unknown, operator: string, compareValue: string) {
  const text = actual === undefined || actual === null ? "" : typeof actual === "object" ? JSON.stringify(actual) : String(actual);
  const expected = compareValue.trim();
  if (operator === "EQUALS") return actual !== undefined && actual !== null && text.trim() === expected;
  if (operator === "NOT_EQUALS") return !(actual !== undefined && actual !== null && text.trim() === expected);
  if (operator === "IS_TRUTHY") return actual === true || text.trim() === "true" || Number(text) === 1;
  if (operator === "IS_FALSY") return actual === undefined || actual === null || actual === false || text.trim() === "false" || text.trim() === "" || Number(text) === 0;
  if (operator === "IS_EMPTY") return actual === undefined || actual === null || text.trim() === "" || (Array.isArray(actual) && actual.length === 0);
  if (operator === "IS_NOT_EMPTY") return !(actual === undefined || actual === null || text.trim() === "" || (Array.isArray(actual) && actual.length === 0));
  return false;
}

function conditionText(definition: OntologyDefinition, subject: string, property: string, actual: unknown, operator: string, compareValue: string) {
  const shown = actual === undefined || actual === null ? "（空）" : String(actual);
  const suffix = operator === "IS_EMPTY" || operator === "IS_NOT_EMPTY" ? "" : ` ${compareValue}`;
  const operatorText = operator === "EQUALS" ? "=" : operator === "NOT_EQUALS" ? "≠" : operator === "IS_TRUTHY" ? "为真" : operator === "IS_FALSY" ? "为假" : operator === "IS_EMPTY" ? "为空" : "非空";
  return `${subject}.${property} = ${shown}（规则要求${suffix ? `${operatorText}${suffix}` : operatorText}）`;
}

/**
 * 执行一次动作的前半段：解析入参、套用操作模板，得到"执行后的图"。
 * 不判断规则，也不落盘。
 */
function planAction(definition: OntologyDefinition, graph: ActionGraph, actionId: string, inputs: ActionRunInput[]) {
  const action = definition.actionTypes.find((item) => item.id === actionId);
  if (!action) throw new Error("动作不存在，请先在「动作」页定义。");

  const nodes = graph.nodes.map((node) => ({ ...node, labels: [...node.labels], properties: { ...node.properties } }));
  const relationships = graph.relationships.map((relationship) => ({ ...relationship, properties: { ...relationship.properties } }));
  const refs = new Map<string, string>();
  const params = new Map<string, ParameterResolution>();
  const steps: string[] = [];
  const createdEntities: { id: string; label: string; display: string }[] = [];

  for (const parameter of action.params) {
    const input = inputs.find((item) => item.code === parameter.code);
    if (parameter.kind === "VALUE") {
      const value = (input?.value ?? "").trim();
      if (parameter.required && !value) throw new Error(`参数「${parameter.name}」不能为空。`);
      params.set(parameter.code, { entityId: null, value });
      continue;
    }
    const entityId = input?.entityId ?? "";
    if (!entityId) {
      if (parameter.required) throw new Error(`参数「${parameter.name}」需要选择一个对象。`);
      params.set(parameter.code, { entityId: null, value: null });
      continue;
    }
    const node = nodes.find((item) => item.id === entityId);
    if (!node) throw new Error(`参数「${parameter.name}」选中的对象不在当前草稿快照里。`);
    const expected = definition.entityTypes.find((item) => item.id === parameter.entityTypeId);
    if (expected && !node.labels.includes(expected.name)) throw new Error(`参数「${parameter.name}」需要「${expected.name}」类型的对象。`);
    refs.set(refKey("PARAM", parameter.code), entityId);
    params.set(parameter.code, { entityId, value: null });
  }

  const resolveRef = (ref: { kind: "PARAM" | "EDIT"; code: string }) => {
    const id = refs.get(refKey(ref.kind, ref.code));
    if (!id) throw new Error(`${ref.kind === "PARAM" ? "参数" : "上一步新建的"}「${ref.code}」没有对应的对象。`);
    return id;
  };
  const nodeOf = (id: string) => nodes.find((item) => item.id === id);

  for (const edit of action.edits) {
    if (edit.op === "CREATE_ENTITY") {
      const type = definition.entityTypes.find((item) => item.id === edit.entityTypeId);
      if (!type) throw new Error("动作要新建的对象类型不存在。");
      const node: ActionNode = { id: randomUUID(), labels: [type.name], properties: parsePropertyValues(type.properties, rawFromAssignments(edit.assignments, params)) };
      nodes.push(node);
      if (edit.alias) refs.set(refKey("EDIT", edit.alias), node.id);
      createdEntities.push({ id: node.id, label: type.name, display: actionNodeDisplay(definition, node) });
      steps.push(`新建${type.name}「${actionNodeDisplay(definition, node)}」`);
      continue;
    }
    if (edit.op === "SET_PROPERTY") {
      const id = resolveRef(edit.entityRef);
      const node = nodeOf(id);
      if (!node) throw new Error("动作要修改的对象不存在。");
      const type = definition.entityTypes.find((item) => item.name === managedLabel(definition, node));
      if (!type) throw new Error("动作要修改的对象没有对应的对象类型。");
      const raw = { ...node.properties, ...rawFromAssignments(edit.assignments, params) };
      node.properties = parsePropertyValues(type.properties, raw);
      const detail = edit.assignments.map((item) => `${item.property}=${rawFromAssignments([item], params)[item.property] ?? ""}`).join("、");
      steps.push(`修改${type.name}「${actionNodeDisplay(definition, node)}」：${detail}`);
      continue;
    }
    const type = definition.relationshipTypes.find((item) => item.id === edit.relationshipTypeId);
    if (!type) throw new Error("动作要建立的关系类型不存在。");
    const sourceId = resolveRef(edit.sourceRef);
    const targetId = resolveRef(edit.targetRef);
    const source = nodeOf(sourceId);
    const target = nodeOf(targetId);
    const sourceType = definition.entityTypes.find((item) => item.id === type.sourceEntityTypeId);
    const targetType = definition.entityTypes.find((item) => item.id === type.targetEntityTypeId);
    if (!source || !target) throw new Error("关系端点不存在。");
    if (!sourceType || !targetType || !source.labels.includes(sourceType.name) || !target.labels.includes(targetType.name)) {
      throw new Error(`关系「${type.name}」的端点不符合契约：需要 ${sourceType?.name ?? "?"} → ${targetType?.name ?? "?"}。`);
    }
    relationships.push({
      id: randomUUID(),
      sourceId,
      targetId,
      type: type.name,
      properties: parsePropertyValues(type.properties, rawFromAssignments(edit.assignments, params)),
    });
    steps.push(`建立关系：${actionNodeDisplay(definition, source)} —${type.name}→ ${actionNodeDisplay(definition, target)}`);
  }

  return { action, nodes, relationships, refs, steps, createdEntities };
}

/**
 * 执行一次动作：先算出结果，再用绑定的规则检查结果。
 * 返回的 graph 通过时是执行结果，被拦截时是原图 —— 调用方直接落盘即可。
 */
export function runAction(definition: OntologyDefinition, graph: ActionGraph, actionId: string, inputs: ActionRunInput[]): ActionOutcome {
  const plan = planAction(definition, graph, actionId, inputs);
  const blockers: ActionFinding[] = [];
  const warnings: ActionFinding[] = [];
  const nodeById = new Map(plan.nodes.map((node) => [node.id, node]));

  const rules = definition.rules
    .filter((rule) => rule.enabled)
    .filter((rule) => !rule.actionId || rule.actionId === plan.action.id)
    .sort((a, b) => b.priority - a.priority);

  for (const rule of rules) {
    if (!rule.conditions.length) continue;
    const evidence: string[] = [];
    let hit = true;
    for (const condition of rule.conditions) {
      const baseId = plan.refs.get(refKey(condition.subject.kind, condition.subject.code));
      const base = baseId ? nodeById.get(baseId) : undefined;
      if (!base) { hit = false; break; }
      const baseName = managedLabel(definition, base);
      if (!condition.subject.relationshipTypeId) {
        const actual = base.properties[condition.property];
        if (!matches(actual, condition.operator, condition.compareValue)) { hit = false; break; }
        evidence.push(conditionText(definition, baseName, condition.property, actual, condition.operator, condition.compareValue));
        continue;
      }
      const relationshipType = definition.relationshipTypes.find((item) => item.id === condition.subject.relationshipTypeId);
      if (!relationshipType) { hit = false; break; }
      const neighbors = plan.relationships
        .filter((relationship) => relationship.type === relationshipType.name)
        .filter((relationship) => condition.subject.direction === "OUT" ? relationship.sourceId === base.id : relationship.targetId === base.id)
        .map((relationship) => condition.subject.direction === "OUT" ? relationship.targetId : relationship.sourceId)
        .map((id) => nodeById.get(id))
        .filter((node): node is ActionNode => Boolean(node));
      const matched = neighbors.find((node) => matches(node.properties[condition.property], condition.operator, condition.compareValue));
      if (!matched) { hit = false; break; }
      evidence.push(conditionText(definition, `邻域「${relationshipType.name}」→${managedLabel(definition, matched)}`, condition.property, matched.properties[condition.property], condition.operator, condition.compareValue));
    }
    if (!hit) continue;
    const finding: ActionFinding = { ruleId: rule.id, ruleName: rule.name, severity: rule.severity, message: rule.message, evidence };
    if (rule.severity === "BLOCKER" && rule.gate) blockers.push(finding); else warnings.push(finding);
  }

  const verdict = blockers.length ? "BLOCKED" : "PASSED";
  return {
    actionId: plan.action.id,
    actionName: plan.action.name,
    actionCode: plan.action.code,
    verdict,
    blockers,
    warnings,
    steps: plan.steps,
    createdEntities: plan.createdEntities,
    graph: verdict === "PASSED" ? { nodes: plan.nodes, relationships: plan.relationships } : { nodes: graph.nodes, relationships: graph.relationships },
  };
}

/**
 * 定义层面的体检：动作和规则引用的类型、参数、别名是否存在。
 * 与实例校验分开：这些错误可以在发布前一次性报出来，不必等到用户点击动作。
 */
export function validateActionDefinition(definition: OntologyDefinition) {
  const violations: { rule: string; message: string; count: number }[] = [];
  const push = (rule: string, message: string) => violations.push({ rule, message, count: 1 });
  const entityTypeById = new Map(definition.entityTypes.map((item) => [item.id, item]));
  const relationshipTypeById = new Map(definition.relationshipTypes.map((item) => [item.id, item]));
  const actionById = new Map(definition.actionTypes.map((item) => [item.id, item]));

  for (const action of definition.actionTypes) {
    const codes = new Set<string>();
    for (const parameter of action.params) {
      if (codes.has(parameter.code)) push(`动作.${action.name}`, `动作「${action.name}」的参数标识「${parameter.code}」重复。`);
      codes.add(parameter.code);
      if (parameter.kind === "ENTITY_REF" && (!parameter.entityTypeId || !entityTypeById.has(parameter.entityTypeId))) {
        push(`动作.${action.name}`, `动作「${action.name}」的参数「${parameter.name}」需要选择一个对象类型。`);
      }
    }
    const aliases = new Set<string>();
    const assertRef = (ref: { kind: "PARAM" | "EDIT"; code: string }, where: string) => {
      if (!ref.code) return push(`动作.${action.name}`, `动作「${action.name}」的${where}还没有选择对象。`);
      if (ref.kind === "PARAM") { if (!codes.has(ref.code)) push(`动作.${action.name}`, `动作「${action.name}」的${where}引用了不存在的参数「${ref.code}」。`); return; }
      if (!aliases.has(ref.code)) push(`动作.${action.name}`, `动作「${action.name}」的${where}引用了不存在的上一步别名「${ref.code}」。`);
    };
    for (const edit of action.edits) {
      if (edit.op === "CREATE_ENTITY") {
        const type = entityTypeById.get(edit.entityTypeId);
        if (!type) { push(`动作.${action.name}`, `动作「${action.name}」要新建的对象类型不存在。`); continue; }
        if (!edit.alias) push(`动作.${action.name}`, `动作「${action.name}」新建「${type.name}」时需要填一个别名，后续步骤才能引用它。`);
        for (const assignment of edit.assignments) {
          if (!type.properties.some((property) => property.name === assignment.property)) push(`动作.${action.name}`, `动作「${action.name}」给「${type.name}」赋值的属性「${assignment.property}」不存在。`);
          if (assignment.value.kind === "PARAM" && !codes.has(assignment.value.code)) push(`动作.${action.name}`, `动作「${action.name}」的取值引用了不存在的参数「${assignment.value.code}」。`);
        }
        if (edit.alias) aliases.add(edit.alias);
        continue;
      }
      if (edit.op === "SET_PROPERTY") {
        assertRef(edit.entityRef, "修改目标");
        continue;
      }
      const type = relationshipTypeById.get(edit.relationshipTypeId);
      if (!type) { push(`动作.${action.name}`, `动作「${action.name}」要建立的关系类型不存在。`); continue; }
      assertRef(edit.sourceRef, `关系「${type.name}」的起点`);
      assertRef(edit.targetRef, `关系「${type.name}」的终点`);
      for (const assignment of edit.assignments) {
        if (!type.properties.some((property) => property.name === assignment.property)) push(`动作.${action.name}`, `动作「${action.name}」给关系「${type.name}」赋值的属性「${assignment.property}」不存在。`);
      }
    }
  }

  for (const rule of definition.rules) {
    if (rule.actionId && !actionById.has(rule.actionId)) push(`规则.${rule.name}`, `规则「${rule.name}」绑定的动作不存在。`);
    if (!rule.conditions.length) push(`规则.${rule.name}`, `规则「${rule.name}」还没有配置条件。`);
    for (const condition of rule.conditions) {
      if (!condition.subject.code) push(`规则.${rule.name}`, `规则「${rule.name}」有条件没有选择主体。`);
      if (condition.subject.relationshipTypeId && !relationshipTypeById.has(condition.subject.relationshipTypeId)) push(`规则.${rule.name}`, `规则「${rule.name}」的条件引用了不存在的关系类型。`);
    }
  }
  return violations;
}
