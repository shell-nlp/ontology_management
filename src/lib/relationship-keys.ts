/**
 * 关系类型的键映射（Palantir 的 link type Key）：这条关系类型在数据上怎么把两端的对象类型接起来。
 *
 * 平台只在类型层建模（对象本身不入库），所以映射是**声明式**的：它说明"连接表里的哪一列对上
 * 哪一端对象类型的哪个属性"，给将来的实例层、数据绑定和模型推理用，不参与当前发布图的构建。
 * 因此**空映射不算错误**，只有"填了但指向不存在的东西"才会被拦。
 */
export type KeyMapping = { linkProperty?: string; entityProperty?: string };

/*
 * 入参用结构类型而不是 `OntologyDefinition`：这里的规则只关心属性名与主键列，
 * 这样单测可以摆一个最小对象、工具也不必先过一遍 zod（和 modeling-review.ts 的做法一致）。
 */
export type KeyMappableProperty = { name: string; required?: boolean; unique?: boolean; sourceField?: string; sourceId?: string };
export type KeyMappableEntity = {
  id?: string;
  properties?: readonly KeyMappableProperty[];
  sources?: readonly { id?: string; primaryKey?: readonly string[] }[];
};
export type KeyMappableRelation = {
  name: string;
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  sourceKeyMappings?: readonly KeyMapping[];
  targetKeyMappings?: readonly KeyMapping[];
};
export type KeyMappableDefinition = {
  entityTypes: readonly ({ id: string; name: string } & KeyMappableEntity)[];
  relationshipTypes: readonly KeyMappableRelation[];
};

/** 界面与工具统一用这个形状读映射：没配过就是两个空数组。 */
export function relationKeyMappings(relation: Pick<KeyMappableRelation, "sourceKeyMappings" | "targetKeyMappings"> | null | undefined) {
  return {
    source: [...(relation?.sourceKeyMappings ?? [])],
    target: [...(relation?.targetKeyMappings ?? [])],
  };
}

/** 丢掉全空的行（界面上点了「添加映射」还没填的那种），保留真正的映射。 */
export function keyMappingRows(mappings: readonly KeyMapping[] | undefined) {
  return (mappings ?? [])
    .map((row) => ({ linkProperty: (row.linkProperty ?? "").trim(), entityProperty: (row.entityProperty ?? "").trim() }))
    .filter((row) => row.linkProperty || row.entityProperty);
}

/**
 * 对象类型的主键属性名。
 *
 * 主键在来源上是"列"（`sources[].primaryKey`），属性用 `sourceField` 指回列，所以要反过来找。
 * 没有绑来源的对象类型按导入约定把主键记成「必填 + 唯一」，这里同样认。
 */
export function primaryKeyPropertyNames(entity: KeyMappableEntity | null | undefined): string[] {
  if (!entity) return [];
  const names = new Set<string>();
  const properties = entity.properties ?? [];
  for (const source of entity.sources ?? []) {
    const keys = (source.primaryKey ?? []).filter(Boolean);
    if (!keys.length) continue;
    for (const property of properties) {
      const column = property.sourceField?.trim() || property.name;
      // 一份来源只有在属性没指明来源、或就指到这份来源时才算命中。
      const owns = !property.sourceId || property.sourceId === source.id;
      if (owns && keys.includes(column)) names.add(property.name);
    }
  }
  if (!names.size) {
    for (const property of properties) if (property.required && property.unique) names.add(property.name);
  }
  return [...names];
}

/** 一句话说清一条映射，给界面与模型工具共用：`CUST_ID → 客户标识`。 */
export function keyMappingLabel(row: KeyMapping) {
  const link = (row.linkProperty ?? "").trim();
  const entity = (row.entityProperty ?? "").trim();
  if (link && entity) return `${link} → ${entity}`;
  if (entity) return `外键 ${entity}`;
  if (link) return `${link} → ?`;
  return "";
}

/** 发布前校验的一条结论，形状与 `SnapshotViolation` 一致。severity 为 WARN 的不挡发布。 */
export type KeyMappingViolation = { rule: string; message: string; count: number; severity?: "WARN" };

/**
 * 关系类型的键映射自检。查出四类问题：
 * 1. 映射指向的对象类型属性不存在 —— **挡发布**：换台机器导入就是悬空引用；
 * 2. 映射指向的属性不是主键（对象类型有主键时）—— 只是提醒：Palantir 的 Key 要落在主键上；
 * 3. 同一侧把同一个属性映射了两次 —— 只是提醒；
 * 4. 外键式（连接属性留空）两侧条数对不齐 —— 只是提醒，那种写法靠顺序一一对应。
 */
export function relationshipKeyViolations(definition: KeyMappableDefinition): KeyMappingViolation[] {
  const violations: KeyMappingViolation[] = [];
  const byId = new Map(definition.entityTypes.map((entity) => [entity.id, entity]));

  for (const relation of definition.relationshipTypes) {
    const sides = [
      { label: "起始端", entity: byId.get(relation.sourceEntityTypeId ?? ""), rows: keyMappingRows(relation.sourceKeyMappings) },
      { label: "终止端", entity: byId.get(relation.targetEntityTypeId ?? ""), rows: keyMappingRows(relation.targetKeyMappings) },
    ];
    for (const side of sides) {
      if (!side.rows.length) continue;
      const rule = `${relation.name}.${side.label}`;
      if (!side.entity) {
        // 端点本身没选，由 RELATION_ENDPOINT_MISSING 去说；这里重复报只会让人以为是映射写错了。
        continue;
      }
      const known = new Set((side.entity.properties ?? []).map((property) => property.name));
      const primaryKey = new Set(primaryKeyPropertyNames(side.entity));
      const seen = new Set<string>();
      for (const row of side.rows) {
        if (!row.entityProperty) {
          violations.push({ rule, message: `关系类型「${relation.name}」的${side.label}有一条键映射只写了连接属性「${row.linkProperty}」，没选对象类型「${side.entity.name}」上的属性。`, count: 1, severity: "WARN" });
          continue;
        }
        if (!known.has(row.entityProperty)) {
          const available = [...known].slice(0, 5).join("、");
          violations.push({ rule, message: `关系类型「${relation.name}」的${side.label}键映射指向了对象类型「${side.entity.name}」上不存在的属性「${row.entityProperty}」。${available ? `现有属性：${available}。` : "这个对象类型还没有任何属性。"}`, count: 1 });
          continue;
        }
        if (seen.has(row.entityProperty)) {
          violations.push({ rule, message: `关系类型「${relation.name}」的${side.label}把属性「${row.entityProperty}」映射了两次。`, count: 1, severity: "WARN" });
        }
        seen.add(row.entityProperty);
        if (primaryKey.size && !primaryKey.has(row.entityProperty)) {
          violations.push({ rule, message: `关系类型「${relation.name}」的${side.label}把属性「${row.entityProperty}」当键，但它不是对象类型「${side.entity.name}」的主键（主键：${[...primaryKey].join("、")}）。`, count: 1, severity: "WARN" });
        }
      }
    }
    const sourceForeignKeyStyle = sides[0].rows.every((row) => !row.linkProperty);
    const targetForeignKeyStyle = sides[1].rows.every((row) => !row.linkProperty);
    if (sides[0].rows.length && sides[1].rows.length && sourceForeignKeyStyle && targetForeignKeyStyle && sides[0].rows.length !== sides[1].rows.length) {
      violations.push({ rule: `${relation.name}.键映射`, message: `关系类型「${relation.name}」的外键式键映射两侧条数不一样（起始端 ${sides[0].rows.length} 条 / 终止端 ${sides[1].rows.length} 条）；这种写法按顺序一一对应，两边要一样多。`, count: 1, severity: "WARN" });
    }
  }
  return violations;
}
