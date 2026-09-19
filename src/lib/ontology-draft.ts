import type { ConceptGroup as ConceptGroupDefinition, EntitySource as EntitySourceDefinition, InterfaceType as InterfaceTypeDefinition, OntologyDefinition } from "@/lib/ontology";
import type { LegacyEntitySource } from "@/lib/ontology-sources";

/**
 * 草稿定义在前端的形态：与 `@/lib/ontology` 的 zod 结果结构一致，
 * 但 `displayProperty` 允许缺省——新建类型时前端先不写这一项。
 */
export type PropertyDataType = OntologyDefinition["entityTypes"][number]["properties"][number]["dataType"];
/** 属性的界面形态：`name` 是机器名，`displayName` / `description` 是给人看的（导入外部本体时会带上原文）。 */
export type Property = { name: string; displayName?: string; description?: string; dataType: PropertyDataType; required: boolean; unique: boolean; indexed: boolean; sourceField?: string; sourceId?: string };

/** 类的一份数据来源：一张表/视图，属性和列一一对应。 */
export type EntitySource = EntitySourceDefinition;
export type { LegacyEntitySource } from "@/lib/ontology-sources";

export type EntityType = {
  id: string;
  name: string;
  description: string;
  displayProperty?: string;
  /** 所属逻辑分组（`Definition.groups` 里的 id）；缺省或空串表示还没归组。 */
  groupId?: string;
  /** 实现的接口（`Definition.interfaces` 里的 id）；一个对象类型可以实现多个接口。 */
  implements?: string[];
  /** 接口属性的显式映射：接口属性名 → 本对象类型的属性名。没写就按同名匹配。 */
  interfaceMappings?: { interfaceId: string; properties: Record<string, string>; actions?: Record<string, string> }[];
  properties: Property[];
  /** sources[0] 是主来源，决定对象身份与标题；后面的是按主键补充属性的来源。 */
  sources?: EntitySource[];
  /** 旧快照的单来源字段，读的时候用 entitySources() 归一，写的时候不再输出。 */
  source?: LegacyEntitySource;
};

/** 还没接来源时的空绑定；直接写全字段，省得每处都判空。 */
export function emptyEntitySource(id = "primary"): EntitySource {
  return { id, dataSourceId: "", schema: "", view: "", primaryKey: [], titleField: "" };
}

/** 来源清单的读写与自检都在 @/lib/ontology-sources，这里转出去，界面只认这一个入口。 */
export { LEGACY_PRIMARY_SOURCE_ID, entitySources, newEntitySourceId, sourceFieldsKey, sourceName, sourceRoleLabel, validateEntitySources, type SourceViolation } from "@/lib/ontology-sources";
/** 关系类型（草稿态）：一条关系类型只有一份定义、两个端点，两个方向都能走，不用再建反向的那一条。 */
export type RelationType = { id: string; name: string; description?: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
export type ActionParameter = OntologyDefinition["actionTypes"][number]["params"][number];
export type ActionValueSource = OntologyDefinition["actionTypes"][number]["edits"][number]["assignments"][number]["value"];
export type ActionEdit = OntologyDefinition["actionTypes"][number]["edits"][number];
export type ActionType = OntologyDefinition["actionTypes"][number];
export type RuleCondition = OntologyDefinition["rules"][number]["conditions"][number];
export type RuleEffect = OntologyDefinition["rules"][number]["effect"];
export type RuleOperator = RuleCondition["operator"];
export type OntologyRule = OntologyDefinition["rules"][number];
/** 概念分组（业务域）：对象类型按它归堆，图谱里按组画框。 */
export type ConceptGroup = ConceptGroupDefinition;
/** 接口：抽象契约，只描述属性与关系约束，不绑数据、不能被实例化。 */
export type InterfaceType = InterfaceTypeDefinition;
export type InterfaceLinkConstraint = InterfaceTypeDefinition["linkConstraints"][number];
export type Definition = { groups: ConceptGroup[]; interfaces: InterfaceType[]; entityTypes: EntityType[]; relationshipTypes: RelationType[]; actionTypes: ActionType[]; rules: OntologyRule[] };

export const propertyTypeOptions: PropertyDataType[] = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"];

/** 规则条件的可选操作符，界面按这个顺序展示。 */
export const ruleOperatorOptions: { value: RuleOperator; label: string }[] = [
  { value: "EQUALS", label: "等于" },
  { value: "NOT_EQUALS", label: "不等于" },
  { value: "IS_TRUTHY", label: "为真" },
  { value: "IS_FALSY", label: "为假" },
  { value: "IS_EMPTY", label: "为空" },
  { value: "IS_NOT_EMPTY", label: "非空" },
];

/** 不参与比较的操作符，界面上隐藏"比较值"输入框。 */
export const ruleOperatorsWithoutValue: RuleOperator[] = ["IS_TRUTHY", "IS_FALSY", "IS_EMPTY", "IS_NOT_EMPTY"];
