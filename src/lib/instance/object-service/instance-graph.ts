import type { GraphData } from "@/lib/infrastructure/graph/types";
import type { ObjectContext, ObjectRecord } from "./types";
import { queryAllObjects } from "./index";
import { queryLinks } from "./links";
import { readEditSnapshot } from "./edit-overlay";
import { clamp } from "./common";

export type InstanceGraph = GraphData & { warnings: string[] };

/** 实例图谱只取有界虚拟对象和相关关系，不依赖整份对象或关系物化。 */
export async function readInstanceGraph(
  context: ObjectContext,
  options: { labels?: string[]; relationshipTypes?: string[]; search?: string | null; nodeLimit?: number; linkLimit?: number } = {},
): Promise<InstanceGraph> {
  const nodeLimit = clamp(options.nodeLimit, 1, 500, 300);
  const linkLimit = clamp(options.linkLimit, 1, 2000, 2000);
  const warnings: string[] = [];
  const records: ObjectRecord[] = [];
  while (records.length < nodeLimit) {
    const take = Math.min(200, nodeLimit - records.length);
    const page = await queryAllObjects(context, { labels: options.labels, text: options.search?.trim() || undefined, limit: take, offset: records.length });
    records.push(...page.rows);
    warnings.push(...page.warnings);
    if (page.total !== null && page.total > nodeLimit) warnings.push(`命中的对象超过一屏：最多展示 ${nodeLimit} 个（共 ${page.total} 个），请按对象类型或关键字收窄。`);
    if (!page.rows.length || records.length >= (page.total ?? Infinity) || page.rows.length < take) break;
  }
  const unique = new Map(records.map((row) => [row.objectId, row]));
  if (unique.size < records.length) warnings.push(`当前查询 ${records.length} 行对应 ${unique.size} 个唯一对象，主键重复合并 ${records.length - unique.size} 行；请配置唯一主键或通过取数口径明确去重规则。`);
  const nodes = [...unique.values()].map((row) => ({ id: row.objectId, labels: [row.entityType], properties: row.properties }));
  const onScreen = new Set(nodes.map((node) => node.id));
  const relationships = new Map<string, GraphData["relationships"][number]>();
  const scopedContext = options.relationshipTypes?.length
    ? { ...context, definition: { ...context.definition, relationshipTypes: context.definition.relationshipTypes.filter((type) => options.relationshipTypes!.includes(type.name)) } }
    : context;
  const groups = new Map<string, ObjectRecord[]>();
  for (const row of records) groups.set(row.entityType, [...(groups.get(row.entityType) ?? []), row]);
  let omitted = 0;
  for (const [entityType, group] of groups) {
    if (relationships.size >= linkLimit) { warnings.push(`当前图谱关系达到 ${linkLimit} 条展示上限。`); break; }
    let result;
    try {
      result = await queryLinks(scopedContext, { seed: { entityType, keys: group.map((row) => row.primaryKey) }, limit: Math.min(500, linkLimit - relationships.size) });
    } catch (error) {
      warnings.push(`「${entityType}」关系读取失败，当前图谱关系不完整：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    warnings.push(...result.warnings);
    if (result.truncated) warnings.push(`「${entityType}」相关关系只返回了部分结果；可选中对象继续展开邻域。`);
    for (const link of result.links) {
      if (!onScreen.has(link.source.objectId) || !onScreen.has(link.target.objectId)) { omitted++; continue; }
      relationships.set(link.linkRef, { id: link.linkRef, type: link.relationshipType, source: link.source.objectId, target: link.target.objectId, properties: link.properties });
    }
  }
  const snapshot = await readEditSnapshot(context);
  for (const link of snapshot?.relationships ?? []) {
    if (relationships.size >= linkLimit) { warnings.push(`当前图谱关系达到 ${linkLimit} 条展示上限。`); break; }
    if (onScreen.has(link.sourceId) && onScreen.has(link.targetId) && (!options.relationshipTypes?.length || options.relationshipTypes.includes(link.type))) relationships.set(link.id, { id: link.id, type: link.type, source: link.sourceId, target: link.targetId, properties: link.properties });
  }
  if (omitted) warnings.push("部分关系的另一端不在当前展示范围，未画出悬空边；选中对象展开邻域可加载相邻对象。");
  return { nodes, relationships: [...relationships.values()], warnings: [...new Set(warnings)] };
}
