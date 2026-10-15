import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 指标的发布前检查。
 *
 * 指标的正文是两件事：**关联了哪些对象类型**，以及**怎么算**（可以不算）。
 * 所以这里查三类问题：
 * 1. 关联指向不存在的类型 —— 拦发布（换台机器导入就是悬空引用）；
 * 2. 配了计算口径时：落点必须是**关联类型之一**，落点上的属性 / 维度 / 时间维度必须存在 —— 拦发布；
 * 3. **只描述、没有计算口径** —— 合法形态，但给一条 WARN 把"出不了数"说出来
 *    （别让人以为它已经能用了；模型也确实不能拿它出数，见 query-dsl 的 METRIC_NOT_CALCULABLE）。
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

    // ---- 关联：这个指标和谁有关 ----
    const related = metric.entityTypeIds ?? [];
    for (const id of related) {
      if (!typeById.has(id)) violations.push({ rule: label, message: `${label}关联的对象类型不存在（可能已被删除），请重新关联。`, count: 1 });
    }
    const relatedNames = related.map((id) => typeById.get(id)?.name ?? "").filter(Boolean);
    if (!related.length) {
      violations.push({ rule: label, message: `${label}还没有关联任何对象类型，别人看不出它算的是谁。`, count: 1, severity: "WARN" });
    }

    // ---- 计算：怎么算（可以不算）----
    const calculation = metric.calculation ?? null;
    if (!calculation) {
      violations.push({ rule: label, message: `${label}只有描述、没有计算口径 —— 模型能用它讲清这个口径，但不能用它出数。`, count: 1, severity: "WARN" });
      continue;
    }
    if (!calculation.entityTypeId) {
      // 写了算法但还没挑落点 = 待办（例如从外部导入、类型还没对上），提示而不拦 —— 拦的是"挑了却挑错"。
      violations.push({ rule: label, message: `${label}写了计算口径，但还没选落在哪个对象类型上 —— 在「指标」里挑一个关联类型，或者把它改成「只描述、不算数」。`, count: 1, severity: "WARN" });
      continue;
    }
    const type = typeById.get(calculation.entityTypeId);
    if (!type) {
      violations.push({ rule: label, message: `${label}的计算口径落在一个不存在的对象类型上，请重新选。`, count: 1 });
      continue;
    }
    if (!related.includes(calculation.entityTypeId)) {
      violations.push({ rule: label, message: `${label}的计算口径落在「${type.name}」上，但没有关联这个对象类型 —— 计算落点必须是关联类型之一。`, count: 1 });
    }
    if (!relatedNames.length) continue;
    const properties = new Map(type.properties.map((item) => [item.name, item]));

    if (calculation.property) {
      const aggregated = properties.get(calculation.property);
      if (!aggregated) {
        violations.push({ rule: label, message: `${label}要聚合的属性「${calculation.property}」在对象类型「${type.name}」里不存在。`, count: 1 });
      } else if (NUMERIC_AGGREGATIONS.has(calculation.aggregation) && aggregated.dataType !== "INTEGER" && aggregated.dataType !== "DECIMAL") {
        violations.push({ rule: label, message: `${label}用的是 ${calculation.aggregation}，但属性「${aggregated.name}」是 ${aggregated.dataType}；这样算出来的口径可能不是你想要的。`, count: 1, severity: "WARN" });
      }
    }
    for (const filter of calculation.filters) {
      if (!properties.has(filter.property)) {
        violations.push({ rule: label, message: `${label}的过滤条件用了「${filter.property}」，这个属性在对象类型「${type.name}」里不存在。`, count: 1 });
      }
    }
    for (const dimension of calculation.dimensions) {
      if (!properties.has(dimension)) {
        violations.push({ rule: label, message: `${label}的可用维度「${dimension}」在对象类型「${type.name}」里不存在。`, count: 1 });
      }
    }
    if (calculation.timeProperty && !properties.has(calculation.timeProperty)) {
      violations.push({ rule: label, message: `${label}的时间维度「${calculation.timeProperty}」在对象类型「${type.name}」里不存在。`, count: 1 });
    }
  }
  return violations;
}
