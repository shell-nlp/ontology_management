import type { EntitySource, OntologyDefinition } from "@/lib/ontology";

/**
 * 导入本体时的**数据资源绑定**。
 *
 * 问题：bkn 知识网络只写了「SCHEMA.TABLE」，本体包里的资源 id 又是导出端环境的，
 * 于是导入进来的对象类型常常"有表名、没资源"—— 表现是对象服务回一句
 * "对象类型没有绑定数据资源"，谁也不知道该绑哪一个。
 *
 * 这里的口径（用户 2026-09-19 确认）：
 * 1. **表名命中唯一一个本机资源**（该资源的表清单里有这张表）→ 自动绑；
 * 2. 表名命中多个 → 不猜，列出来让用户在导入弹窗里选一次；
 * 3. 表清单里都没有，但**模式名对得上唯一的资源** → 退一步自动绑（弱匹配）；
 * 4. 还是不确定 → 留空 + 给出候选，导入后可以在对象类型里改。
 *
 * 纯函数：候选判定不碰数据库，调用方把"本机资源 + 它们已知的表清单"喂进来。
 */

/** 一个待绑定的来源（对象类型上 `view` 有值、`dataSourceId` 为空）。 */
export type UnboundSource = {
  entityTypeId: string;
  entityTypeName: string;
  /** 来源在本对象类型里的标识（`entityTypes[].sources[].id`）。 */
  sourceId: string;
  schema: string;
  view: string;
  /** 给人看的「模式.表」。 */
  label: string;
};

/** 本机数据资源的匹配依据：登记信息 + 已知的表清单（来自结构缓存）。 */
export type SourceHint = {
  id: string;
  name: string;
  kind: string;
  /** 数据资源登记的模式（Oracle 的模式 / PG 的 schema）。 */
  schema: string;
  /** 已经读过的表清单；没读过就是空数组。 */
  objects: readonly { schema: string; name: string }[];
};

export type SourceCandidates = {
  unbound: UnboundSource;
  /** 表清单里直接命中该表的资源（最强依据）。 */
  exact: string[];
  /** 只是模式名对得上的资源（弱依据）。 */
  schemaOnly: string[];
  /** 可以直接绑定的资源 id；不确定时是空串。 */
  autoBind: string;
};

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * 判断只用到「对象类型 → 来源」这一层，所以不把入参钉死成 `OntologyDefinition`：
 * 界面上的草稿定义（`@/lib/ontology-draft` 的 `Definition`）字段更松，但来源是同一个 `EntitySource`。
 */
export type SourceHolder = { entityTypes: readonly { id: string; name: string; sources?: readonly EntitySource[] }[] };

/** 找出定义里所有"有表名、没资源"的来源。 */
export function unboundSourcesOf(definition: SourceHolder): UnboundSource[] {
  const unbound: UnboundSource[] = [];
  for (const type of definition.entityTypes) {
    for (const source of type.sources ?? []) {
      const view = (source.view ?? "").trim();
      if (!view || (source.dataSourceId ?? "").trim()) continue;
      const schema = (source.schema ?? "").trim();
      unbound.push({
        entityTypeId: type.id,
        entityTypeName: type.name,
        sourceId: source.id,
        schema,
        view,
        label: schema ? `${schema}.${view}` : view,
      });
    }
  }
  return unbound;
}

/** 一个来源在本机资源里的候选与"能不能自动绑"。 */
export function matchSourceCandidates(unbound: UnboundSource, hints: readonly SourceHint[]): SourceCandidates {
  const exact = hints
    .filter((hint) => hint.objects.some((object) => normalize(object.name) === normalize(unbound.view) && (!unbound.schema || normalize(object.schema) === normalize(unbound.schema))))
    .map((hint) => hint.id);
  const schemaOnly = exact.length
    ? []
    : hints.filter((hint) => unbound.schema && normalize(hint.schema) === normalize(unbound.schema)).map((hint) => hint.id);
  const autoBind = exact.length === 1 ? exact[0] : !exact.length && schemaOnly.length === 1 ? schemaOnly[0] : "";
  return { unbound, exact, schemaOnly, autoBind };
}

/**
 * 一次算完全部待绑定来源：能自动绑的写在 `bindings` 里（key 是 `对象类型id/sourceId`），
 * 剩下的进 `pending` 交给界面选。
 */
export function planSourceBindings(definition: OntologyDefinition, hints: readonly SourceHint[]) {
  const bindings = new Map<string, string>();
  const pending: SourceCandidates[] = [];
  for (const unbound of unboundSourcesOf(definition)) {
    const candidates = matchSourceCandidates(unbound, hints);
    if (candidates.autoBind) bindings.set(`${unbound.entityTypeId}/${unbound.sourceId}`, candidates.autoBind);
    else pending.push(candidates);
  }
  return { bindings, pending };
}

/** 把绑定写进定义（返回新对象，不改原定义）。key 是 `对象类型id/sourceId`。 */
export function applySourceBindings(definition: OntologyDefinition, bindings: ReadonlyMap<string, string>): OntologyDefinition {
  if (!bindings.size) return definition;
  return {
    ...definition,
    entityTypes: definition.entityTypes.map((type) => ({
      ...type,
      sources: type.sources.map((source) => {
        const target = bindings.get(`${type.id}/${source.id}`);
        return target ? { ...source, dataSourceId: target } : source;
      }),
    })),
  };
}

/** 界面要展示的一条「待补绑定」：来源 + 可选的候选资源。 */
export type PendingSource = {
  entityTypeId: string;
  entityTypeName: string;
  sourceId: string;
  label: string;
  candidates: { id: string; name: string; exact: boolean }[];
};

/** 绑定表/接口回传用的 key：`对象类型id/sourceId`。 */
export const bindingKey = (item: Pick<PendingSource, "entityTypeId" | "sourceId">) => `${item.entityTypeId}/${item.sourceId}`;

/**
 * 需要补绑的来源：**没绑的**（`dataSourceId` 为空）加上**绑飞了的**
 * （`dataSourceId` 指向本机已经不存在的资源 —— 换平台库、删数据资源之后就是这样）。
 *
 * `unboundSourcesOf` 只管第一种（导入时用）；修绑定要用这个，否则"引用了一个不存在的资源"
 * 会被当成绑好了，界面上一路显示 0 条，谁也不知道为什么。
 */
export function brokenSourcesOf(definition: SourceHolder, knownSourceIds: readonly string[]): UnboundSource[] {
  const known = new Set(knownSourceIds.filter(Boolean));
  const broken: UnboundSource[] = [];
  for (const type of definition.entityTypes) {
    for (const source of type.sources ?? []) {
      const view = (source.view ?? "").trim();
      if (!view) continue;
      const dataSourceId = (source.dataSourceId ?? "").trim();
      if (dataSourceId && known.has(dataSourceId)) continue;
      const schema = (source.schema ?? "").trim();
      broken.push({
        entityTypeId: type.id,
        entityTypeName: type.name,
        sourceId: source.id,
        schema,
        view,
        label: schema ? `${schema}.${view}` : view,
      });
    }
  }
  return broken;
}
