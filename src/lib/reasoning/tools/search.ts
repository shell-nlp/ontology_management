import { ConceptKind, SchemaConcept, SchemaMatch } from "./registry";
import { describeBriefly } from "./dispatch";
import { effectiveInterfaceProperties, interfaceAncestorsOf } from "@/lib/ontology/interfaces";
import { type DataSourceRecord } from "@/lib/datasource/types";
import { entitySources } from "@/lib/ontology/sources";
import { cardinalityLabel } from "@/lib/ontology/relationship-cardinality";
import { columnValueOf, type ColumnValueIndex } from "@/lib/datasource/column-profile";
import { type RuntimeTypeSet } from "@/lib/framework/graph/types";
import { type OntologyDefinition } from "@/lib/ontology";

export function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, "");
}

/** 中文没有空格，所以除了按标点切词，还要把每个词展开成 2 元组。 */
export function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!token) continue;
    tokens.add(token);
    if (/[\u4e00-\u9fff]/.test(token)) {
      for (let i = 0; i + 2 <= token.length; i += 1) tokens.add(token.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/** 最长公共子串长度：中文按 2 元组匹配，短查询也能给出有意义的分数。 */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let best = 0;
  const previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const current = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (previous[j] > best) best = previous[j];
      diagonal = current;
    }
  }
  return best;
}

export function schemaConcepts(definition: OntologyDefinition, runtimeTypes: RuntimeTypeSet | null, dataSources: DataSourceRecord[] = [], valueIndex: ColumnValueIndex | null = null): SchemaConcept[] {
  const resourceNameById = new Map(dataSources.map((item) => [item.id, item.name]));
  /*
   * 没绑 / 绑飞了的来源：模式名唯一对得上一个资源时兜底给出资源名（与 get_object_type.sources 同一口径）。
   * 有它模型才不用从 detail 的长句里人工抠资源名 —— search_schema 直接给 data_source 落点。
   */
  const resourceNamesBySchema = new Map<string, string[]>();
  for (const item of dataSources) {
    const key = (item.schema_name ?? "").trim().toUpperCase();
    if (!key) continue;
    resourceNamesBySchema.set(key, [...(resourceNamesBySchema.get(key) ?? []), item.name]);
  }
  const resourceNameOf = (source: { dataSourceId?: string; schema?: string } | undefined) => {
    if (!source) return "";
    const bound = resourceNameById.get(source.dataSourceId ?? "") ?? "";
    if (bound) return bound;
    const candidates = resourceNamesBySchema.get((source.schema ?? "").trim().toUpperCase()) ?? [];
    return candidates.length === 1 ? candidates[0] : "";
  };
  /*
   * 对象数只用来给"完全没命中时的兜底排序"加一点权重，**不进给模型看的文案**：
   * 这一层不推理实例，就不该让模型看到实例层面的数字（否则它会据此下实例结论）。
   */
  const objectCount = new Map((runtimeTypes?.labels ?? []).map((item) => [item.name, item.count]));
  const relationshipCount = new Map((runtimeTypes?.relationshipTypes ?? []).map((item) => [item.name, item.count]));
  const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
  const groupNameById = new Map((definition.groups ?? []).map((item) => [item.id, item.name]));
  const interfaceNameById = new Map((definition.interfaces ?? []).map((item) => [item.id, item.name]));
  const concepts: SchemaConcept[] = [];

  for (const entity of definition.entityTypes) {
    const properties = entity.properties;
    const group = groupNameById.get(entity.groupId ?? "") ?? "";
    const sourced = entitySources(entity);
    // 绑定的表名也进检索面：问"某类在哪个表里"时，靠表名本身也能命中。
    const tables = sourced.map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const boundTable = tables[0] ?? "";
    const resources = [...new Set(sourced.map((source) => resourceNameOf(source)).filter(Boolean))];
    // 实现了哪些接口也进检索面：问「谁实现了设施接口」能直接命中这些对象类型。
    const implemented = (entity.implements ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    /*
     * 取值画像：把这张表上映射列的低基数取值拼成一根字符串，单独一档打分。
     * 只取已缓存的画像（按天采样），检索本身不回源库 —— 见 @/lib/column-profile。
     */
    const values = [...new Set(sourced.flatMap((source) =>
      properties
        .filter((property) => property.sourceField && (!property.sourceId || property.sourceId === source.id))
        .flatMap((property) => columnValueOf(valueIndex, source.schema, source.view, property.sourceField ?? "")),
    ))].slice(0, 400);
    concepts.push({
      kind: "OBJECT_TYPE",
      name: entity.name,
      // 概念分组也进检索面：问「客户域里有什么」时，该组的成员会被搜出来。
      // 属性说明也进检索面（截 120 字）：业务口径多半写在列的注释里。
      haystack: normalize([entity.name, describeBriefly(entity.description, 200), group, ...tables, ...properties.map((property) => property.name), ...properties.map((property) => describeBriefly(property.description ?? "", 120)), ...implemented].join(" ")),
      values: normalize(values.join(" ")),
      detail: [
        group ? `分组 ${group}` : "",
        implemented.length ? `实现接口 ${implemented.join("、")}` : "",
        tables.length ? `绑定 ${tables.join("、")}${resources.length ? `（${resources.join("、")}）` : ""}` : "",
        properties.length ? `属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
      ].filter(Boolean).join("；"),
      weight: objectCount.get(entity.name) ?? 0,
      description: entity.description,
      boundTable,
      dataSource: resourceNameOf(sourced[0]),
      references: [entity.name],
    });
    for (const property of properties) {
      // 属性的落点就是"哪张表的哪一列"：模型拿到它不用再猜，也不用再调一次 get_object_type。
      const source = sourced.find((item) => !property.sourceId || item.id === property.sourceId) ?? sourced[0];
      concepts.push({
        kind: "PROPERTY",
        name: `${entity.name}.${property.name}`,
        haystack: normalize([entity.name, property.name, property.dataType, describeBriefly(property.description ?? "", 120)].join(" ")),
        // 属性声明的取值枚举（码值 + 中文含义）也进取值面：「全球通」要能命中 U_TYPE，而不是靠描述里碰巧出现。
        values: normalize([
          ...columnValueOf(valueIndex, source?.schema ?? "", source?.view ?? "", property.sourceField ?? ""),
          ...(property.enumValues ?? []).flatMap((item) => [item.value, item.label].filter(Boolean)),
        ].join(" ")),
        detail: `${property.dataType}${property.required ? "，必填" : ""}${property.sourceField ? `，取自 ${property.sourceField}` : ""}`,
        weight: 0,
        description: property.description ?? "",
        boundTable: source ? [source.schema, source.view].filter(Boolean).join(".") : boundTable,
        dataSource: resourceNameOf(source),
        sourceColumn: property.sourceField ?? "",
        references: [entity.name],
      });
    }
  }

  // 接口本身也是可检索的概念（问「有哪些接口」「这个接口谁实现了」都要命中）。
  for (const item of definition.interfaces ?? []) {
    const inherited = interfaceAncestorsOf(definition.interfaces ?? [], item.id).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const implementers = definition.entityTypes.filter((entity) => (entity.implements ?? []).includes(item.id)).map((entity) => entity.name);
    const properties = effectiveInterfaceProperties(definition.interfaces ?? [], item.id);
    concepts.push({
      kind: "INTERFACE",
      name: item.name,
      haystack: normalize([item.name, describeBriefly(item.description, 200), ...properties.map((property) => property.name), ...properties.map((property) => describeBriefly(property.description ?? "", 120)), ...implementers, ...inherited].join(" ")),
      detail: [
        "接口（抽象契约，不绑数据、不能直接实例化）",
        inherited.length ? `继承 ${inherited.join("、")}` : "",
        properties.length ? `接口属性 ${properties.map((property) => property.name).join("、")}` : "暂无属性",
        implementers.length ? `${implementers.length} 个实现：${implementers.join("、")}` : "还没有对象类型实现它",
      ].filter(Boolean).join("；"),
      weight: 0,
      description: item.description,
      references: implementers,
    });
  }  for (const relationship of definition.relationshipTypes) {
    const source = typeNameById.get(relationship.sourceEntityTypeId) ?? "";
    const target = typeNameById.get(relationship.targetEntityTypeId) ?? "";
    concepts.push({
      kind: "RELATION_TYPE",
      name: relationship.name,
      haystack: normalize([relationship.name, describeBriefly(relationship.description ?? "", 200), source, target].join(" ")),
      // 双向关系类型只写一条定义：用 ↔ 表示两个方向都能走，别让人以为反向要再来一条。
      detail: `${source || "未指定"} ↔ ${target || "未指定"}${relationship.cardinality ? `；基数 ${cardinalityLabel(relationship.cardinality)}（起点 → 终点）` : ""}`,
      weight: relationshipCount.get(relationship.name) ?? 0,
      description: relationship.description ?? "",
      references: [source, target].filter(Boolean),
    });
  }

  for (const action of definition.actionTypes) {
    const scope = typeNameById.get(action.scopeEntityTypeId) ?? "";
    concepts.push({
      kind: "ACTION",
      name: action.name,
      haystack: normalize([action.name, action.code, describeBriefly(action.description, 200), scope, ...action.params.map((param) => param.name)].join(" ")),
      detail: `作用于 ${scope || "未指定"}；入参 ${action.params.map((param) => param.name).join("、") || "无"}`,
      weight: 0,
      description: action.description,
      references: scope ? [scope] : [],
    });
  }

  /*
   * 指标（业务口径）也是一等可检索概念：问「短彩信欠费金额怎么算」时，
   * 现成的口径定义比让模型从列注释里反推可靠得多。
   */
  for (const metric of definition.metrics ?? []) {
    const scopeType = definition.entityTypes.find((item) => item.id === metric.entityTypeId) ?? null;
    const scope = scopeType?.name ?? "";
    const source = scopeType ? entitySources(scopeType)[0] : undefined;
    const column = scopeType?.properties.find((item) => item.name === metric.property)?.sourceField ?? "";
    concepts.push({
      kind: "METRIC",
      name: metric.name,
      haystack: normalize([
        metric.name,
        describeBriefly(metric.description, 200),
        scope,
        metric.property,
        metric.aggregation,
        ...metric.dimensions,
        ...metric.filters.map((filter) => `${filter.property} ${filter.value}`),
        metric.timeProperty,
        ...metric.tags,
      ].join(" ")),
      values: normalize(columnValueOf(valueIndex, source?.schema ?? "", source?.view ?? "", column).join(" ")),
      detail: [
        `${metric.aggregation}${metric.property ? `(${metric.property})` : "（行数）"}`,
        scope ? `作用 ${scope}` : "还没选作用的对象类型",
        metric.filters.length ? `口径 ${metric.filters.map((filter) => `${filter.property}${filter.operator}${filter.value}`).join("、")}` : "",
        metric.dimensions.length ? `维度 ${metric.dimensions.join("、")}` : "",
        metric.unit ? `单位 ${metric.unit}` : "",
        // 状态位进检索结果的说明：模型一眼能分辨「已验收」和「还没定稿」。
        (metric.status ?? "draft") === "verified" ? "已验收" : "未验收（draft）",
      ].filter(Boolean).join("；"),
      weight: 0,
      description: metric.description,
      boundTable: source ? [source.schema, source.view].filter(Boolean).join(".") : "",
      dataSource: resourceNameOf(source),
      sourceColumn: column,
      references: scope ? [scope] : [],
    });
  }

  return concepts;
}

/**
 * 这次检索有没有「真命中」：整串关键词落在某个概念的名字 / 描述 / 已缓存取值上，**或者至少两个词重合**。
 *
 * 为什么要单独判：没命中时 rankSchemaConcepts 会给一批兜底推荐（实例数权重会让结果非空），
 * 只看 matches.length 永远判不出"没命中"，模型就会把兜底当成命中、换着词反复试探（2026-10-10 用户报的）。
 * 单个 2 字词的重合（搜「专线分类」碰到「业务」）是噪音，不算命中。
 *
 * 这里不碰 rankSchemaConcepts 的排序与分档，只回答"有没有落到东西"。
 */
export function schemaQueryHasStrongHit(concepts: readonly SchemaConcept[], query: string): boolean {
  const needle = normalize(query);
  if (!needle) return false;
  const tokens = queryTokens(query);
  return concepts.some((concept) => {
    const name = normalize(concept.name);
    if (name === needle || name.includes(needle) || needle.includes(name)) return true;
    if (needle.length >= 2 && concept.values && concept.values.includes(needle)) return true;
    if (needle.length >= 2 && concept.haystack.includes(needle)) return true;
    // 长问题（"统计互联网专线带宽≥100的条数"）整串不会出现在任何描述里，退回按词命中，但要有 ≥2 个词才算数。
    return tokens.filter((token) => token.length >= 2 && token !== needle && concept.haystack.includes(token)).length >= 2;
  });
}

export type RankSchemaOptions = {
  /** 只看这几类概念（不传 = 全都看）。 */
  kinds?: ConceptKind[];
  /**
   * 类型类概念（对象类型 / 指标 / 关系类型）保底占一半名额，默认开。
   *
   * 为什么：属性数量是对象类型的几十倍，光按分排，「订单」这种查询会被
   * 「订单.编号」「订单.金额」刷屏，模型拿不到真正能往下走的那一层。只在**有命中**时生效。
   */
  typeQuota?: boolean;
};

export type ScoredConcept = { concept: SchemaConcept; score: number; reason: string; matched: SchemaMatch["matched"] };

/** 类型类概念：这些是模型能接着往下走的东西（属性只能拿去过滤，走不了关系）。 */
export const TYPE_KINDS = new Set<ConceptKind>(["OBJECT_TYPE", "RELATION_TYPE", "METRIC"]);

/**
 * 排序规则刻意可解释，分三档、**每档一个固定分**：
 * 1. 名字：完全一致 100 / 包含 70 / 有 ≥2 个字重合 20+6n；
 * 2. 取值命中（列画像里的码值）45 —— 这是"业务黑话其实是一个码值"的情况，落点最实在；
 * 3. 描述 / 属性命中 30 —— 覆盖"口径写在列注释里"的情况。
 * 名字已经对上（≥70）时不再叠加后两档：否则一个啰嗦的描述会把真正的名字命中比下去。
 * 全都没命中时按实例数量兜底，至少让模型知道这个本体里最"重"的概念是什么。
 */
export function rankSchemaConcepts(concepts: readonly SchemaConcept[], query: string, maxConcepts: number, options: RankSchemaOptions = {}): SchemaMatch[] {
  const kinds = options.kinds?.length ? new Set(options.kinds) : null;
  const needle = normalize(query);
  const tokens = queryTokens(query);
  const scored: ScoredConcept[] = concepts
    .filter((concept) => !kinds || kinds.has(concept.kind))
    .map((concept) => {
      const name = normalize(concept.name);
      let score = 0;
      let reason = "";
      let matched: SchemaMatch["matched"] = "fallback";
      if (needle && name === needle) { score = 100; reason = "名称完全一致"; matched = "name"; }
      else if (needle && (name.includes(needle) || needle.includes(name))) { score = 70; reason = "名称包含查询词"; matched = "name"; }
      // 名字已经对上就不再叠加后两档：否则一个啰嗦的描述会把真正的名字命中比下去。
      if (score < 70) {
        const valueHit = needle.length >= 2 && Boolean(concept.values) && (concept.values ?? "").includes(needle);
        const textHit = needle.length >= 2 && concept.haystack.includes(needle);
        if (valueHit) {
          score += 45;
          matched = "value";
          reason = `取值命中：有列的取值包含「${query.trim()}」`;
        } else if (textHit) {
          score += 30;
          matched = "description";
          reason = "描述 / 属性里提到了查询词";
        } else {
          // 名字只有零星几个字重合，是弱信号；它排在取值 / 描述命中之后。
          const common = needle ? longestCommonSubstring(needle, name) : 0;
          if (common >= 2) { score = 20 + common * 6; reason = `名称与查询词有 ${common} 个字重合`; matched = "name"; }
          // 长问题（"统计互联网专线带宽≥100的条数"）整体不会出现在任何描述里，退回按词命中，最多算 3 个词。
          const hits = tokens.filter((token) => token.length >= 2 && token !== needle && concept.haystack.includes(token)).slice(0, 3);
          if (hits.length) {
            score += hits.length * 8;
            if (matched !== "name") matched = "description";
            if (!reason) reason = `描述 / 属性命中：${hits.join("、")}`;
          }
        }
      }
      return { concept, score: score + Math.min(10, concept.weight), reason, matched };
    });

  const matched = scored.filter((item) => item.score > 0);
  if (!matched.length) {
    /*
     * 都没命中时兜底给一批概念，而不是空手而归 —— 注意这里**不再按"有实例的才有资格"筛**：
     * 一个刚建好、图库还是空的本体，那样会一条都返回不了。weight 只影响排序，不影响有没有。
     */
    return scored
      .sort(compareScored)
      .slice(0, maxConcepts)
      .map((item) => toMatch(item, "fallback"));
  }
  return applyTypeQuota(matched.sort(compareScored), maxConcepts, options.typeQuota !== false).map((item) => toMatch(item));
}

export function compareScored(a: ScoredConcept, b: ScoredConcept) {
  return b.score - a.score || a.concept.name.localeCompare(b.concept.name, "zh-CN");
}

export function toMatch(item: ScoredConcept, forced?: SchemaMatch["matched"]): SchemaMatch {
  return {
    kind: item.concept.kind,
    name: item.concept.name,
    score: item.score,
    matched: forced ?? item.matched,
    reason: item.reason || "没命中关键词，按本体概念清单兜底推荐",
    detail: item.concept.detail,
    ...(item.concept.description ? { description: describeBriefly(item.concept.description, 300) } : {}),
    ...(item.concept.boundTable ? { bound_table: item.concept.boundTable } : {}),
    ...(item.concept.dataSource ? { data_source: item.concept.dataSource } : {}),
    ...(item.concept.sourceColumn ? { source_column: item.concept.sourceColumn } : {}),
    ...(item.concept.kind === "PROPERTY" || item.concept.kind === "METRIC" ? { object_type: item.concept.references?.[0] ?? "" } : {}),
  };
}

/**
 * 类型类概念（对象类型 / 指标 / 关系类型）保底占一半名额：**从尾部换掉分数最低的属性类命中**，
 * 不重排、不插队，已经被名字命中的东西位置不动。
 */
export function applyTypeQuota(ordered: ScoredConcept[], maxConcepts: number, enabled: boolean): ScoredConcept[] {
  const head = ordered.slice(0, maxConcepts);
  if (!enabled || head.length < 2) return head;
  const wanted = Math.ceil(head.length / 2);
  const kept = head.filter((item) => TYPE_KINDS.has(item.concept.kind)).length;
  if (kept >= wanted) return head;
  const extra = ordered.slice(maxConcepts).filter((item) => TYPE_KINDS.has(item.concept.kind));
  const out = [...head];
  for (let i = 0; i < wanted - kept && i < extra.length; i += 1) {
    for (let j = out.length - 1; j >= 0; j -= 1) {
      if (!TYPE_KINDS.has(out[j].concept.kind)) { out[j] = extra[i]; break; }
    }
  }
  return out;
}
