/**
 * "没有属性 X" 与 "这一列有哪些值" 的带路文案（纯函数，表层与内核共用一处）。
 *
 * 为什么值得单开一个模块（2026-10-14 实测）：导进来的本体里属性名往往**就是物理列名**
 * （`STATIS_DATE` / `STATS`），模型却按业务语感写 `统计日期`；只回一句"没有属性"它就再猜一次，
 * 而工具循环每多一步都要重发整个上下文。三级兜底：
 * ① 写的其实是列名 → 直接说属性叫什么；② 名字互相包含的候选；③ 一个都不沾边就把属性清单摊开。
 */

export type PropertyLike = { name: string; sourceField?: string | null };

/** 属性清单太长时只摊前 N 个，剩下的用条数交代并指向 get_object_type。 */
const DEFAULT_LIST_LIMIT = 12;

export function unknownPropertyHint(
  entityName: string,
  properties: readonly PropertyLike[],
  wanted: string,
  limit = DEFAULT_LIST_LIMIT,
): string {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return "";
  // ① 写的是这一列的名字 —— 属性名与列名不同的本体里，这一条最有用。
  const byColumn = properties.find((item) => (item.sourceField ?? "").trim().toLowerCase() === needle);
  if (byColumn) return `「${wanted}」是这一列的列名，属性名是「${byColumn.name}」—— 查询里要写属性名。`;
  // ② 名字互相包含的候选。
  const fuzzy = properties.filter((item) => {
    const value = item.name.toLowerCase();
    return value.includes(needle) || needle.includes(value);
  });
  if (fuzzy.length) return `本体里有：${fuzzy.slice(0, 6).map((item) => item.name).join("、")}。`;
  // ③ 一个都不沾边：把清单摊开，让下一步"有名字可抄"。
  const names = properties.map((item) => item.name);
  if (!names.length) return "";
  const head = names.slice(0, limit).join("、");
  return `对象类型「${entityName}」的属性是：${head}${names.length > limit ? " …" : ""}（共 ${names.length} 个，完整清单用 get_object_type 看）。`;
}

/**
 * "这一列实际有哪些值"（列画像采样里的低基数取值）。
 *
 * 写给 `LABEL(...)` / 按标签过滤却还没配 `enumValues` 的报错：有了真实取值，
 * 模型能立刻改成「按码值筛」，不必再往返一次去试。画像里没有这一列时给一句去哪儿看。
 */
export function columnValuesHint(propertyName: string, values: readonly string[], limit = 12): string {
  const shown = values.map((value) => value.trim()).filter(Boolean);
  if (!shown.length) {
    return `这一列的取值先用 get_table_ddl 看一眼（列画像里有低基数列的取值清单），再写 ${propertyName} = '码值'。`;
  }
  const head = shown.slice(0, limit);
  const more = shown.length > limit ? `…（共 ${shown.length} 个）` : "";
  const quoted = head.map((value) => `'${value}'`).join("、");
  return `这一列（列画像采样）里的取值：${quoted}${more}；按码值筛就写 ${propertyName} IN (${head.slice(0, 3).map((value) => `'${value}'`).join(", ")}) 或 ${propertyName} <> '码值'。`;
}
