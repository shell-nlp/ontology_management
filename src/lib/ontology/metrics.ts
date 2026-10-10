import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 指标的发布前检查。
 *
 * 指标只描述口径，指向的东西必须真的存在 —— 指向不存在的对象类型或属性，换台机器导入就是悬空引用，
 * 模型拿着它也算不出数。所以「指错了」挡发布，「还没选类型」只提醒（结构可以先搭起来）。
 *
 * 与 `relationship-keys.ts` / `link-source.ts` 同一个套路：一个关注点一个小模块，
 * 由 `validateVersionSnapshot` 统一收口。
 */
export type MetricViolation = { rule: string; message: string; count: number; severity?: "WARN" };

/** 这些聚合只有在数值属性上才有意义；用到文本属性上给一条提醒（不挡发布）。 */
const NUMERIC_AGGREGATIONS = new Set(["SUM", "AVG", "MIN", "MAX"]);

export function metricViolations(definition: OntologyDefinition): MetricViolation[] {
  const violations: MetricViolation[] = [];
  const typeById = new Map(definition.entityTypes.map((item) => [item.id, item]));
  const seenNames = new Set<string>();
  // `?? []`：定义来自 zod（默认空数组），但这个函数也会被直接喂手工拼的定义（测试、旧快照），别在这里崩。
  for (const metric of definition.metrics ?? []) {
    const label = `指标「${metric.name}」`;
    if (seenNames.has(metric.name)) {
      violations.push({ rule: label, message: `${label}重名了：同名指标在清单里分不清谁是谁，改一个名字。`, count: 1 });
    }
    seenNames.add(metric.name);

    const type = metric.entityTypeId ? typeById.get(metric.entityTypeId) : undefined;
    if (metric.entityTypeId && !type) {
      violations.push({ rule: label, message: `${label}作用的对象类型不存在（可能已被删除），请重新选一个。`, count: 1 });
      continue;
    }
    if (!type) {
      violations.push({ rule: label, message: `${label}还没有选作用的对象类型，别人看不出它算的是谁。`, count: 1, severity: "WARN" });
      continue;
    }
    const properties = new Map(type.properties.map((item) => [item.name, item]));

    if (metric.property) {
      const aggregated = properties.get(metric.property);
      if (!aggregated) {
        violations.push({ rule: label, message: `${label}要聚合的属性「${metric.property}」在对象类型「${type.name}」里不存在。`, count: 1 });
      } else if (NUMERIC_AGGREGATIONS.has(metric.aggregation) && aggregated.dataType !== "INTEGER" && aggregated.dataType !== "DECIMAL") {
        violations.push({ rule: label, message: `${label}用的是 ${metric.aggregation}，但属性「${aggregated.name}」是 ${aggregated.dataType}；这样算出来的口径可能不是你想要的。`, count: 1, severity: "WARN" });
      }
    }
    for (const filter of metric.filters) {
      if (!properties.has(filter.property)) {
        violations.push({ rule: label, message: `${label}的过滤条件用了「${filter.property}」，这个属性在对象类型「${type.name}」里不存在。`, count: 1 });
      }
    }
    for (const dimension of metric.dimensions) {
      if (!properties.has(dimension)) {
        violations.push({ rule: label, message: `${label}的可用维度「${dimension}」在对象类型「${type.name}」里不存在。`, count: 1 });
      }
    }
    if (metric.timeProperty && !properties.has(metric.timeProperty)) {
      violations.push({ rule: label, message: `${label}的时间维度「${metric.timeProperty}」在对象类型「${type.name}」里不存在。`, count: 1 });
    }
  }
  return violations;
}
