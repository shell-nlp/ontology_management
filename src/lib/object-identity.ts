import { createHash } from "node:crypto";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 对象身份 = (对象类型, 主键)。**这是平台里唯一一处定义「一个对象是谁」的地方**（S1）。
 *
 * 为什么要把它单独抽出来：对象原先的身份是"快照里的那一行"，换一次快照就换一个 id，
 * 于是同一条业务记录可以在本体里合法地存在两份。改成 (对象类型, 主键) 之后：
 * - **同一个主键永远映射到同一个对象 id**：确定性 UUID（v5 风格），发布、动作写入、导入导出一致；
 * - **检索索引能按主键做唯一键与增量 upsert**（S3），不必整表重建；
 * - **对象服务能按主键回源取数**（S2），不必把业务表整表搬进本体。
 *
 * 这一层是**纯函数、不认识任何存储**：图库、检索索引、对象服务、数据源都只能引用它，
 * 谁都不许再各写一套"主键怎么算"的口径。身份里**不含本体存储 id**，
 * 所以换存储（见 backlog P4）时对象身份不变。
 */

/** 一个对象的业务主键：主来源的主键列 -> 值（值统一按字符串口径比较与哈希）。 */
export type ObjectPrimaryKey = Record<string, string>;

/**
 * 确定性 id 的命名空间。**改了它，全平台所有按主键推导出来的对象 id 都会变**，
 * 相当于把历史数据全部变成"另一个对象"，所以这是一个只读常量。
 */
const IDENTITY_NAMESPACE = "b6f1d0e2-3a4c-5d6e-8f90-1a2b3c4d5e6f";

/** 主键值的长度上限：超长值不适合当身份（跟索引里 8KB 的唯一键上限一个思路）。 */
const MAX_KEY_VALUE_LENGTH = 400;

/** 身份推导只依赖对象类型的这几项，避免把整个定义类型绑进来。 */
export type IdentityEntityType = {
  name: string;
  properties: readonly { name: string; sourceField?: string | null; sourceId?: string | null }[];
  sources?: readonly { id: string; primaryKey: readonly string[] }[] | null;
};

function normalizeKeyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, MAX_KEY_VALUE_LENGTH) : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  // 复合值（数组 / 对象）不能当身份：它们没有稳定的字符串形态。
  return null;
}

/** 主来源（sources[0]）定义的主键列；没绑来源或没写主键时返回空数组。 */
export function primaryKeyColumns(entityType: IdentityEntityType): string[] {
  const columns = entityType.sources?.[0]?.primaryKey ?? [];
  return columns.map((column) => column?.trim() ?? "").filter(Boolean);
}

/**
 * 一列对应对象类型上的哪个属性：属性自己声明了 `sourceField` 就用它，
 * 否则退回同名（导入外部本体时列名与属性名往往一致）。
 */
export function propertyForColumn(entityType: IdentityEntityType, column: string): string {
  const matched = entityType.properties.find((property) =>
    (property.sourceField ?? "").trim() === column || property.name === column);
  return matched?.name ?? "";
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

/** 主键值里的 `\`、`&`、`=` 要转义，否则 `{a:"b&c=d"}` 与 `{a:"b",c:"d"}` 会撞成同一个键。 */
function escapeKeyPart(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/([&=])/g, "\\$1");
}

/**
 * 主键的规范化形式：列名排序 + 值转义拼接。
 * 同一个主键无论写进来的字段顺序如何，这里都得同一个串 —— 索引唯一键与 id 哈希都靠它。
 * 空主键（没值 / 没配主键）返回空串。
 */
export function canonicalPrimaryKey(primaryKey: ObjectPrimaryKey): string {
  const entries = Object.entries(primaryKey)
    .map(([column, value]) => [column.trim(), normalizeKeyValue(value) ?? ""] as const)
    .filter(([column, value]) => column && value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  if (!entries.length) return "";
  return entries.map(([column, value]) => `${escapeKeyPart(column)}=${escapeKeyPart(value)}`).join("&");
}

/**
 * 检索索引里的对象键：(对象类型, 主键) 的唯一表示。
 * 没有主键的对象（纯手工建、或类型没配主键）由调用方退回 `id:<objectId>`，不在这里编造。
 */
export function objectKeyOf(entityTypeName: string, primaryKey: ObjectPrimaryKey): string {
  const canonical = canonicalPrimaryKey(primaryKey);
  if (!canonical) return "";
  return JSON.stringify([entityTypeName, canonical]);
}

/** 没有主键时的索引键：退回对象 id，保证索引行仍然唯一（但**不构成身份**）。 */
export function fallbackObjectKey(objectId: string): string {
  return `id:${objectId}`;
}

/** 对象引用串：`对象类型/主键串`。界面与工具之间传引用用它，不传内部 id。 */
export function objectRefOf(entityTypeName: string, primaryKey: ObjectPrimaryKey): string {
  const canonical = canonicalPrimaryKey(primaryKey);
  return canonical ? `${entityTypeName}/${canonical}` : entityTypeName;
}

/**
 * 按主键推导的确定性对象 id（RFC 4122 v5 风格：SHA-1 + 版本位）。
 * 空主键没有身份可言，返回空串，调用方自行退回随机 id。
 */
export function objectIdOf(entityTypeName: string, primaryKey: ObjectPrimaryKey): string {
  const canonical = canonicalPrimaryKey(primaryKey);
  if (!canonical) return "";
  const digest = createHash("sha1")
    .update(IDENTITY_NAMESPACE)
    .update("\u0000")
    .update(entityTypeName)
    .update("\u0000")
    .update(canonical)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 对象在定义里的身份：主键齐全才有 id。
 * 主键不全（类型没配主键 / 对象缺列）返回 null —— 这时对象的身份仍是"那一行快照"，调用方如实处理。
 */
export function resolveObjectIdentity(
  entityType: IdentityEntityType,
  properties: Record<string, unknown>,
): { id: string; primaryKey: ObjectPrimaryKey } | null {
  const { primaryKey, missing } = primaryKeyFromProperties(entityType, properties);
  if (missing.length) return null;
  const id = objectIdOf(entityType.name, primaryKey);
  return id ? { id, primaryKey } : null;
}

/** 把 `CUST_ID=1001&AREA_CODE=371` 这类主键入参解析成主键对象（界面上按主键直查用）。 */
export function parsePrimaryKeyInput(input: string): ObjectPrimaryKey {
  const primaryKey: ObjectPrimaryKey = {};
  for (const segment of input.split("&")) {
    const index = segment.indexOf("=");
    if (index <= 0) continue;
    const column = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (column && value) primaryKey[column] = value;
  }
  return primaryKey;
}

/** 主键唯一性冲突：同一个对象类型里两条对象算出了同一个主键。 */
export type PrimaryKeyConflict = { typeName: string; key: string; ids: string[] };

/**
 * 找出主键重复的对象。发布前的强约束靠它：身份相同就是同一个对象，
 * 一份本体里出现两份，说明数据本身有问题（也说明入图前没有按主键去重）。
 */
export function primaryKeyConflicts(
  definition: Pick<OntologyDefinition, "entityTypes">,
  nodes: readonly { id: string; labels: readonly string[]; properties: Record<string, unknown> }[],
): PrimaryKeyConflict[] {
  const byName = new Map(definition.entityTypes.map((entity) => [entity.name, entity]));
  const groups = new Map<string, PrimaryKeyConflict>();
  for (const node of nodes) {
    for (const label of node.labels) {
      const entityType = byName.get(label);
      if (!entityType) continue;
      const identity = resolveObjectIdentity(entityType, node.properties);
      if (!identity) continue;
      const canonical = canonicalPrimaryKey(identity.primaryKey);
      const key = `${entityType.name}\u0000${canonical}`;
      const group = groups.get(key) ?? { typeName: entityType.name, key: canonical, ids: [] };
      group.ids.push(node.id);
      groups.set(key, group);
    }
  }
  return [...groups.values()].filter((group) => group.ids.length > 1);
}
