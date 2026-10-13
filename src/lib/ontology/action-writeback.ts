/**
 * 动作写回业务库的**计划**（纯函数，服务端与界面共用）。
 *
 * 动作在平台里的执行分两段，这里管的是第二段：
 * - 第一段（`action-engine.ts`）：按模板算出"执行后的图"，规则再检查一遍 —— 只动内存 / 草稿快照；
 * - 第二段（本文件 + 数据源连接器的 `updateRows`）：把这次真正改到的属性，翻译成"改哪张表的哪几列"。
 *
 * 三条口径：
 * 1. **只写主来源**，而且必须是**表 / 视图**。取数口径（`kind: DERIVED`）是算出来的结果，写不回去 —— 如实拒绝。
 * 2. **主键列不能用动作改**：对象身份就是它，改了等于换了个对象；要改就得先删后建（现在没做）。
 * 3. **键必须能唯一确定一行**：主键列全都映射到属性、且这个对象上都有值。少一列就拒绝 ——
 *    宁可不写，也不能让"键不唯一"的 UPDATE 改到别人的行（连接器那边还会再确认一次命中一行）。
 *
 * 与 `link-source.ts` / `relationship-keys.ts` 同一层：**只能引浏览器可用的纯函数**，不许引 node: 模块，
 * 否则界面就没法在点「执行」之前把"这次会写哪张表"给用户看。
 */

import { columnForProperty, primaryKeyColumns, propertyForColumn } from "@/lib/ontology/fields";
import type { OntologyDefinition } from "@/lib/ontology";

/** 计划 / 取值只用到对象的这几项，避免把整个定义类型绑进来。 */
type WritebackEntityType = OntologyDefinition["entityTypes"][number];

export type WritebackChange = { property: string; value: unknown };

export type WritebackKey = { column: string; value: unknown };
export type WritebackAssignment = { column: string; property: string; value: unknown };

export type WritebackPlan = {
  entityType: string;
  /** 数据资源 id 与名字（名字只用于显示，取不到就空串）。 */
  dataSourceId: string;
  dataSourceName: string;
  /** 主来源的模式与表 / 视图名（连接器要的就是这两段，别去拆 `table`）。 */
  schema: string;
  view: string;
  /** 表 / 视图，形如 `GISTOOLS.TB_MK_GRP_LINE_LIST_DAY`。 */
  table: string;
  sourceId: string;
  keys: WritebackKey[];
  assignments: WritebackAssignment[];
};

/** 拒绝写回：`reason` 说清为什么，`hint` 给一条能马上走的路（报警必须带路）。 */
export type WritebackRefusal = { reason: string; hint?: string };

export type WritebackPlanResult =
  | { ok: true; plan: WritebackPlan }
  | { ok: false; refusal: WritebackRefusal };

/** 动作执行前后的两张图（只要有节点就够，避免依赖动作引擎的具体类型）。 */
export type ActionGraphLike = {
  nodes: readonly { id: string; labels: readonly string[]; properties: Record<string, unknown> }[];
};

export type ActionWritebackDiff = {
  nodeId: string;
  /** 这个节点属于哪个对象类型（按标签取第一个能对上定义的）。 */
  entityType: string;
  /** 这次动作**新建**的对象：不是"改一行"，当前版本的写回不支持（只支持 UPDATE）。 */
  created: boolean;
  changes: WritebackChange[];
};

/** 属性值是否算"改了"：空值互相等价，其余按字符串口径比 —— 与身份 / 去重那边保持一致。 */
export function samePropertyValue(left: unknown, right: unknown): boolean {
  const empty = (value: unknown) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  if (empty(left) && empty(right)) return true;
  if (empty(left) !== empty(right)) return false;
  const text = (value: unknown) => (typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)).trim();
  return text(left) === text(right);
}

/**
 * 比对动作执行前后的图，算出"这次改了哪些对象的哪些属性"。
 *
 * 用**前后对拍**而不是读动作定义，是因为动作里同一处属性可能被多步改到、也可能被规则拦住；
 * 对拍拿到的是"最后真正变了什么"，与执行结果永远一致。
 */
export function actionWritebackDiffs(definition: OntologyDefinition, before: ActionGraphLike, after: ActionGraphLike): ActionWritebackDiff[] {
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const diffs: ActionWritebackDiff[] = [];
  for (const node of after.nodes) {
    const entityType = node.labels.find((label) => definition.entityTypes.some((item) => item.name === label)) ?? "";
    if (!entityType) continue;
    const previous = beforeById.get(node.id);
    if (!previous) {
      diffs.push({ nodeId: node.id, entityType, created: true, changes: [] });
      continue;
    }
    const changes: WritebackChange[] = [];
    for (const [property, value] of Object.entries(node.properties)) {
      if (property === "fx" || property === "fy") continue;
      if (!samePropertyValue(previous.properties[property], value)) changes.push({ property, value });
    }
    if (changes.length) diffs.push({ nodeId: node.id, entityType, created: false, changes });
  }
  return diffs;
}

function entityTypeOf(definition: OntologyDefinition, name: string): WritebackEntityType | null {
  return definition.entityTypes.find((item) => item.name === name) ?? null;
}

/**
 * 把"这个对象改了这几个属性"翻译成一条写回计划。
 *
 * `properties` 必须是**改之前**的属性（主键值要从旧值取：万一这次动的就是主键列，那是要拒绝的，
 * 但键的取值口径仍以旧值为准）。
 */
export function planActionWriteback(
  definition: OntologyDefinition,
  entityTypeName: string,
  properties: Record<string, unknown>,
  changes: readonly WritebackChange[],
  options: { dataSourceName?: string } = {},
): WritebackPlanResult {
  const type = entityTypeOf(definition, entityTypeName);
  if (!type) return { ok: false, refusal: { reason: `本体里找不到对象类型「${entityTypeName}」。` } };
  const wanted = changes.filter((change) => change.property.trim());
  if (!wanted.length) return { ok: false, refusal: { reason: `${entityTypeName} 这一次没有任何属性变化。` } };

  const source = type.sources?.[0] ?? null;
  if (!source) {
    return { ok: false, refusal: { reason: `对象类型「${type.name}」还没绑数据资源：动作只能写进快照，写不回业务库。`, hint: "在「本体建模 → 对象类型 → 数据来源」给它绑一张表。" } };
  }
  if (!source.dataSourceId) {
    return { ok: false, refusal: { reason: `对象类型「${type.name}」的主来源还没选「数据资源」。`, hint: "在「本体建模 → 对象类型 → 数据来源」选一个数据资源。" } };
  }
  if (source.kind === "DERIVED" || (source.sql ?? "").trim()) {
    return { ok: false, refusal: { reason: `对象类型「${type.name}」的主来源是取数口径（算出来的结果），没有可以改的那一行。`, hint: "要写回就把主来源换成表 / 视图；口径只用来读。" } };
  }
  if (!source.view.trim()) {
    return { ok: false, refusal: { reason: `对象类型「${type.name}」的主来源还没选表 / 视图。`, hint: "在「本体建模 → 对象类型 → 数据来源」选一张表。" } };
  }

  const columns = primaryKeyColumns(type);
  if (!columns.length) {
    return { ok: false, refusal: { reason: `对象类型「${type.name}」还没配主键列：定位不到要改哪一行。`, hint: "在「本体建模 → 对象类型 → 数据来源」把主键列配上。" } };
  }
  const keys: WritebackKey[] = [];
  for (const column of columns) {
    const property = propertyForColumn(type, column);
    if (!property) {
      return { ok: false, refusal: { reason: `主键列 ${column} 没有映射到对象类型「${type.name}」的任何属性，定位不到这一行。`, hint: `去「${type.name}」的属性里，把主键列 ${column} 映射到对应属性。` } };
    }
    const value = properties[property];
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      return { ok: false, refusal: { reason: `这个对象的 ${property}（主键列 ${column}）没有值，定位不到源表里的那一行。`, hint: "先把对象取全（对象页点开它）再执行动作。" } };
    }
    keys.push({ column, value });
  }

  const keyProperties = new Set(keys.map((key) => propertyForColumn(type, key.column)));
  const assignments: WritebackAssignment[] = [];
  for (const change of wanted) {
    const property = type.properties.find((item) => item.name === change.property);
    if (!property) {
      return { ok: false, refusal: { reason: `对象类型「${type.name}」上已经没有属性「${change.property}」了。` } };
    }
    const column = columnForProperty(type, property.name);
    if (!column) {
      return { ok: false, refusal: { reason: `属性「${property.name}」没有映射到源表的列，改不了业务库里的值。`, hint: "在对象类型的属性里给它选一个来源列。" } };
    }
    const owner = (property.sourceId ?? "").trim() || source.id;
    if (owner !== source.id) {
      return { ok: false, refusal: { reason: `属性「${property.name}」挂在补充来源上，写回只支持主来源。`, hint: "把这个属性改到主来源，或者这次别改它。" } };
    }
    if (keyProperties.has(property.name)) {
      return { ok: false, refusal: { reason: `动作要改主键属性「${property.name}」—— 主键是对象的身份，改了等于换一个对象。`, hint: "主键不参与写回；确实要改就走「新建一个对象」的动作。" } };
    }
    assignments.push({ column, property: property.name, value: change.value });
  }
  if (!assignments.length) return { ok: false, refusal: { reason: `${entityTypeName} 这一次没有可以写回源表的改动。` } };

  return {
    ok: true,
    plan: {
      entityType: type.name,
      dataSourceId: source.dataSourceId,
      dataSourceName: options.dataSourceName ?? "",
      schema: source.schema ?? "",
      view: source.view,
      table: [source.schema, source.view].filter(Boolean).join("."),
      sourceId: source.id,
      keys,
      assignments,
    },
  };
}

/** 计划的一句话说明（界面与审计共用，两处说法不许各写一份）。 */
export function describeWritebackPlan(plan: WritebackPlan): string {
  const where = plan.keys.map((key) => `${key.column} = ${key.value}`).join(" 且 ");
  const sets = plan.assignments.map((item) => item.column).join("、");
  return `改 ${plan.table} 里 ${where} 的那一行：${sets}`;
}
