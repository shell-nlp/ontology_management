import { RDF, RDF_TYPE, RDFS_SUBCLASS, RDFS_DOMAIN, RDFS_RANGE, OWL_CLASS, OWL_OBJECT_PROPERTY, BKN_IMPLEMENTS, BKN_RELATIONSHIP, BKN_REL_TYPE, BKN_SOURCE, BKN_TARGET, BKN_NODE_PREFIX, BKN_CLASS_PREFIX, BKN_PROPERTY_PREFIX, BKN_RELATIONSHIP_PREFIX, BKN_REL_TYPE_PREFIX, BKN_CLASS_META, BKN_INTERFACE_META, BKN_PROPERTY_META } from "./vocabulary";
import { iriSegment, sparqlString } from "./protocol";
import { sparqlLiteral } from "@/lib/framework/graph/schema-inference";
import { type GraphDefinitionLike, type GraphWriteSnapshot } from "@/lib/framework/graph/types";

/**
 * 把本体定义里的类层级与端点契约翻成 RDF 三元组，随发布一起写进图库。
 *
 * - `rdfs:subClassOf`：**接口**落到图里（接口继承接口、对象类型实现接口），读路径才能用属性路径做类型传播；
 * - `rdfs:domain` / `rdfs:range`：关系两端的类，供外部 SPARQL 工具与后续校验使用；
 * - 每个类同时声明 `owl:Class` 与 `urn:bkn:Class`：前者是标准说法，后者是平台的
 *   元模型标记，实例查询靠它把类排除在对象之外。
 *
 * 纯函数，便于单测；发布流程负责把它和实例三元组一起提交。
 */
export function schemaStatements(definition: GraphDefinitionLike): string[] {
  const statements: string[] = [];
  const nameById = new Map(definition.entityTypes.filter((entity) => entity.id).map((entity) => [entity.id as string, entity.name]));
  const interfaceNameById = new Map((definition.interfaces ?? []).filter((item) => item.id).map((item) => [item.id as string, item.name]));
  // 接口是抽象类：也要声明出来（外部 SPARQL 工具能看见），接口之间的继承照写 subClassOf。
  for (const item of definition.interfaces ?? []) {
    const iri = `<${BKN_CLASS_PREFIX}${iriSegment(item.name)}>`;
    statements.push(`${iri} <${RDF_TYPE}> <${OWL_CLASS}> .`);
    statements.push(`${iri} <${RDF_TYPE}> <${BKN_INTERFACE_META}> .`);
    for (const parentId of item.extends ?? []) {
      const parentName = interfaceNameById.get(parentId);
      if (!parentName) continue;
      statements.push(`${iri} <${RDFS_SUBCLASS}> <${BKN_CLASS_PREFIX}${iriSegment(parentName)}> .`);
    }
  }
  for (const entity of definition.entityTypes) {
    const classIri = `<${BKN_CLASS_PREFIX}${iriSegment(entity.name)}>`;
    statements.push(`${classIri} <${RDF_TYPE}> <${OWL_CLASS}> .`);
    statements.push(`${classIri} <${RDF_TYPE}> <${BKN_CLASS_META}> .`);
    for (const interfaceId of entity.implements ?? []) {
      const interfaceName = interfaceNameById.get(interfaceId);
      if (!interfaceName) continue;
      const interfaceIri = `<${BKN_CLASS_PREFIX}${iriSegment(interfaceName)}>`;
      // 接口在 RDF 侧也是类：写 subClassOf，读路径的类型传播（?t rdfs:subClassOf* <接口>）
      // 于是「按接口筛对象」天然可用；再写一条自家谓词，读骨架时才能把「实现」与「接口继承」分开画。
      statements.push(`${classIri} <${RDFS_SUBCLASS}> ${interfaceIri} .`);
      statements.push(`${classIri} <${BKN_IMPLEMENTS}> ${interfaceIri} .`);
    }
  }
  for (const relationship of definition.relationshipTypes) {
    const predicate = `<${BKN_REL_TYPE_PREFIX}${iriSegment(relationship.name)}>`;
    statements.push(`${predicate} <${RDF_TYPE}> <${OWL_OBJECT_PROPERTY}> .`);
    statements.push(`${predicate} <${RDF_TYPE}> <${BKN_PROPERTY_META}> .`);
    const source = relationship.sourceEntityTypeId ? nameById.get(relationship.sourceEntityTypeId) : undefined;
    const target = relationship.targetEntityTypeId ? nameById.get(relationship.targetEntityTypeId) : undefined;
    if (source) statements.push(`${predicate} <${RDFS_DOMAIN}> <${BKN_CLASS_PREFIX}${iriSegment(source)}> .`);
    if (target) statements.push(`${predicate} <${RDFS_RANGE}> <${BKN_CLASS_PREFIX}${iriSegment(target)}> .`);
  }
  return statements;
}

/** RDF 投影的唯一出口。Jena 与内置后端共用相同的 IRI、字面量与关系具体化规则。 */
export function snapshotStatements(snapshot: GraphWriteSnapshot): string[] {
  const statements: string[] = [];
  for (const node of snapshot.nodes) {
    const subject = `<${BKN_NODE_PREFIX}${iriSegment(node.id)}>`;
    for (const label of node.labels) statements.push(`${subject} <${RDF_TYPE}> <${BKN_CLASS_PREFIX}${iriSegment(label)}> .`);
    const entityType = snapshot.definition.entityTypes.find((type) => node.labels.includes(type.name));
    for (const [key, value] of Object.entries(node.properties)) {
      const dataType = entityType?.properties.find((property) => property.name === key)?.dataType ?? "TEXT";
      const values = dataType === "JSON" || !Array.isArray(value) ? [value] : value;
      for (const item of values) {
        const literal = sparqlLiteral(item, dataType);
        if (literal !== null) statements.push(`${subject} <${BKN_PROPERTY_PREFIX}${iriSegment(key)}> ${literal} .`);
      }
    }
  }
  for (const relationship of snapshot.relationships) {
    const source = `<${BKN_NODE_PREFIX}${iriSegment(relationship.sourceId)}>`;
    const target = `<${BKN_NODE_PREFIX}${iriSegment(relationship.targetId)}>`;
    const reified = `<${BKN_RELATIONSHIP_PREFIX}${iriSegment(relationship.id)}>`;
    statements.push(`${source} <${BKN_REL_TYPE_PREFIX}${iriSegment(relationship.type)}> ${target} .`);
    statements.push(`${reified} <${RDF_TYPE}> <${BKN_RELATIONSHIP}> .`);
    statements.push(`${reified} <${BKN_REL_TYPE}> ${sparqlString(relationship.type)} .`);
    statements.push(`${reified} <${BKN_SOURCE}> ${source} .`);
    statements.push(`${reified} <${BKN_TARGET}> ${target} .`);
    const relationshipType = snapshot.definition.relationshipTypes.find((type) => type.name === relationship.type);
    for (const [key, value] of Object.entries(relationship.properties)) {
      const dataType = relationshipType?.properties.find((property) => property.name === key)?.dataType ?? "TEXT";
      const values = dataType === "JSON" || !Array.isArray(value) ? [value] : value;
      for (const item of values) {
        const literal = sparqlLiteral(item, dataType);
        if (literal !== null) statements.push(`${reified} <${BKN_PROPERTY_PREFIX}${iriSegment(key)}> ${literal} .`);
      }
    }
  }
  statements.push(...schemaStatements(snapshot.definition));
  return statements;
}
