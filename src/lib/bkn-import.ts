import { buildOntologyBundle, type OntologyBundle } from "@/lib/ontology-bundle";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * bkn-foundry 导出的「知识网络」→ 平台的本体包。
 *
 * 这是**外部格式的适配层**，不是平台的第二种包格式：转换出来仍然是一个标准
 * `ontology.bundle`，照样走 `POST /api/ontologies/import`（换 id、接数据资源、写草稿都在那边）。
 *
 * bkn 的字段比我们多，转换时**只搬我们装得下的，其余逐条报出来** —— 静默丢内容比报错更糟。
 * 装得下：对象类型（含属性 / 主键 / 数据来源）、关系类型（含说明）、概念分组（concept_groups → `groups`）。
 * 已知装不下的（见 warnings）：指标、关系类型的连接规则（mapping_rules）、
 * 以及每类对象上的 operations（那是「能不能查/能增删改」的能力开关，不是带参数与规则的动作定义）。
 *
 * 记录时间：2026-09-14。
 */

/** bkn 的属性类型 → 平台的属性类型。对不上的一律退到 TEXT 并记一条提醒。 */
const TYPE_MAP: Record<string, string> = {
  string: "TEXT",
  text: "TEXT",
  varchar: "TEXT",
  char: "TEXT",
  integer: "INTEGER",
  int: "INTEGER",
  long: "INTEGER",
  bigint: "INTEGER",
  decimal: "DECIMAL",
  numeric: "DECIMAL",
  float: "DECIMAL",
  double: "DECIMAL",
  number: "DECIMAL",
  money: "DECIMAL",
  boolean: "BOOLEAN",
  bool: "BOOLEAN",
  date: "DATE",
  datetime: "DATETIME",
  timestamp: "DATETIME",
  array: "TEXT_ARRAY",
  list: "TEXT_ARRAY",
  json: "JSON",
  object: "JSON",
  map: "JSON",
  struct: "JSON",
};

type Unknown = Record<string, unknown>;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

/** 这个 JSON 看起来是不是 bkn 的知识网络导出。 */
export function isBknKnowledgeNetwork(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const record = raw as Unknown;
  if (text(record.module_type) === "knowledge_network") return true;
  return Array.isArray(record.object_types) && Array.isArray(record.relation_types) && typeof record.name === "string";
}

export type BknConversion = { bundle: OntologyBundle; warnings: string[] };

/**
 * 转换。产出的 bundle 里 `sources[].dataSourceId` 一律留空：
 * bkn 的文件只写了「SCHEMA.TABLE」，没有数据库连接坐标，所以资源要由导入端自己挑。
 */
export function fromBknKnowledgeNetwork(raw: unknown): BknConversion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("bkn 知识网络应该是一个 JSON 对象。");
  const source = raw as Unknown;
  const objectTypes = Array.isArray(source.object_types) ? (source.object_types as Unknown[]) : [];
  const relationTypes = Array.isArray(source.relation_types) ? (source.relation_types as Unknown[]) : [];
  if (!objectTypes.length) throw new Error("这个 bkn 文件里没有 object_types，导不出本体结构。");

  const warnings: string[] = [];
  const nameOf = new Map<string, string>();
  const idMap = new Map<string, string>();

  const entityTypes: OntologyDefinition["entityTypes"] = objectTypes.map((item) => {
    const oldId = text(item.id);
    const name = text(item.name) || "未命名";
    const newId = crypto.randomUUID();
    if (oldId) idMap.set(oldId, newId);
    nameOf.set(newId, name);

    const primaryKeys = list(item.primary_keys);
    const displayKey = text(item.display_key);
    const dataSource = (item.data_source ?? {}) as Unknown;
    const resourceName = text(dataSource.name);
    const properties = (Array.isArray(item.data_properties) ? (item.data_properties as Unknown[]) : []).map((entry) => {
      const propertyName = text(entry.name);
      const displayName = text(entry.display_name);
      const rawType = text(entry.type).toLowerCase();
      const dataType = (TYPE_MAP[rawType] ?? "TEXT") as OntologyDefinition["entityTypes"][number]["properties"][number]["dataType"];
      if (rawType && !TYPE_MAP[rawType]) warnings.push(`对象类型「${name}」的属性「${propertyName}」类型是 ${rawType}，平台没有对应类型，按文本导入。`);
      const isKey = primaryKeys.includes(propertyName);
      const mapped = (entry.mapped_field ?? {}) as Unknown;
      const mappedName = text(mapped.name);
      return {
        name: propertyName,
        // 显示名和机器名一样就不重复存，界面上会自动退回 name。
        displayName: displayName && displayName !== propertyName ? displayName : "",
        description: text(entry.comment),
        dataType,
        required: isKey,
        unique: isKey,
        indexed: false,
        // bkn 的 mapped_field 是「这个属性来自哪一列」，"-" 表示没有对应列。
        sourceField: resourceName && mappedName && mappedName !== "-" ? mappedName : "",
        sourceId: resourceName ? "primary" : "",
      };
    });

    for (const key of primaryKeys) {
      if (!properties.some((property) => property.name === key)) warnings.push(`对象类型「${name}」的主键列「${key}」没有对应属性，已跳过。`);
    }

    if (!resourceName) {
      if (primaryKeys.length) warnings.push(`对象类型「${name}」没有数据来源，主键（${primaryKeys.join("、")}）改记在属性上：标成必填 + 唯一。`);
      return { id: newId, name, description: text(item.comment), displayProperty: displayKey, groupId: "", implements: [], interfaceMappings: [], properties, sources: [] } as OntologyDefinition["entityTypes"][number];
    }

    // "GISTOOLS.TB_MK_GRP_LINE_LIST_DAY" → schema=GISTOOLS, view=TB_MK_GRP_LINE_LIST_DAY
    const dot = resourceName.indexOf(".");
    const schema = dot > 0 ? resourceName.slice(0, dot) : "";
    const view = dot > 0 ? resourceName.slice(dot + 1) : resourceName;
    warnings.push(`对象类型「${name}」原先指向 ${resourceName}；bkn 文件不带数据库连接，导入后请在类型编辑里为它选一次数据资源。`);
    return {
      id: newId,
      name,
      description: text(item.comment),
      displayProperty: displayKey,
      implements: [],
      interfaceMappings: [],
      groupId: "",
      properties,
      sources: [{ id: "primary", dataSourceId: "", schema, view, primaryKey: primaryKeys, titleField: displayKey }],
    } as OntologyDefinition["entityTypes"][number];
  });

  let droppedMappings = 0;
  const mappings: OntologyDefinition["relationshipTypes"] = relationTypes.map((item) => {
    const oldSource = text(item.source_object_type_id);
    const oldTarget = text(item.target_object_type_id);
    const from = idMap.get(oldSource) ?? "";
    const to = idMap.get(oldTarget) ?? "";
    const name = text(item.name) || "未命名关系";
    if (!from || !to) warnings.push(`关系类型「${name}」的端点找不到对应对象类型，导入后请手动补选起点与终点。`);
    const rules = Array.isArray(item.mapping_rules) ? item.mapping_rules.length : 0;
    droppedMappings += rules;
    return { id: crypto.randomUUID(), name, description: text(item.comment), sourceEntityTypeId: from, targetEntityTypeId: to, sourceKeyMappings: [], targetKeyMappings: [], properties: [] } as OntologyDefinition["relationshipTypes"][number];
  });

  if (droppedMappings > 0) warnings.push(`bkn 里的 ${droppedMappings} 条关系连接规则（mapping_rules，靠两边哪些字段相等来连边）平台还没有对应的模型，本次没有导入。`);

  /*
   * 概念域分组（concept_groups）→ 平台的概念分组。
   *
   * 分组成员在 bkn 里写在分组这一侧（`object_type_ids`），平台的 `groupId` 写在对象类型那一侧，
   * 所以这里反过来铺一次；成员 id 可能是 UUID，也可能是 `account` 这样的短标识，都按 idMap 找。
   * 一个对象类型只能属于一个分组：文件里挂在多个分组时按文件顺序保留第一个，并把条数报出来。
   */
  const conceptGroups = Array.isArray(source.concept_groups) ? (source.concept_groups as Unknown[]) : [];
  const groups: OntologyDefinition["groups"] = [];
  const groupOfEntity = new Map<string, string>();
  let missingMembers = 0;
  let duplicateMembers = 0;
  for (const entry of conceptGroups) {
    const groupName = text(entry.name);
    if (!groupName) continue;
    const groupId = crypto.randomUUID();
    groups.push({ id: groupId, name: groupName, color: text(entry.color).slice(0, 32) });
    for (const memberId of list(entry.object_type_ids)) {
      const entityId = idMap.get(memberId);
      if (!entityId) { missingMembers += 1; continue; }
      if (groupOfEntity.has(entityId)) { duplicateMembers += 1; continue; }
      groupOfEntity.set(entityId, groupId);
    }
  }
  if (missingMembers > 0) warnings.push(`概念分组里有 ${missingMembers} 个成员在本文件里找不到对应对象类型，已跳过。`);
  if (duplicateMembers > 0) warnings.push(`有 ${duplicateMembers} 个对象类型同时挂在多个概念分组里，按文件顺序只保留了第一个（一个对象类型只能属于一个分组）。`);
  const grouped = entityTypes.map((entity) => {
    const groupId = groupOfEntity.get(entity.id);
    return groupId ? { ...entity, groupId } : entity;
  });
  /*
   * operations：bkn 里是 view_detail / create / modify / delete / query_data / authorize / task_manage
   * 这类**能力开关**，既没有参数也没有规则，和我们这边的「动作」（Palantir Action Type：定义在某个
   * 对象类型上、带参数与提交校验）不是一回事。硬造一堆同名的空动作只会污染动作清单，所以不导，但要说出来。
   */
  const operations = list(source.operations);
  if (operations.length) warnings.push(`bkn 里的 ${operations.length} 类操作能力（${operations.join("、")}）是权限开关而不是动作定义，平台的动作还需要参数与校验规则，本次没有导入。`);

  const metrics = Array.isArray(source.metrics) ? source.metrics : [];
  if (metrics.length) warnings.push(`bkn 里的 ${metrics.length} 条指标（${metrics.map((metric) => text((metric as Unknown).name)).filter(Boolean).join("、")}）平台还没有对应的模型，本次没有导入。`);

  const bundle = buildOntologyBundle({
    ontology: {
      identifier: text(source.id),
      name: text(source.name) || "未命名本体",
      description: text(source.comment),
      color: text(source.color),
      tags: list(source.tags),
    },
    definition: { groups, interfaces: [], entityTypes: grouped, relationshipTypes: mappings, actionTypes: [], rules: [] },
  });

  return { bundle, warnings };
}
