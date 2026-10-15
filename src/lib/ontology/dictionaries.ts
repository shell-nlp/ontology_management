import { z } from "zod";

/** 字典只描述码值释义的来源，不参与对象身份、数据补充或关系实例生成。 */
export const entityDictionarySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(""),
  dataSourceId: z.string().trim().min(1),
  schema: z.string().trim().default(""),
  view: z.string().trim().min(1),
  mappings: z.array(z.object({
    property: z.string().trim().min(1),
    codeColumn: z.string().trim().min(1),
    labelColumn: z.string().trim().min(1),
  })).default([]),
});

export type EntityDictionary = z.infer<typeof entityDictionarySchema>;

/** 允许只登记表；一旦声明映射，就必须明确属性与两列，不能靠同名猜关联。 */
export function dictionaryIssues(dictionaries: readonly EntityDictionary[], properties: readonly { name: string }[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const mapped = new Set<string>();
  for (const dictionary of dictionaries) {
    const parsed = entityDictionarySchema.safeParse(dictionary);
    if (!parsed.success) {
      issues.push(`字典「${dictionary.name || "未命名"}」请补全名称、数据资源、表及已添加的属性映射。`);
      continue;
    }
    if (ids.has(dictionary.id)) issues.push(`字典「${dictionary.name}」的标识重复。`);
    if (names.has(dictionary.name.trim())) issues.push(`字典名称「${dictionary.name}」重复。`);
    ids.add(dictionary.id);
    names.add(dictionary.name.trim());
    for (const mapping of dictionary.mappings) {
      if (!properties.some((property) => property.name === mapping.property)) issues.push(`字典「${dictionary.name}」引用了不存在的属性「${mapping.property}」，请重新选择或移除映射。`);
      if (mapped.has(mapping.property)) issues.push(`属性「${mapping.property}」重复配置字典映射，请保留一个明确的释义来源。`);
      mapped.add(mapping.property);
    }
  }
  return issues;
}
