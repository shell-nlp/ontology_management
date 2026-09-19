import type { InterfaceType, Property } from "@/lib/ontology-draft";

/**
 * 接口（Palantir 的 Interface）的纯逻辑：继承解析、实现检查、自检。
 *
 * 接口是**抽象契约**：只有属性与关系约束，不绑数据、不能被实例化；
 * 对象类型用 `implements` 声明"我实现了它"，并因此背上一组必须满足的条件。
 * 这里的函数不碰界面、不碰图库，服务端（发布前校验）与浏览器（编辑面板）共用同一份判断。
 *
 * **接口是本平台唯一的抽象机制**（2026-09-16 起）：类之间不再有父类 / 继承，
 * 要表达"这套应用只关心某几种能力"就用接口。
 */

export type InterfacePropertyLike = { name: string; dataType?: string; required?: boolean; displayName?: string; description?: string };

export type InterfaceLinkConstraintLike = {
  id: string;
  name: string;
  targetKind: "OBJECT_TYPE" | "INTERFACE";
  targetId: string;
  cardinality: "ONE" | "MANY";
  required?: boolean;
  description?: string;
};

export type InterfaceLike = {
  id: string;
  name: string;
  description?: string;
  properties?: readonly InterfacePropertyLike[];
  extends?: readonly string[];
  linkConstraints?: readonly InterfaceLinkConstraintLike[];
};

export type ImplementerLike = {
  id: string;
  name: string;
  properties?: readonly InterfacePropertyLike[];
  implements?: readonly string[];
};

/** 一条接口层面的问题；`severity: "WARN"` 是提示，不带的是会挡住发布的矛盾。 */
export type InterfaceViolation = { rule: string; message: string; count: number; severity?: "WARN" };

export function implementsIdsOf(entity: Pick<ImplementerLike, "implements"> | null | undefined): string[] {
  return [...new Set((entity?.implements ?? []).filter((id) => typeof id === "string" && id.trim()))];
}

export function extendedIdsOf(node: Pick<InterfaceLike, "extends"> | null | undefined): string[] {
  return [...new Set((node?.extends ?? []).filter((id) => typeof id === "string" && id.trim()))];
}

export function indexInterfaces(interfaces: readonly InterfaceLike[]) {
  return new Map(interfaces.map((item) => [item.id, item]));
}

/**
 * 接口的血缘：自身 + 所有祖先（近的在前，广度优先），去重防环。
 *
 * 草稿可能暂时不合法（继承绕成环），这里只保证不挂死；环由校验器报出来。
 */
export function interfaceLineage(interfaces: readonly InterfaceLike[], id: string): string[] {
  const byId = indexInterfaces(interfaces);
  const ordered = [id];
  const seen = new Set([id]);
  let frontier = extendedIdsOf(byId.get(id));
  while (frontier.length) {
    const next: string[] = [];
    for (const parentId of frontier) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) continue;
      ordered.push(parentId);
      next.push(...extendedIdsOf(parent));
    }
    frontier = next;
  }
  return ordered;
}

/** 所有祖先接口（不含自身），近的在前。 */
export function interfaceAncestorsOf(interfaces: readonly InterfaceLike[], id: string): string[] {
  return interfaceLineage(interfaces, id).slice(1);
}

/** 一个接口的最终属性：自己声明的 + 继承来的；同名以更近的定义为准。 */
export function effectiveInterfaceProperties<P extends { name: string } = InterfacePropertyLike>(interfaces: readonly InterfaceLike[], id: string): P[] {
  const byId = indexInterfaces(interfaces);
  const result: P[] = [];
  const seen = new Set<string>();
  for (const interfaceId of interfaceLineage(interfaces, id)) {
    const node = byId.get(interfaceId);
    if (!node) continue;
    for (const property of (node.properties ?? []) as unknown as P[]) {
      if (seen.has(property.name)) continue;
      seen.add(property.name);
      result.push(property);
    }
  }
  return result;
}

/** 接口属性带出处：`inherited` 为真表示这条属性来自祖先接口。 */
export function interfacePropertyRows<P extends { name: string } = InterfacePropertyLike>(
  interfaces: readonly InterfaceLike[],
  id: string,
): { property: P; from: string; fromId: string; inherited: boolean }[] {
  const byId = indexInterfaces(interfaces);
  const own = new Set(((byId.get(id)?.properties ?? []) as unknown as P[]).map((property) => property.name));
  const rows: { property: P; from: string; fromId: string; inherited: boolean }[] = [];
  for (const interfaceId of interfaceLineage(interfaces, id)) {
    const node = byId.get(interfaceId);
    if (!node) continue;
    for (const property of (node.properties ?? []) as unknown as P[]) {
      if (rows.some((row) => row.property.name === property.name)) continue;
      rows.push({ property, from: node.name, fromId: node.id, inherited: !own.has(property.name) });
    }
  }
  return rows;
}

/** 一个接口的最终关系约束：自己声明的 + 继承来的；同名以更近的为准。 */
export function effectiveInterfaceLinkConstraints(interfaces: readonly InterfaceLike[], id: string): InterfaceLinkConstraintLike[] {
  const byId = indexInterfaces(interfaces);
  const result: InterfaceLinkConstraintLike[] = [];
  const seen = new Set<string>();
  for (const interfaceId of interfaceLineage(interfaces, id)) {
    const node = byId.get(interfaceId);
    if (!node) continue;
    for (const constraint of node.linkConstraints ?? []) {
      if (seen.has(constraint.name)) continue;
      seen.add(constraint.name);
      result.push(constraint);
    }
  }
  return result;
}

/** 直接实现了这个接口的对象类型。 */
export function directImplementersOf(entities: readonly ImplementerLike[], interfaceId: string): ImplementerLike[] {
  return entities.filter((entity) => implementsIdsOf(entity).includes(interfaceId));
}

/**
 * 这个接口的全部实现者：直接实现的对象类型，以及实现了它**子接口**的对象类型。
 *
 * 与 Palantir 一致：实现了子接口就隐含实现了父接口，按父接口消费时应当能看到它们。
 */
export function implementersOf(
  interfaces: readonly InterfaceLike[],
  entities: readonly ImplementerLike[],
  interfaceId: string,
): { id: string; name: string; direct: boolean }[] {
  return entities
    .map((entity) => {
      const ids = implementsIdsOf(entity);
      if (ids.includes(interfaceId)) return { id: entity.id, name: entity.name, direct: true };
      const viaChild = ids.some((id) => interfaceAncestorsOf(interfaces, id).includes(interfaceId));
      return viaChild ? { id: entity.id, name: entity.name, direct: false } : null;
    })
    .filter((item): item is { id: string; name: string; direct: boolean } => Boolean(item));
}

/**
 * 一条具体关系类型能不能满足接口的关系约束。
 *
 * 关系类型是**双向**的（Palantir 的一条 link type 两侧都能走），
 * 所以实现方在这条关系的**任一头**都算满足：它当起点、另一端是对端算满足；
 * 它当终点、另一端是对端同样算满足。另一端要么就是要的那个对象类型，
 * 要么是实现了目标接口的对象类型。
 */
export function satisfiesLinkConstraint(
  entity: ImplementerLike,
  constraint: InterfaceLinkConstraintLike,
  relationship: { name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string },
  interfaces: readonly InterfaceLike[] = [],
  entities: readonly ImplementerLike[] = [],
): boolean {
  const asSource = relationship.sourceEntityTypeId === entity.id;
  const asTarget = relationship.targetEntityTypeId === entity.id;
  if (!asSource && !asTarget) return false;
  // 双向：实现方在关系哪一头，就从另一头取"对端"。
  const targetId = asSource ? relationship.targetEntityTypeId : relationship.sourceEntityTypeId;
  if (!targetId || !constraint.targetId) return false;
  const target = entities.find((item) => item.id === targetId);
  // 类之间不再有父子关系：关系约束的终点必须是那个对象类型本身（或实现了目标接口的类型）。
  if (constraint.targetKind === "OBJECT_TYPE") return targetId === constraint.targetId;
  if (targetId === constraint.targetId) return false;
  if (!target) return false;
  const ids = implementsIdsOf(target);
  return ids.includes(constraint.targetId) || ids.some((id) => interfaceAncestorsOf(interfaces, id).includes(constraint.targetId));
}

export type ImplementationCheck = {
  interfaceId: string;
  interfaceName: string;
  /** 接口要求、但这个对象类型没有的同名属性。 */
  missingProperties: string[];
  /** 对上了的接口属性（按同名映射）。 */
  mappedProperties: string[];
  /** 必填但还没有具体关系类型满足的关系约束。 */
  missingLinks: InterfaceLinkConstraintLike[];
  /** 已经满足的关系约束，以及是哪个关系类型满足的。 */
  satisfiedLinks: { constraint: InterfaceLinkConstraintLike; relationshipName: string }[];
  /** 是不是通过子接口间接实现的（间接实现的看不到自己的约束，只做展示）。 */
  direct: boolean;
};

/**
 * 对象类型实现接口的完整检查：每个已实现的接口一条结果。
 *
 * - 属性：接口里 `required` 的属性，对象类型必须有**同名**属性。
 *   Palantir 允许把现有属性映射到接口属性上；平台这一版按同名映射 —— 足够表达，
 *   也不必再维护第二张映射表；缺的同名属性在界面上可以一键补齐。
 * - 关系：`required` 的关系约束必须有一条具体关系类型满足它。
 */
export function checkImplementations(
  entity: ImplementerLike,
  interfaces: readonly InterfaceLike[],
  relationshipTypes: readonly { name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string }[],
  entities: readonly ImplementerLike[] = [],
): ImplementationCheck[] {
  // 类的属性就是它自己写的那些（没有继承可言）。
  const ownProperties = new Set((entity.properties ?? []).map((property) => property.name));
  return implementsIdsOf(entity).map((interfaceId) => {
    const node = interfaces.find((item) => item.id === interfaceId);
    const missingProperties: string[] = [];
    const mappedProperties: string[] = [];
    for (const property of effectiveInterfaceProperties(interfaces, interfaceId)) {
      if (ownProperties.has(property.name)) mappedProperties.push(property.name);
      else if (property.required !== false) missingProperties.push(property.name);
    }
    const missingLinks: InterfaceLinkConstraintLike[] = [];
    const satisfiedLinks: { constraint: InterfaceLinkConstraintLike; relationshipName: string }[] = [];
    for (const constraint of effectiveInterfaceLinkConstraints(interfaces, interfaceId)) {
      const hit = relationshipTypes.find((relationship) => satisfiesLinkConstraint(entity, constraint, relationship, interfaces, entities));
      if (hit) satisfiedLinks.push({ constraint, relationshipName: hit.name });
      else if (constraint.required !== false) missingLinks.push(constraint);
    }
    return {
      interfaceId,
      interfaceName: node?.name ?? "",
      missingProperties: [...new Set(missingProperties)],
      mappedProperties: [...new Set(mappedProperties)],
      missingLinks,
      satisfiedLinks,
      direct: true,
    };
  });
}

/** 接口自身的自检：重名、继承目标缺失/绕环、约束目标缺失。 */
export function validateInterfaces(definition: { interfaces: readonly InterfaceLike[]; entityTypes: readonly ImplementerLike[] }): InterfaceViolation[] {
  const violations: InterfaceViolation[] = [];
  const interfaces = definition.interfaces;
  const byName = new Map<string, string[]>();
  for (const item of interfaces) {
    const key = item.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), item.id]);
  }
  for (const item of interfaces) {
    const duplicates = byName.get(item.name.trim().toLowerCase()) ?? [];
    if (duplicates.length > 1) violations.push({ rule: "INTERFACE_DUPLICATE_NAME", message: `接口「${item.name}」重复定义。`, count: 1 });
    const own = new Set<string>();
    for (const property of item.properties ?? []) {
      if (own.has(property.name)) violations.push({ rule: "INTERFACE_DUPLICATE_PROPERTY", message: `接口「${item.name}」里属性「${property.name}」重复。`, count: 1 });
      own.add(property.name);
    }
    for (const parentId of extendedIdsOf(item)) {
      if (!interfaces.some((candidate) => candidate.id === parentId)) {
        violations.push({ rule: "INTERFACE_MISSING_PARENT", message: `接口「${item.name}」继承了一个不存在的接口。`, count: 1 });
      }
      if (interfaceAncestorsOf(interfaces, parentId).includes(item.id)) {
        violations.push({ rule: "INTERFACE_CYCLE", message: `接口「${item.name}」的继承绕成了环。`, count: 1 });
      }
    }
    for (const constraint of item.linkConstraints ?? []) {
      if (!constraint.targetId) { violations.push({ rule: "INTERFACE_LINK_TARGET_MISSING", message: `接口「${item.name}」的关系约束「${constraint.name}」还没选另一端。`, count: 1 }); continue; }
      const pool = constraint.targetKind === "INTERFACE" ? interfaces : definition.entityTypes;
      if (!pool.some((candidate) => candidate.id === constraint.targetId)) {
        violations.push({ rule: "INTERFACE_LINK_TARGET_MISSING", message: `接口「${item.name}」的关系约束「${constraint.name}」指向了一个不存在的目标。`, count: 1 });
      }
    }
  }
  return violations;
}

/** 接口实现的校验：实现了不存在的接口、缺必填属性、必填关系约束没满足。 */
export function validateInterfaceImplementations(
  definition: { interfaces: readonly InterfaceLike[]; entityTypes: readonly ImplementerLike[]; relationshipTypes: readonly { name: string; sourceEntityTypeId?: string; targetEntityTypeId?: string }[] },
): InterfaceViolation[] {
  const violations: InterfaceViolation[] = [];
  for (const entity of definition.entityTypes) {
    for (const interfaceId of implementsIdsOf(entity)) {
      if (!definition.interfaces.some((item) => item.id === interfaceId)) {
        violations.push({ rule: "IMPLEMENTS_MISSING_INTERFACE", message: `对象类型「${entity.name}」声明实现了一个不存在的接口。`, count: 1 });
      }
    }
    for (const check of checkImplementations(entity, definition.interfaces, definition.relationshipTypes, definition.entityTypes)) {
      if (!check.interfaceId || !check.interfaceName) continue;
      if (check.missingProperties.length) {
        violations.push({
          rule: "INTERFACE_PROPERTY_MISSING",
          message: `对象类型「${entity.name}」实现接口「${check.interfaceName}」，还缺必填属性：${check.missingProperties.join("、")}。`,
          count: check.missingProperties.length,
        });
      }
      for (const constraint of check.missingLinks) {
        const kind = constraint.targetKind === "INTERFACE" ? "接口" : "对象类型";
        violations.push({
          rule: "INTERFACE_LINK_MISSING",
          message: `对象类型「${entity.name}」实现接口「${check.interfaceName}」，还缺关系约束「${constraint.name}」（指向${kind}的${constraint.cardinality === "ONE" ? "一对一" : "一对多"}关系）。`,
          count: 1,
        });
      }
    }
  }
  return violations;
}

export type { InterfaceType, Property };
