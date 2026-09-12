/**
 * 类之间的层级（父类 / 子类）与它带来的推理。
 *
 * 这是「第一档推理」：输入是**模式**（几十个类），不是数据，所以成本是 O(类数)，
 * 和数据规模完全解耦。它能回答的问题：
 *   - 这个类一共有哪些祖先（隐含的"也属于"，不需要逐条写出来）；
 *   - 它从祖先那里继承到哪些属性；
 *   - 这个层级本身有没有矛盾（父类不存在、继承成环、同名属性类型对不上）。
 *
 * 刻意不引入 zod、不依赖草稿或快照的具体形状：服务端（发布前校验）和浏览器
 * （编辑面板）共用同一份判断，两边不会各说各话——和 @/lib/ontology-sources 一个路子。
 */
export type HierarchyProperty = { name: string; dataType: string; required?: boolean };

export type HierarchyNode = {
  id: string;
  name: string;
  /** 父类 id。缺省或空数组表示这个类还没有层级（老快照没有这一项）。 */
  parents?: string[];
  properties?: HierarchyProperty[];
};

/** 一条层级问题。`severity: "WARN"` 是提示，不带的是自相矛盾的配置，会挡住发布。 */
export type HierarchyViolation = { rule: string; message: string; count: number; severity?: "WARN" };

export function parentIdsOf(node: Pick<HierarchyNode, "parents"> | null | undefined): string[] {
  return [...new Set((node?.parents ?? []).filter((id) => typeof id === "string" && id.trim()))];
}

export function indexNodes(nodes: readonly HierarchyNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

/**
 * 所有祖先，由近到远，不含自身。
 *
 * 用 visited 集合兜底：即使数据里有环（草稿可能暂时处在不合法状态），
 * 这里也只是停止向上走，不会挂死——校验器负责把环报出来。
 */
export function ancestorsOf(id: string, byId: Map<string, HierarchyNode>): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>([id]);
  let frontier = parentIdsOf(byId.get(id));
  while (frontier.length) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) continue;
      ordered.push(parentId);
      next.push(...parentIdsOf(parent));
    }
    frontier = next;
  }
  return ordered;
}

/** 所有后代。类只有几十个，这里按"谁把我当祖先"直接筛，比反向建表更不容易写错。 */
export function descendantsOf(id: string, nodes: readonly HierarchyNode[], byId: Map<string, HierarchyNode>): string[] {
  return nodes.filter((node) => node.id !== id && ancestorsOf(node.id, byId).includes(id)).map((node) => node.id);
}

/**
 * 从祖先继承来、且本类没有覆盖的属性。近的祖先优先：
 * 同名属性只要本类写了，就以本类为准，不再列为继承。
 */
export function inheritedPropertiesOf(node: HierarchyNode, byId: Map<string, HierarchyNode>) {
  const own = new Set((node.properties ?? []).map((property) => property.name));
  const result: { property: HierarchyProperty; from: string; fromId: string }[] = [];
  for (const ancestorId of ancestorsOf(node.id, byId)) {
    const ancestor = byId.get(ancestorId);
    if (!ancestor) continue;
    for (const property of ancestor.properties ?? []) {
      if (own.has(property.name)) continue;
      if (result.some((item) => item.property.name === property.name)) continue;
      result.push({ property, from: ancestor.name, fromId: ancestor.id });
    }
  }
  return result;
}

/** 最终生效的属性：自己写的 + 继承来的，自己写的优先。 */
export function effectivePropertiesOf(node: HierarchyNode, byId: Map<string, HierarchyNode>): HierarchyProperty[] {
  return [...(node.properties ?? []), ...inheritedPropertiesOf(node, byId).map((item) => item.property)];
}

/**
 * 祖先里那些**被本类覆盖掉**的同名属性。
 *
 * 和 inheritedPropertiesOf 正好互补：那个只关心"本类没写的"，这个只关心"本类写了的"，
 * 因为父子对同一个属性说法不一致时，问题恰恰出在后一种情况。
 */
export function overriddenAncestorPropertiesOf(node: HierarchyNode, byId: Map<string, HierarchyNode>) {
  const own = new Map((node.properties ?? []).map((property) => [property.name, property]));
  const result: { property: HierarchyProperty; own: HierarchyProperty; from: string }[] = [];
  const seen = new Set<string>();
  for (const ancestorId of ancestorsOf(node.id, byId)) {
    const ancestor = byId.get(ancestorId);
    if (!ancestor) continue;
    for (const property of ancestor.properties ?? []) {
      const mine = own.get(property.name);
      if (!mine || seen.has(property.name)) continue;
      seen.add(property.name);
      result.push({ property, own: mine, from: ancestor.name });
    }
  }
  return result;
}

/**
 * 可以作为父类的候选：排除自己，以及自己的所有后代。
 * 这条约束让界面上根本选不出环，而不是等保存之后再报错。
 */
export function selectableParentsOf(node: HierarchyNode, nodes: readonly HierarchyNode[]): HierarchyNode[] {
  const blocked = new Set([node.id, ...descendantsOf(node.id, nodes, indexNodes(nodes))]);
  return nodes.filter((candidate) => !blocked.has(candidate.id));
}

/** 找出所有继承环，返回每个环的类名路径（末位与首位相同，方便直接读）。 */
export function findInheritanceCycles(nodes: readonly HierarchyNode[]): string[][] {
  const byId = indexNodes(nodes);
  const found = new Map<string, string[]>();
  const visit = (id: string, stack: string[], onPath: Set<string>) => {
    if (onPath.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = [...new Set(cycle)].sort().join("|");
      if (!found.has(key)) found.set(key, cycle.map((item) => byId.get(item)?.name ?? item));
      return;
    }
    if (stack.includes(id)) return;
    const node = byId.get(id);
    if (!node) return;
    stack.push(id);
    onPath.add(id);
    for (const parentId of parentIdsOf(node)) visit(parentId, stack, onPath);
    onPath.delete(id);
    stack.pop();
  };
  for (const node of nodes) visit(node.id, [], new Set());
  return [...found.values()];
}

export function validateClassHierarchy(nodes: readonly HierarchyNode[]): HierarchyViolation[] {
  const byId = indexNodes(nodes);
  const violations: HierarchyViolation[] = [];

  for (const node of nodes) {
    for (const parentId of parentIdsOf(node)) {
      if (parentId === node.id) {
        violations.push({ rule: `${node.name}.parents`, message: `类「${node.name}」把自己设成了父类。`, count: 1 });
      } else if (!byId.has(parentId)) {
        violations.push({ rule: `${node.name}.parents`, message: `类「${node.name}」的父类不存在，可能已经被删掉了。`, count: 1 });
      }
    }
  }

  for (const cycle of findInheritanceCycles(nodes)) {
    violations.push({ rule: "class.inheritance.cycle", message: `类继承绕成了环：${cycle.join(" → ")}。`, count: 1 });
  }

  for (const node of nodes) {
    for (const { property, own, from } of overriddenAncestorPropertiesOf(node, byId)) {
      if (own.dataType !== property.dataType) {
        violations.push({
          rule: `${node.name}.${property.name}`,
          message: `「${node.name}.${property.name}」是 ${own.dataType}，但继承自「${from}」的同名属性是 ${property.dataType}，两边对不上。`,
          count: 1,
        });
      } else if (property.required && !own.required) {
        violations.push({
          rule: `${node.name}.${property.name}`,
          message: `「${from}.${property.name}」是必填，到了「${node.name}」被改成非必填。`,
          count: 1,
          severity: "WARN",
        });
      }
    }
  }

  return violations;
}
