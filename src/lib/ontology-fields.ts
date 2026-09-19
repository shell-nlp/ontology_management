/**
 * 对象类型上的**属性**与表里的**列**之间的换算。
 *
 * 单独放一个文件，是为了**浏览器也能引**：属性映射、关系键映射、图谱取邻居都要用到这两下，
 * 而它们原来的家 `@/lib/object-identity` 依赖 `node:crypto`（算确定性 id），进不了客户端包。
 * 服务端那两处从 `object-identity` 转出去，实现只有这一份。
 */

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
