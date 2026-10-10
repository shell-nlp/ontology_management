/**
 * 关系类型的**数量关系**（Palantir 的 link type cardinality）。
 *
 * 为什么要它：跨表统计最容易出错的地方就是"走一条关系会不会把行数放大"。
 * 一个客户有 141 条专线，按"客户"分组求和就会重复计数 —— 模型得先知道这是 1:N。
 * 以前这个信息只能靠人写在关系类型的说明里，模型读不到也查不到。
 *
 * 口径（**不改变「关系类型是双向的」**）：只有一个值，说的是
 * **起点端 → 终点端** 的数量关系；两个方向照样都能走，这里只回答"走一次会放大几倍"。
 * 空串 = 还没标注（和键映射一样，不标不影响发布，工具里也如实说"未标注"）。
 */

export const RELATIONSHIP_CARDINALITIES = ["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"] as const;

export type RelationshipCardinality = (typeof RELATIONSHIP_CARDINALITIES)[number] | "";

export type CardinalityOption = { value: RelationshipCardinality; label: string; hint: string };

export const CARDINALITY_OPTIONS: CardinalityOption[] = [
  { value: "", label: "未标注", hint: "还没确定数量关系；不影响发布，工具里会如实说「未标注」。" },
  { value: "ONE_TO_ONE", label: "一对一", hint: "一个起点端最多对一个终点端（例如一个用户对一份档案）。" },
  { value: "ONE_TO_MANY", label: "一对多", hint: "一个起点端对多个终点端（例如一个客户对多条专线）——按起点聚合时要注意别重复计数。" },
  { value: "MANY_TO_ONE", label: "多对一", hint: "多个起点端对同一个终点端（例如多条专线同属一个客户）。" },
  { value: "MANY_TO_MANY", label: "多对多", hint: "两端都可能多个，取实例一般要经过一张连接表。" },
];

/** 汉字说法：`ONE_TO_MANY` → 「一对多」；没标注就是空串（调用方按"未标注"渲染）。 */
export function cardinalityLabel(value: string | undefined | null): string {
  const found = CARDINALITY_OPTIONS.find((item) => item.value === value && item.value);
  return found?.label ?? "";
}

/** 翻转方向：`ONE_TO_MANY` ↔ `MANY_TO_ONE`；对称的两项与空值原样返回。 */
export function flipCardinality(value: string | undefined | null): string {
  switch (value) {
    case "ONE_TO_MANY": return "MANY_TO_ONE";
    case "MANY_TO_ONE": return "ONE_TO_MANY";
    case "ONE_TO_ONE":
    case "MANY_TO_MANY": return value;
    default: return "";
  }
}

/** `"ONE_TO_MANY"` → `["ONE","MANY"]`；不认识的值返回空数组。 */
function splitCardinality(value: string): string[] {
  const parts = value.split("_TO_");
  if (parts.length !== 2 || !["ONE", "MANY"].includes(parts[0]) || !["ONE", "MANY"].includes(parts[1])) return [];
  return parts;
}

/**
 * 一句话说清数量关系：`一个「客户」→ 多个「专线产品用户」`。
 *
 * `reversed` = 从**终点端的视角**看（`get_object_type` 的入边就是这种情况）：
 * 先把基数翻过来，再说"从这边看是什么关系"，避免模型把方向理解反。
 */
export function cardinalityPhrase(value: string | undefined | null, fromName: string, toName: string, options: { reversed?: boolean } = {}): string {
  const effective = options.reversed ? flipCardinality(value) : (value ?? "");
  const parts = splitCardinality(effective);
  if (!parts.length) return "";
  const word = (part: string) => (part === "ONE" ? "一个" : "多个");
  return `${word(parts[0])}「${fromName || "未指定"}」→ ${word(parts[1])}「${toName || "未指定"}」`;
}
