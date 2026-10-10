/**
 * 对象类型上的**属性**与表里的**列**之间的换算。
 *
 * 单独放一个文件，是为了**浏览器也能引**：属性映射、关系键映射、图谱取邻居都要用到这两下，
 * 而它们原来的家 `@/lib/object-identity` 依赖 `node:crypto`（算确定性 id），进不了客户端包。
 * 服务端那两处从 `object-identity` 转出去，实现只有这一份。
 */

/** 主键值的长度上限：超长值不适合当身份（跟索引里 8KB 的唯一键上限一个思路）。 */
const MAX_KEY_VALUE_LENGTH = 400;

/** 身份推导只用到对象类型的这几项，避免把整个定义类型绑进来。 */
export type IdentityEntityType = {
  name: string;
  properties: readonly { name: string; sourceField?: string | null; sourceId?: string | null }[];
  sources?: readonly { id: string; primaryKey: readonly string[] }[] | null;
};

/** 一个对象的业务主键：主来源的主键列 -> 值（值统一按字符串口径比较与哈希）。 */
export type ObjectPrimaryKey = Record<string, string>;

/** 主键值统一成字符串：数字 / 布尔 / 日期都按稳定口径，复合值（数组 / 对象）当没有值。 */
export function normalizeKeyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, MAX_KEY_VALUE_LENGTH) : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  return null;
}

/** 主来源（sources[0]）定义的主键列；没绑来源或没写主键时返回空数组。 */
export function primaryKeyColumns(entityType: IdentityEntityType): string[] {
  const columns = entityType.sources?.[0]?.primaryKey ?? [];
  return columns.map((column) => column?.trim() ?? "").filter(Boolean);
}

/**
 * 从对象属性里取主键值。
 * `missing` 是"声明了主键列、但对象上没有值"的列 —— 调用方据此如实提示，而不是拿半截主键硬算身份。
 */
export function primaryKeyFromProperties(
  entityType: IdentityEntityType,
  properties: Record<string, unknown>,
): { primaryKey: ObjectPrimaryKey; missing: string[] } {
  const primaryKey: ObjectPrimaryKey = {};
  const missing: string[] = [];
  for (const column of primaryKeyColumns(entityType)) {
    const property = propertyForColumn(entityType, column);
    const value = property ? normalizeKeyValue(properties[property]) : null;
    if (value === null) { missing.push(column); continue; }
    primaryKey[column] = value;
  }
  return { primaryKey, missing };
}

/** 只关心"有哪些属性、每个属性映射到哪一列"，不关心属性还有什么规则。 */
export type FieldMappable = { properties: readonly { name: string; sourceField?: string | null }[] };

/**
 * 一列对应对象类型上的哪个属性：属性自己声明了 `sourceField` 就用它，
 * 否则退回同名（导入外部本体时列名与属性名往往一致）。
 */
export function propertyForColumn(entityType: FieldMappable, column: string): string {
  const target = column.trim();
  if (!target) return "";
  const matched = entityType.properties.find((property) =>
    (property.sourceField ?? "").trim() === target || property.name === target);
  return matched?.name ?? "";
}

/**
 * `propertyForColumn` 的反方向：对象类型上的一个属性，落在这张表的哪一列。
 * 关系类型的键映射说的是"属性"，要落到 SQL 上必须先换成列 —— 这个换算只能有一处。
 */
export function columnForProperty(entityType: FieldMappable, propertyName: string): string {
  const matched = entityType.properties.find((property) => property.name === propertyName);
  return (matched?.sourceField ?? "").trim() || matched?.name || "";
}
