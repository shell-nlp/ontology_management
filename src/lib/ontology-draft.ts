import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 草稿定义在前端的形态：与 `@/lib/ontology` 的 zod 结果结构一致，
 * 但 `displayProperty` 允许缺省——新建类型时前端先不写这一项。
 */
export type PropertyDataType = OntologyDefinition["entityTypes"][number]["properties"][number]["dataType"];
export type Property = { name: string; dataType: PropertyDataType; required: boolean; unique: boolean; indexed: boolean };
export type EntityType = { id: string; name: string; description: string; displayProperty?: string; properties: Property[] };
export type RelationType = { id: string; name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
export type ActionParameter = OntologyDefinition["actionTypes"][number]["params"][number];
export type ActionValueSource = OntologyDefinition["actionTypes"][number]["edits"][number]["assignments"][number]["value"];
export type ActionEdit = OntologyDefinition["actionTypes"][number]["edits"][number];
export type ActionType = OntologyDefinition["actionTypes"][number];
export type RuleCondition = OntologyDefinition["rules"][number]["conditions"][number];
export type RuleEffect = OntologyDefinition["rules"][number]["effect"];
export type RuleOperator = RuleCondition["operator"];
export type OntologyRule = OntologyDefinition["rules"][number];
export type Definition = { entityTypes: EntityType[]; relationshipTypes: RelationType[]; actionTypes: ActionType[]; rules: OntologyRule[] };

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
