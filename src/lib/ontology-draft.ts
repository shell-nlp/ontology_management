import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 草稿定义在前端的形态：与 `@/lib/ontology` 的 zod 结果结构一致，
 * 但 `displayProperty` 允许缺省——新建类型时前端先不写这一项。
 */
export type PropertyDataType = OntologyDefinition["entityTypes"][number]["properties"][number]["dataType"];
export type Property = { name: string; dataType: PropertyDataType; required: boolean; unique: boolean; indexed: boolean };
export type EntityType = { id: string; name: string; description: string; displayProperty?: string; properties: Property[] };
export type RelationType = { id: string; name: string; sourceEntityTypeId: string; targetEntityTypeId: string; properties: Property[] };
export type Definition = { entityTypes: EntityType[]; relationshipTypes: RelationType[] };

export const propertyTypeOptions: PropertyDataType[] = ["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"];
