import { getObjectIndex } from "@/lib/infrastructure/object-index";
import type { GraphData } from "@/lib/infrastructure/graph/types";
import type { ObjectContext } from "@/lib/instance/object-service/types";
import { isMaterializationCurrent } from "@/lib/ontology/materialization-stamp";

/**
 * 实例图谱的数据装配（**走对象服务，不读图库**）。
 *
 * 为什么不读图库：图库扛不住大实例量（对象/关系几百万级），平台的定位是
 * **图库只做类型层的推理**（对象类型 / 关系类型 / 接口 / 指标这些定义），
 * 实例层的对象与关系一律走对象服务 —— 对象索引（ClickHouse）为主、按需回源兜底。
 *
 * 拼图的三步（和 `graphFromSnapshot` 的口径一致，界面上看不出差别）：
 * 1. 节点：按标签 / 关键字从对象索引里取一屏（`nodeLimit`）；
 * 2. 边：只看**这些节点**上的关系（`nodeKeys`，双向都算）；
 * 3. **两端都在这一屏里的边才画** —— 免得出现指向画布外的悬空边，跟快照那条路一致。
 *
 * 关系类型是双向的，边只存一行，这里两个方向都能查到；`id` 用
 * `关系类型|起点对象键|终点对象键`，稳定且唯一（画布只拿它当 key / 选中标识，不解析）。
 */
export type InstanceGraph = GraphData & {
  /** 如实告知：索引是空的、边被截断了……不静默。 */
  warnings: string[];
};

export async function readInstanceGraph(
  context: ObjectContext,
  options: { labels?: string[]; relationshipTypes?: string[]; search?: string | null; nodeLimit?: number; linkLimit?: number } = {},
): Promise<InstanceGraph> {
  const index = getObjectIndex();
  const nodeLimit = Math.max(1, Math.floor(options.nodeLimit ?? 300));
  const warnings: string[] = [];
  const manifests = await index.listMaterializations(context.targetId);
  const current = context.definition.entityTypes.filter((type) => isMaterializationCurrent(context.definition, type.name, manifests.find((item) => item.entityType === type.name))).map((type) => type.name);
  const requested = (options.labels ?? []).filter(Boolean);
  const labels = requested.length ? requested.filter((label) => current.includes(label)) : current;
  if (!labels.length) return { nodes: [], relationships: [], warnings: ["没有与当前定义匹配的完整索引。请选择业务对象类型并从数据源加载虚拟邻域。"] };
  const found = await index.searchObjects({
    targetId: context.targetId,
    labels,
    text: options.search?.trim() || undefined,
    limit: nodeLimit,
    offset: 0,
  });
  const nodes = found.hits.map((hit) => ({
    id: hit.objectId,
    labels: hit.labels.length ? hit.labels : [hit.entityType],
    properties: hit.properties,
  }));
  if (found.total > found.hits.length) {
    warnings.push(`命中的对象超过一屏：画的是前 ${found.hits.length} 个（共 ${found.total} 个）。要看别的就在左侧按对象类型 / 关键字收窄。`);
  }
  if (!nodes.length) {
    warnings.push("对象索引里没有这些对象类型的对象：先在对象页「索引与物化」整份物化，或发布一版快照。");
    return { nodes, relationships: [], warnings };
  }
  const nodeKeys = found.hits.map((hit) => hit.objectKey).filter(Boolean);
  const linkLimit = Math.max(1, Math.floor(options.linkLimit ?? 2000));
  const currentRelations = context.definition.relationshipTypes.filter((type) => (!options.relationshipTypes?.length || options.relationshipTypes.includes(type.name)) && isMaterializationCurrent(context.definition, type.name, manifests.find((item) => item.entityType === type.name))).map((type) => type.name);
  if (!currentRelations.length) return { nodes, relationships: [], warnings: [...warnings, "关系索引未完成或已失效；可从业务对象加载实时关系。"] };
  const edges = await index.searchLinks({
    targetId: context.targetId,
    relationshipTypes: currentRelations,
    nodeKeys,
    limit: linkLimit,
    offset: 0,
  });
  if (edges.total > edges.links.length) {
    warnings.push(`这一屏的关系超过 ${linkLimit} 条：只画了前 ${edges.links.length} 条（共 ${edges.total} 条）。`);
  }
  const onScreen = new Set(nodes.map((node) => node.id));
  const relationships = edges.links
    .filter((link) => onScreen.has(link.source.objectId) && onScreen.has(link.target.objectId))
    .map((link) => ({
      id: `${link.relationshipType}|${link.source.objectKey}|${link.target.objectKey}`,
      type: link.relationshipType,
      source: link.source.objectId,
      target: link.target.objectId,
      properties: link.properties,
    }));
  const dangling = edges.links.length - relationships.length;
  if (dangling > 0) {
    warnings.push(`有 ${dangling} 条关系的另一端不在这一屏里（它的对象类型可能还没物化），这些边没有画出来。`);
  }
  return { nodes, relationships, warnings };
}
