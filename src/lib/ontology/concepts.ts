import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 把一份本体定义拍平成"概念清单"（2026-10-10，为检索/向量检索打底）。
 *
 * 为什么要有这一层：对象类型 / 属性 / 关系类型 / 接口 / 指标 / 动作 / 规则 / 分组
 * 在定义里是七种不同的结构，可检索的只有"名字 + 说明 + 落点"这三件事。
 * 拍成一行一条之后，检索面就只有一张表：现在落进
 * `ontology_platform.ontology_concepts` 的 `search_text`（全文/trigram），
 * 将来算 embedding 也是对着这一张表算 —— 不用再为每种概念各写一遍。
 *
 * **纯函数**：不连库、不认识 TypeORM，单测可以直接摆一个最小定义（`tests/lib/ontology-concepts.test.ts`）。
 */
export const ONTOLOGY_CONCEPT_KINDS = [
  "GROUP",
  "OBJECT_TYPE",
  "PROPERTY",
  "RELATION_TYPE",
  "INTERFACE",
  "ACTION",
  "RULE",
  "METRIC",
] as const;

export type OntologyConceptKind = (typeof ONTOLOGY_CONCEPT_KINDS)[number];

export type OntologyConcept = {
  kind: OntologyConceptKind;
  /** 概念名（属性用 `对象类型.属性名`，和其它工具里的写法保持一致）。 */
  name: string;
  /** 挂在哪个对象类型下；关系类型写两个端点，分组自身为空串。 */
  objectType: string;
  /** 一句话的检索文本：名字 + 说明 + 落点（表/列/端点/维度/单位…）。 */
  text: string;
};

/** 检索文本里每段之间用空格，连续空白折成一个 —— 存进库里要稳定可比。 */
function join(parts: Array<string | null | undefined>) {
  return parts.filter((part) => part && String(part).trim()).join(" ").replace(/\s+/g, " ").trim();
}

function tablesOf(sources: OntologyDefinition["entityTypes"][number]["sources"]) {
  return (sources ?? []).flatMap((source) => [
    source.view,
    source.schema ? `${source.schema}.${source.view}` : "",
    ...(source.primaryKey ?? []),
    source.titleField ?? "",
  ]).filter(Boolean);
}

export function conceptsOfDefinition(definition: OntologyDefinition): OntologyConcept[] {
  const groupNameById = new Map((definition.groups ?? []).map((item) => [item.id, item.name]));
  const interfaceNameById = new Map((definition.interfaces ?? []).map((item) => [item.id, item.name]));
  const typeNameById = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
  const actionNameById = new Map(definition.actionTypes.map((item) => [item.id, item.name]));
  const concepts: OntologyConcept[] = [];
  const push = (kind: OntologyConceptKind, name: string, objectType: string, parts: Array<string | null | undefined>) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    concepts.push({ kind, name: trimmed, objectType, text: join([trimmed, ...parts]) });
  };

  // 概念分组：只有名字，但"客户域里有什么"这类问法要靠它。
  for (const group of definition.groups ?? []) push("GROUP", group.name, "", []);

  for (const entity of definition.entityTypes) {
    const group = groupNameById.get(entity.groupId ?? "") ?? "";
    const implemented = (entity.implements ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const tables = tablesOf(entity.sources);
    push("OBJECT_TYPE", entity.name, entity.name, [
      entity.description,
      group ? `分组 ${group}` : "",
      implemented.length ? `实现接口 ${implemented.join("、")}` : "",
      tables.length ? `绑定表 ${tables.join("、")}` : "",
      entity.properties.length ? `属性 ${entity.properties.map((property) => property.name).join("、")}` : "",
      entity.displayProperty ? `展示属性 ${entity.displayProperty}` : "",
    ]);

    for (const property of entity.properties ?? []) {
      const source = (entity.sources ?? []).find((item) => !property.sourceId || item.id === property.sourceId) ?? entity.sources?.[0];
      push("PROPERTY", `${entity.name}.${property.name}`, entity.name, [
        property.description,
        `类型 ${property.dataType}`,
        source?.view ? `取自 ${source.view}.${property.sourceField ?? ""}` : property.sourceField ? `取自 ${property.sourceField}` : "",
        property.required ? "必填" : "",
        (property.enumValues ?? []).length ? `取值 ${(property.enumValues ?? []).map((item) => `${item.value}${item.label ? `=${item.label}` : ""}`).join("、")}` : "",
      ]);
    }
  }

  for (const relationship of definition.relationshipTypes) {
    const source = typeNameById.get(relationship.sourceEntityTypeId) ?? "";
    const target = typeNameById.get(relationship.targetEntityTypeId) ?? "";
    const link = relationship.linkSource;
    push("RELATION_TYPE", relationship.name, [source, target].filter(Boolean).join(" ↔ "), [
      relationship.description,
      `端点 ${source || "未指定"} ↔ ${target || "未指定"}`,
      relationship.cardinality ? `数量关系 ${relationship.cardinality}` : "",
      link?.view ? `取自 ${link.view}` : "",
    ]);
  }

  for (const item of definition.interfaces ?? []) {
    const extendsNames = (item.extends ?? []).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const implementers = definition.entityTypes.filter((entity) => (entity.implements ?? []).includes(item.id)).map((entity) => entity.name);
    push("INTERFACE", item.name, implementers.join("、"), [
      item.description,
      extendsNames.length ? `继承 ${extendsNames.join("、")}` : "",
      item.properties.length ? `接口属性 ${item.properties.map((property) => property.name).join("、")}` : "",
      implementers.length ? `实现方 ${implementers.join("、")}` : "还没有对象类型实现它",
    ]);
  }

  for (const action of definition.actionTypes) {
    const scope = typeNameById.get(action.scopeEntityTypeId) ?? "";
    push("ACTION", action.name, scope, [
      action.description,
      `动作 code ${action.code}`,
      scope ? `作用于 ${scope}` : "",
      action.params.length ? `入参 ${action.params.map((param) => param.name).join("、")}` : "无入参",
    ]);
  }

  for (const rule of definition.rules ?? []) {
    const boundAction = rule.actionId ? actionNameById.get(rule.actionId) ?? "" : "";
    push("RULE", rule.name, boundAction, [
      rule.message,
      rule.effect === "WARN" ? "提示" : "拦截",
      boundAction ? `挂在动作 ${boundAction}` : "对所有动作生效",
      rule.enabled === false ? "已停用" : "",
    ]);
  }

  for (const metric of definition.metrics ?? []) {
    const scope = typeNameById.get(metric.entityTypeId) ?? "";
    push("METRIC", metric.name, scope, [
      metric.description,
      `${metric.aggregation}${metric.property ? `(${metric.property})` : "（行数）"}`,
      scope ? `作用 ${scope}` : "",
      metric.unit ? `单位 ${metric.unit}` : "",
      (metric.dimensions ?? []).length ? `维度 ${metric.dimensions.join("、")}` : "",
      (metric.filters ?? []).length ? `口径 ${metric.filters.map((filter) => `${filter.property}${filter.operator}${filter.value}`).join("、")}` : "",
      (metric.tags ?? []).length ? `标签 ${metric.tags.join("、")}` : "",
      (metric.status ?? "draft") === "verified" ? "已验收" : "未验收",
    ]);
  }

  return concepts;
}
