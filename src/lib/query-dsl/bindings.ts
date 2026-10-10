import type { DataSourceRecord } from "@/lib/datasource/types";
import type { OntologyDefinition } from "@/lib/ontology";
import { entitySources } from "@/lib/ontology/sources";

/** 一条按「模式名唯一匹配」兜底认出来的来源绑定。 */
export type InferredSourceBinding = {
  objectTypeName: string;
  schema: string;
  table: string;
  dataSourceId: string;
  dataSourceName: string;
};

export type InferredBindingResult = {
  definition: OntologyDefinition;
  inferred: InferredSourceBinding[];
};

/**
 * 把「只填了 模式.表、没填 dataSourceId」的来源按**模式名唯一匹配**补成正式绑定。
 *
 * 为什么要有它：导入态本体的 `sources[].dataSourceId` 往往是空的，而平台里其它读路径
 * （`get_object_type` 给资源名、`get_table_ddl` 出列画像、`search_schema` 的取值命中）都按
 * 「模式名唯一对得上一个数据资源」兜底，只有 DSL 执行器原来要求正式绑定 —— 于是同一个本体
 * 能看不能查：定义、表结构、列画像都拿得到，一问数就报没有绑定数据资源。
 * 这里把同一条兜底规则补齐（2026-10-10）。
 *
 * 只在**恰好一个**资源匹配时才补：0 个（模式名对不上）或 2 个以上（模式名撞车）都原样留着，
 * 交给 resolve 抛明确错误 —— 宁可报错，也不猜一个资源去连。
 */
export async function withInferredDataSources(
  definition: OntologyDefinition,
  loadDataSources: () => Promise<readonly DataSourceRecord[]>,
): Promise<InferredBindingResult> {
  const needsInference = definition.entityTypes.some((entity) =>
    entitySources(entity).some((source) => !(source.dataSourceId ?? "").trim()));
  // 全都绑好了就别白跑一次数据资源清单：这条路才是常态。
  if (!needsInference) return { definition, inferred: [] };

  const bySchema = new Map<string, DataSourceRecord[]>();
  for (const record of await loadDataSources()) {
    const key = (record.schema_name ?? "").trim().toUpperCase();
    if (!key) continue;
    bySchema.set(key, [...(bySchema.get(key) ?? []), record]);
  }

  const inferred: InferredSourceBinding[] = [];
  const entityTypes = definition.entityTypes.map((entity) => {
    const sources = entitySources(entity);
    if (!sources.some((source) => !(source.dataSourceId ?? "").trim())) return entity;
    let changed = false;
    const nextSources = sources.map((source) => {
      if ((source.dataSourceId ?? "").trim()) return source;
      const key = (source.schema ?? "").trim().toUpperCase();
      const candidates = key ? bySchema.get(key) ?? [] : [];
      if (candidates.length !== 1) return source;
      changed = true;
      inferred.push({
        objectTypeName: entity.name,
        schema: source.schema ?? "",
        table: source.view ?? "",
        dataSourceId: candidates[0].id,
        dataSourceName: candidates[0].name,
      });
      return { ...source, dataSourceId: candidates[0].id };
    });
    return changed ? { ...entity, sources: nextSources } : entity;
  });

  return {
    definition: inferred.length ? { ...definition, entityTypes } : definition,
    inferred,
  };
}

/**
 * 兜底绑定的提示语。给了 `usedTypeNames` 就只报这次查询真正用到的对象类型 ——
 * 一个本体可能几十个类型都没绑，把 52 条一样的提示全塞回给模型，光这一项就能把结果淹掉
 * （2026-10-10 实测：52 条同名提示约 6k 字符）。
 */
export function inferredBindingWarnings(
  inferred: readonly InferredSourceBinding[],
  usedTypeNames?: readonly string[],
): string[] {
  const used = usedTypeNames ? new Set(usedTypeNames) : null;
  return inferred
    .filter((item) => !used || used.has(item.objectTypeName))
    .map((item) =>
      `对象类型「${item.objectTypeName}」的来源还没正式绑定数据资源，本次按模式名 ${item.schema} 唯一匹配到「${item.dataSourceName}」执行。这是配置缺口、不是没有数据；正式出数前请到「对象 / 本体」页补齐绑定。`,
    );
}