import { listDataSources } from "@/lib/data-sources";
import { readDataSourceCatalogCache, type DataSourceCatalogCache } from "@/lib/platform-db";
import { bindingKey, brokenSourcesOf, matchSourceCandidates, type PendingSource, type SourceHint, type UnboundSource } from "@/lib/source-binding";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 「来源 → 数据资源」的匹配依据与候选清单，服务端一处。
 *
 * 两处要用同一套口径：导入时（`/api/ontologies/import`）和导入之后补绑定
 * （`/api/ontologies/:id/bind-sources`）。以前这段只在导入路由里，于是"导入时选先不绑"
 * 就成了死路 —— 界面上再没有第二个地方能算候选。放到这里给两边共用。
 */

/**
 * 本机数据资源的匹配依据：登记信息 + 已知的表清单（结构缓存里的目录与看过的视图）。
 * 没读过结构的资源只有模式名可用 —— 那就只会参与弱匹配。
 */
export async function collectSourceHints(): Promise<SourceHint[]> {
  const sources = await listDataSources();
  return Promise.all(sources.filter((source) => source.enabled).map(async (source) => {
    const cache: DataSourceCatalogCache = await readDataSourceCatalogCache(source.id).catch(() => ({} as DataSourceCatalogCache));
    const objects = [
      ...Object.values(cache.catalog ?? {}).flatMap((bucket) => (bucket.objects ?? []) as { schema?: string; name?: string }[]),
      // 看过的视图以 `模式.表@行数` 为键 —— 它同样证明"这张表在这个资源里"。
      ...Object.keys(cache.views ?? {}).map((key) => {
        const [qualified] = key.split("@");
        const index = qualified.lastIndexOf(".");
        return index > 0 ? { schema: qualified.slice(0, index), name: qualified.slice(index + 1) } : { schema: "", name: qualified };
      }),
    ].map((object) => ({ schema: String(object.schema ?? ""), name: String(object.name ?? "") })).filter((object) => object.name);
    return { id: source.id, name: source.name, kind: source.kind, schema: source.schema_name, objects };
  }));
}

/** 把匹配结果整理成界面要的形状（带资源名与"是不是表名命中"）。 */
export function toPendingSources(items: readonly { unbound: UnboundSource; exact: string[]; schemaOnly: string[] }[], hints: readonly SourceHint[]): PendingSource[] {
  const nameOf = new Map(hints.map((hint) => [hint.id, hint.name]));
  return items.map((item) => ({
    entityTypeId: item.unbound.entityTypeId,
    entityTypeName: item.unbound.entityTypeName,
    sourceId: item.unbound.sourceId,
    label: item.unbound.label,
    candidates: [...item.exact, ...item.schemaOnly].map((id) => ({ id, name: nameOf.get(id) ?? id, exact: item.exact.includes(id) })),
  }));
}

/**
 * 一个定义里还有哪些来源没定下来。
 *
 * `knownSourceIds` 传进来是为了把"指向已删资源的悬空引用"也算成待补 —— 只按空值判断的话，
 * 换过平台库的本体会一路显示成"绑好了但读不出数据"。
 */
export async function planSourceBindingsFor(definition: OntologyDefinition, knownSourceIds: readonly string[]) {
  const hints = await collectSourceHints();
  const auto = new Map<string, string>();
  const items: { unbound: UnboundSource; exact: string[]; schemaOnly: string[] }[] = [];
  for (const unbound of brokenSourcesOf(definition, knownSourceIds)) {
    const candidates = matchSourceCandidates(unbound, hints);
    if (candidates.autoBind) auto.set(bindingKey(unbound), candidates.autoBind);
    items.push(candidates);
  }
  /*
   * 和导入时不一样：这里要把**每一条没绑好的**都吐出去，不能只吐"判不出来"的。
   * 导入可以静默自动绑，是因为随后就写进草稿了；查绑定没有"随后"——
   * 只回 pending 的话，能自动判定的那些就成了"界面上没得选、库里也还是空的"。
   */
  return { hints, auto, pendingSources: toPendingSources(items, hints) };
}
