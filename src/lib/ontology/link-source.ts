import { columnForProperty, primaryKeyColumns, type IdentityEntityType } from "@/lib/instance/object-identity";
import { keyMappingRows, primaryKeyPropertyNames, type KeyMapping } from "@/lib/ontology/relationship-keys";

/**
 * 关系类型的数据来源（backlog D2）：把「这条关系类型的实例存在哪儿」翻译成**一次取数计划**。
 *
 * 为什么单开一层：定义层说的是属性（`entityProperty`）、键映射说的是连接属性（`linkProperty`），
 * 而 SQL 只认真实列名。这三者的换算只能有一处，否则每加一种模式就要在服务、接口、界面各写一遍。
 * 本文件是**纯函数**（不连库、不认识 TypeORM），单测可以直接摆最小定义。
 *
 * 两种支撑方式（对齐 Palantir 的 link type backing datasource）：
 * - `JOIN_TABLE`：多对多。连接行从中间表读，两端的键映射各自指明"中间表的哪一列 = 该端主键的哪一列"；
 * - `FOREIGN_KEY`：多对一 / 一对一。外键长在某一端的表上，连接行就从那张表读：
 *   外键列的值 = 被引用端对象的主键值，同一行的主键列 = 持有外键那一端对象自己的身份。
 */

export type LinkSourceMode = "JOIN_TABLE" | "FOREIGN_KEY";

/** 关系类型上的 `linkSource`（老快照没有这一项，读出来是"没配"）。 */
export type LinkSourceConfig = {
  mode: LinkSourceMode;
  dataSourceId: string;
  schema: string;
  view: string;
  /** FOREIGN_KEY：外键长在哪一端；AUTO = 按两端键映射推断。 */
  foreignKeySide: "SOURCE" | "TARGET" | "AUTO";
};

export type LinkSourceEntity = IdentityEntityType & {
  id: string;
  sources?: readonly { id: string; primaryKey: readonly string[]; view?: string; schema?: string; dataSourceId?: string }[];
};

export type LinkSourceRelation = {
  id?: string;
  name: string;
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  sourceKeyMappings?: readonly KeyMapping[];
  targetKeyMappings?: readonly KeyMapping[];
  linkSource?: Partial<LinkSourceConfig> | null;
};

export type LinkSourceDefinition = {
  entityTypes: readonly LinkSourceEntity[];
  relationshipTypes: readonly LinkSourceRelation[];
};

/** 一条键映射落到表上：读哪一列、放到对象主键的哪一列。 */
export type LinkKeyPair = { rowColumn: string; keyColumn: string };

export type LinkPlan =
  | {
      ok: true;
      mode: "JOIN_TABLE";
      dataSourceId: string;
      /** 连接行从哪张表读。 */
      table: { schema: string; name: string };
      /** 需要取出来的列（去重后）。 */
      columns: string[];
      source: { entityTypeId: string; entityTypeName: string; pairs: LinkKeyPair[] };
      target: { entityTypeId: string; entityTypeName: string; pairs: LinkKeyPair[] };
      warnings: string[];
    }
  | {
      ok: true;
      mode: "FOREIGN_KEY";
      dataSourceId: string;
      table: { schema: string; name: string };
      columns: string[];
      /** 外键长在哪一端 —— 身份由那一端的表提供。 */
      keyHolder: "SOURCE" | "TARGET";
      /** 持有外键的那一端：它自己的主键列就在这张表里，直接读。 */
      holder: { entityTypeId: string; entityTypeName: string; keyColumns: string[] };
      /** 外键列 -> 被引用端对象主键的列，按顺序一一对应。 */
      foreignKeys: { rowColumns: string[]; keyColumns: string[]; referenced: { entityTypeId: string; entityTypeName: string } };
      warnings: string[];
    }
  | { ok: false; reason: string };

export function normalizeLinkSource(source: Partial<LinkSourceConfig> | null | undefined): LinkSourceConfig {
  return {
    mode: source?.mode === "FOREIGN_KEY" ? "FOREIGN_KEY" : "JOIN_TABLE",
    dataSourceId: (source?.dataSourceId ?? "").trim(),
    schema: (source?.schema ?? "").trim(),
    view: (source?.view ?? "").trim(),
    foreignKeySide: source?.foreignKeySide === "SOURCE" || source?.foreignKeySide === "TARGET" ? source.foreignKeySide : "AUTO",
  };
}

/** 这条关系类型**显式**配了数据来源（外键式现在可以零配置，判"有没有边可读"用 `hasKeyMappings` + `planLinkSource`）。 */
export function isLinkSourceConfigured(source: Partial<LinkSourceConfig> | null | undefined) {
  const config = normalizeLinkSource(source);
  return Boolean(config.dataSourceId);
}

/** 两端键映射填了内容吗。没有 = 这条关系类型只在类型层声明，读不出实例（合法）。 */
export function hasKeyMappings(relation: LinkSourceRelation) {
  return keyMappingRows(relation.sourceKeyMappings).length > 0 || keyMappingRows(relation.targetKeyMappings).length > 0;
}

/**
 * 按两端键映射判断"外键长在哪一端"：**映射到该端非主键属性的一侧**就是持有外键的那一端，
 * 另一侧映射的是它自己的主键（被引用的对象）。
 * 两侧都像主键、或两侧都不像主键（含键映射为空）时判不出来 → null，交给人在界面上指定。
 */
export function inferForeignKeySide(
  source: LinkSourceEntity,
  target: LinkSourceEntity,
  sourceRows: readonly { entityProperty: string }[],
  targetRows: readonly { entityProperty: string }[],
): "SOURCE" | "TARGET" | null {
  const mapsOwnKey = (entity: LinkSourceEntity, rows: readonly { entityProperty: string }[]) => {
    const keys = new Set(primaryKeyPropertyNames(entity));
    return rows.length > 0 && rows.every((row) => row.entityProperty && keys.has(row.entityProperty));
  };
  const sourceIsReferenced = mapsOwnKey(source, sourceRows);
  const targetIsReferenced = mapsOwnKey(target, targetRows);
  if (targetIsReferenced && !sourceIsReferenced) return "SOURCE";
  if (sourceIsReferenced && !targetIsReferenced) return "TARGET";
  return null;
}

function sidePairs(entity: LinkSourceEntity, rows: readonly KeyMapping[]): LinkKeyPair[] {
  return rows
    .filter((row) => row.linkProperty && row.entityProperty)
    .map((row) => ({ rowColumn: row.linkProperty as string, keyColumn: columnForProperty(entity, row.entityProperty as string) }))
    .filter((pair) => pair.keyColumn);
}

/** 一侧的键映射有没有把该端主键列覆盖全 —— 覆盖不全，算出来的对象身份跟对象服务对不上，边会悬空。 */
function sideProblems(label: string, relationName: string, entity: LinkSourceEntity, rows: readonly KeyMapping[], pairs: readonly LinkKeyPair[]) {
  const problems: string[] = [];
  for (const row of rows) {
    if (!row.entityProperty) problems.push(`${label}有一条键映射没选对象类型「${entity.name}」上的属性`);
    else if (!columnForProperty(entity, row.entityProperty)) problems.push(`${label}的「${row.entityProperty}」在对象类型「${entity.name}」上没有对应列`);
  }
  const covered = new Set(pairs.map((pair) => pair.keyColumn));
  const missing = primaryKeyColumns(entity).filter((column) => !covered.has(column));
  if (missing.length) problems.push(`${label}的键映射没覆盖对象类型「${entity.name}」的主键列（缺 ${missing.join("、")}）`);
  return problems.map((text) => `关系类型「${relationName}」${text}`);
}

/**
 * 把一条关系类型的 `linkSource` + 两侧键映射翻译成取数计划。
 * 失败一律给"人话原因"：调用方直接拿去当界面提示 / 校验提醒。
 *
 * **形态由键映射决定，不用人再选一遍**：
 * - 任一侧填了「连接列」(`linkProperty`) = 中间表式（多对多）—— 连接行在**第三张表**里，必须说清是哪张；
 * - 两侧都只有「属性」(`entityProperty`) = 外键式（多对一 / 一对一）—— 连接行就是**外键所在端自己的表**里的一行，
 *   表与数据来源都能从那一端对象类型的主来源推出来，所以**外键式可以零配置**。
 * `mode` 只在显式选了外键式时当约束用（外键式不该填连接列）。
 */
export function planLinkSource(definition: LinkSourceDefinition, relation: LinkSourceRelation): LinkPlan {
  const config = normalizeLinkSource(relation.linkSource);
  const source = definition.entityTypes.find((entity) => entity.id === relation.sourceEntityTypeId);
  const target = definition.entityTypes.find((entity) => entity.id === relation.targetEntityTypeId);
  if (!source || !target) return { ok: false, reason: `关系类型「${relation.name}」的起始端 / 终止端对象类型还没选全。` };

  const mappedSourceRows = keyMappingRows(relation.sourceKeyMappings);
  const mappedTargetRows = keyMappingRows(relation.targetKeyMappings);
  const junctionStyle = mappedSourceRows.some((row) => row.linkProperty) || mappedTargetRows.some((row) => row.linkProperty);

  if (config.mode !== "FOREIGN_KEY" && junctionStyle) {
    if (!config.dataSourceId) return { ok: false, reason: `关系类型「${relation.name}」还没选数据资源。` };
    if (!config.view) return { ok: false, reason: `关系类型「${relation.name}」还没选连接表。` };
    const sourceRows = mappedSourceRows;
    const targetRows = mappedTargetRows;
    const sourcePairs = sidePairs(source, sourceRows);
    const targetPairs = sidePairs(target, targetRows);
    const problems = [
      ...sideProblems("起始端", relation.name, source, sourceRows, sourcePairs),
      ...sideProblems("终止端", relation.name, target, targetRows, targetPairs),
    ];
    if (problems.length) return { ok: false, reason: problems.join("；") + "。" };
    const columns = [...new Set([...sourcePairs.map((pair) => pair.rowColumn), ...targetPairs.map((pair) => pair.rowColumn)])];
    return {
      ok: true,
      mode: "JOIN_TABLE",
      dataSourceId: config.dataSourceId,
      table: { schema: config.schema, name: config.view },
      columns,
      source: { entityTypeId: source.id, entityTypeName: source.name, pairs: sourcePairs },
      target: { entityTypeId: target.id, entityTypeName: target.name, pairs: targetPairs },
      warnings: [],
    };
  }

  /* ---------------- 外键式（多对一 / 一对一） ---------------- */
  const inferredSide = config.foreignKeySide === "AUTO" ? inferForeignKeySide(source, target, mappedSourceRows, mappedTargetRows) : null;
  const keyHolder = config.foreignKeySide === "AUTO" ? inferredSide : config.foreignKeySide;
  if (!keyHolder) {
    return {
      ok: false,
      reason: `关系类型「${relation.name}」判断不出外键长在哪一端：两端键映射看起来不满足"一侧填该端主键、另一侧填外键"。请在关系类型里手动指定外键所在端，或者改填连接列走连接表式。`,
    };
  }
  const holderEntity = keyHolder === "SOURCE" ? source : target;
  const referencedEntity = keyHolder === "SOURCE" ? target : source;
  const holderRows = keyMappingRows(keyHolder === "SOURCE" ? relation.sourceKeyMappings : relation.targetKeyMappings);
  const referencedRows = keyMappingRows(keyHolder === "SOURCE" ? relation.targetKeyMappings : relation.sourceKeyMappings);
  const holderLabel = keyHolder === "SOURCE" ? "起始端" : "终止端";
  const referencedLabel = keyHolder === "SOURCE" ? "终止端" : "起始端";

  const problems: string[] = [];
  const foreignKeyRowColumns: string[] = [];
  for (const row of holderRows) {
    if (!row.entityProperty) problems.push(`关系类型「${relation.name}」${holderLabel}（外键所在端）有一条键映射没选属性`);
    else foreignKeyRowColumns.push(columnForProperty(holderEntity, row.entityProperty));
    if (row.linkProperty) problems.push(`关系类型「${relation.name}」是外键式，${holderLabel}的键映射不该填连接列「${row.linkProperty}」（那是中间表式才用的）`);
  }
  const keyColumns: string[] = [];
  for (const row of referencedRows) {
    if (!row.entityProperty) problems.push(`关系类型「${relation.name}」${referencedLabel}有一条键映射没选属性`);
    else keyColumns.push(columnForProperty(referencedEntity, row.entityProperty));
    if (row.linkProperty) problems.push(`关系类型「${relation.name}」是外键式，${referencedLabel}的键映射不该填连接列「${row.linkProperty}」`);
  }
  if (!foreignKeyRowColumns.length) problems.push(`关系类型「${relation.name}」${holderLabel}没写外键属性`);
  if (foreignKeyRowColumns.length !== keyColumns.length) problems.push(`关系类型「${relation.name}」的外键式映射两侧条数不一样（${foreignKeyRowColumns.length} / ${keyColumns.length}），按顺序一一对应，要一样多`);
  const holderKeyColumns = primaryKeyColumns(holderEntity);
  if (!holderKeyColumns.length) problems.push(`关系类型「${relation.name}」${holderLabel}的对象类型「${holderEntity.name}」还没配主键，读不出它是哪个对象`);
  const referencedKeys = primaryKeyColumns(referencedEntity);
  const uncovered = keyColumns.filter((column) => !referencedKeys.includes(column)).join("、");
  if (uncovered) problems.push(`关系类型「${relation.name}」${referencedLabel}的键映射指向了对象类型「${referencedEntity.name}」的非主键列（${uncovered}）`);
  if (problems.length) return { ok: false, reason: [...new Set(problems)].join("；") + "。" };

  // 表与数据资源：显式指定优先；否则用外键所在端对象类型的主来源（这就是"外键式零配置"）。
  const holderPrimary = (holderEntity.sources ?? [])[0];
  const dataSourceId = config.dataSourceId || (holderPrimary?.dataSourceId ?? "");
  const schema = config.schema || (holderPrimary?.schema ?? "");
  const name = config.view || (holderPrimary?.view ?? "");
  if (!dataSourceId) {
    return {
      ok: false,
      reason: `关系类型「${relation.name}」读不出边：外键所在端的对象类型「${holderEntity.name}」还没绑数据来源，也没在这条关系类型上指定。`,
    };
  }
  if (!name) return { ok: false, reason: `关系类型「${relation.name}」没选表，而外键所在端的对象类型「${holderEntity.name}」也没有主来源表可依。` };
  const columns = [...new Set([...holderKeyColumns, ...foreignKeyRowColumns])];
  return {
    ok: true,
    mode: "FOREIGN_KEY",
    dataSourceId,
    table: { schema, name },
    columns,
    keyHolder,
    holder: { entityTypeId: holderEntity.id, entityTypeName: holderEntity.name, keyColumns: holderKeyColumns },
    foreignKeys: { rowColumns: foreignKeyRowColumns, keyColumns, referenced: { entityTypeId: referencedEntity.id, entityTypeName: referencedEntity.name } },
    warnings: inferredSide
      ? [`外键式（自动判断）：外键在「${holderLabel}」(${holderEntity.name})，表取它的主来源 ${[schema, name].filter(Boolean).join(".")}。`]
      : [],
  };
}

/** 从一行连接数据里取出某一端的对象主键；缺值的列由调用方丢弃这一行。 */
export function linkKeyFromRow(pairs: readonly LinkKeyPair[], row: Record<string, unknown>, read: (row: Record<string, unknown>, column: string) => string): Record<string, string> {
  const key: Record<string, string> = {};
  for (const pair of pairs) {
    const value = read(row, pair.rowColumn);
    if (!value) return {};
    key[pair.keyColumn] = value;
  }
  return key;
}

/** 校验用的一条结论，形状与 `SnapshotViolation` 一致（severity 为 WARN 的不挡发布）。 */
export type LinkSourceViolation = { rule: string; message: string; count: number; severity?: "WARN" };

/**
 * 关系类型数据来源的自检。
 *
 * 口径和来源绑定一致：**没配不算错**（纯类型层建模允许）。
 * 判据是"两端键映射填了吗"，不是"配了数据资源吗" —— 外键式可以零配置（表/来源/外键端全按两端键映射推断），
 * 只有**填了键映射却排不出取数计划**才说话（典型：中间表式没选连接表），而且一律 WARN ——
 * 它影响的是能不能读实例，不影响定义自洽。
 */
export function linkSourceViolations(definition: LinkSourceDefinition): LinkSourceViolation[] {
  const violations: LinkSourceViolation[] = [];
  for (const relation of definition.relationshipTypes) {
    if (!hasKeyMappings(relation)) continue;
    const plan = planLinkSource(definition, relation);
    if (plan.ok) continue;
    violations.push({ rule: `${relation.name}.数据来源`, message: plan.reason + "配上之前，这条关系类型读不出实例（图上看不到它连的边）。", count: 1, severity: "WARN" });
  }
  return violations;
}
