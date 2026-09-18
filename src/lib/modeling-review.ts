/**
 * 建模体检：本体定义的**质量规则**，和「发布前校验」是两件事。
 *
 * - 发布前校验（`validateVersionSnapshot`）管"能不能发布"：来源绑定、端点契约、唯一值冲突、
 *   接口实现、动作定义。拦不住的都算 bug。
 * - 这一层管"建得好不好"：空壳对象类型、孤悬类型、主键接不上列、命名打架、接口没人实现……
 *   这些**都不阻断发布** —— 很多是刻意停下来的中间状态，但留着会让本体在应用里不好用。
 *
 * 规则分两档：`WARN` = 该改（影响可用性或一致性）；`INFO` = 可以更好（可选优化）。
 * **规则码（code）是稳定标识**：界面、MCP 工具、技能文档都引用它，改规则时不要改码。
 *
 * 这里是纯函数：不读盘、不连库。所以"对象类型绑的那张表里到底有没有这一列"查不了 ——
 * 那要拿真实表结构去比，属于「数据资源」那侧的活；本模块只保证**定义内部**自洽。
 */

/** 体检结论的档次。发布前校验那层才是阻断的，这里两级都不拦。 */
export type ReviewLevel = "WARN" | "INFO";

/** 结论落在哪一类主体上：界面按它决定"点进去看哪一页"。 */
export type ReviewScope = "ONTOLOGY" | "OBJECT_TYPE" | "RELATION_TYPE" | "INTERFACE" | "GROUP" | "ACTION" | "RULE";

/** 主体分类给人看的名字：界面、MCP 工具、技能文档共用这一份，别各写各的。 */
export const REVIEW_SCOPE_LABELS: Record<ReviewScope, string> = {
  ONTOLOGY: "本体",
  OBJECT_TYPE: "对象类型",
  RELATION_TYPE: "关系类型",
  INTERFACE: "接口",
  GROUP: "概念分组",
  ACTION: "动作",
  RULE: "规则",
};

export type ModelingFinding = {
  /** 稳定规则码，例如 `ENTITY_ORPHAN`。 */
  code: string;
  level: ReviewLevel;
  scope: ReviewScope;
  /** 主体名称（界面上显示、也用来在清单里找）；本体级结论留空。 */
  subject: string;
  /** 主体 id，界面用它定位；本体级结论留空。 */
  subjectId: string;
  /** 一句话说清"哪里不对"。 */
  message: string;
  /** 怎么改。 */
  hint: string;
};

/*
 * 入参用结构类型而不是 `OntologyDefinition`：规则只关心这几个字段，
 * 这样单测可以直接摆一个最小对象，不必先过一遍 zod（和 interfaces.ts 的做法一致）。
 */
export type ReviewableProperty = {
  name: string;
  displayName?: string;
  description?: string;
  dataType: string;
  required?: boolean;
  unique?: boolean;
  indexed?: boolean;
  sourceField?: string;
  sourceId?: string;
};

export type ReviewableSource = {
  id: string;
  dataSourceId?: string;
  schema?: string;
  view?: string;
  primaryKey?: readonly string[];
  titleField?: string;
};

export type ReviewableEntityType = {
  id: string;
  name: string;
  description?: string;
  displayProperty?: string;
  groupId?: string;
  implements?: readonly string[];
  properties?: readonly ReviewableProperty[];
  sources?: readonly ReviewableSource[];
};

export type ReviewableRelationshipType = {
  id: string;
  name: string;
  description?: string;
  sourceEntityTypeId?: string;
  targetEntityTypeId?: string;
  properties?: readonly ReviewableProperty[];
};

export type ReviewableInterface = {
  id: string;
  name: string;
  description?: string;
  properties?: readonly ReviewableProperty[];
  extends?: readonly string[];
  linkConstraints?: readonly { name?: string; required?: boolean }[];
};

export type ReviewableGroup = { id: string; name: string; color?: string };

export type ReviewableAction = {
  id: string;
  name: string;
  code?: string;
  description?: string;
  scopeEntityTypeId?: string;
  edits?: readonly unknown[];
};

export type ReviewableRule = {
  id: string;
  name: string;
  effect?: string;
  enabled?: boolean;
  actionId?: string;
  conditions?: readonly unknown[];
  message?: string;
};

export type ReviewableDefinition = {
  groups?: readonly ReviewableGroup[];
  interfaces?: readonly ReviewableInterface[];
  entityTypes: readonly ReviewableEntityType[];
  relationshipTypes: readonly ReviewableRelationshipType[];
  actionTypes?: readonly ReviewableAction[];
  rules?: readonly ReviewableRule[];
};

/** 名称归一：比"重名"时忽略大小写与空白。 */
function key(name: string) {
  return name.trim().toLowerCase().replace(/\s+/g, "");
}

function finding(
  code: string,
  level: ReviewLevel,
  scope: ReviewScope,
  subject: { name: string; id: string } | null,
  message: string,
  hint: string,
): ModelingFinding {
  return { code, level, scope, subject: subject?.name ?? "", subjectId: subject?.id ?? "", message, hint };
}

/** 真正接上库的来源：数据资源与表/视图都填了才算。半填的由发布前校验去管。 */
function boundSources(entity: ReviewableEntityType) {
  return (entity.sources ?? []).filter((source) => Boolean(source.dataSourceId && source.view));
}

/** 属性映射到的那一列（没有映射就是空串）。 */
function mappedField(property: ReviewableProperty) {
  return (property.sourceField ?? "").trim();
}

/**
 * 命名的"写法"分类，只用于"风格是不是混着来"这一条。
 * 分不出（比如纯数字、符号）就返回 null，不参与统计。
 */
function namingStyle(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (/^[\u4e00-\u9fa5]+$/.test(trimmed)) return "中文";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(trimmed)) return "小写下划线";
  if (/^[a-z][a-z0-9]*$/.test(trimmed)) return "小写单词";
  if (/^[A-Z][A-Za-z0-9]*$/.test(trimmed)) return "大驼峰";
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(trimmed)) return "小驼峰";
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(trimmed)) return "大写下划线";
  if (/\s/.test(trimmed)) return "含空格";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return "中英混排";
  return null;
}

/** 同一批名字里有没有"忽略大小写与空白之后撞车"的。 */
function duplicateNames<T extends { name: string }>(items: readonly T[]) {
  const buckets = new Map<string, T[]>();
  for (const item of items) buckets.set(key(item.name), [...(buckets.get(key(item.name)) ?? []), item]);
  return [...buckets.values()].filter((bucket) => bucket.length > 1);
}

/** 对象类型：一个属性都没有。 */
function reviewEntityEmptiness(model: ReviewableDefinition): ModelingFinding[] {
  return model.entityTypes
    .filter((entity) => (entity.properties ?? []).length === 0)
    .map((entity) => finding(
      "ENTITY_NO_PROPERTIES", "WARN", "OBJECT_TYPE", entity,
      `对象类型「${entity.name}」一个属性都没有，既描述不了业务，也没法绑数据。`,
      "至少补上主键与标题两个属性，再考虑绑表；确实只是占位的先删掉。",
    ));
}

/** 对象类型：展示属性没设、或指向了不存在的属性。 */
function reviewDisplayProperty(model: ReviewableDefinition): ModelingFinding[] {
  const findings: ModelingFinding[] = [];
  for (const entity of model.entityTypes) {
    const properties = entity.properties ?? [];
    const display = (entity.displayProperty ?? "").trim();
    if (!display) {
      // 没有属性时上面已经报过"空壳"，这里不重复说。
      if (!properties.length) continue;
      findings.push(finding(
        "ENTITY_NO_DISPLAY_PROPERTY", "INFO", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」没有指定展示属性。`,
        "不指定的话，图谱节点、下拉框、搜索候选里只能用主键值当标题，读起来是编号而不是名字。",
      ));
      continue;
    }
    if (!properties.some((property) => property.name === display)) {
      findings.push(finding(
        "ENTITY_DISPLAY_PROPERTY_MISSING", "WARN", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」的展示属性「${display}」不在它的属性里。`,
        "把展示属性改成真实存在的属性名（通常是「名称」「标题」这一类），否则界面上取不到标题。",
      ));
    }
  }
  return findings;
}

/** 对象类型：孤悬 —— 没有数据来源、不参与任何关系类型、也没有动作作用在它身上。 */
function reviewOrphans(model: ReviewableDefinition): ModelingFinding[] {
  const linked = new Set<string>();
  for (const relation of model.relationshipTypes) {
    if (relation.sourceEntityTypeId) linked.add(relation.sourceEntityTypeId);
    if (relation.targetEntityTypeId) linked.add(relation.targetEntityTypeId);
  }
  for (const action of model.actionTypes ?? []) if (action.scopeEntityTypeId) linked.add(action.scopeEntityTypeId);
  return model.entityTypes
    .filter((entity) => !boundSources(entity).length && !linked.has(entity.id))
    .map((entity) => finding(
      "ENTITY_ORPHAN", "WARN", "OBJECT_TYPE", entity,
      `对象类型「${entity.name}」是孤悬的：没绑数据、不连任何关系类型、也没有动作作用在它身上。`,
      "要么把它接进网络（补一条关系类型或数据来源），要么删掉 —— 孤悬类型在应用里查不到、也走不通。",
    ));
}

/** 对象类型：绑了来源，但主键列 / 必填属性接不上属性。 */
function reviewSourceMapping(model: ReviewableDefinition): ModelingFinding[] {
  const findings: ModelingFinding[] = [];
  for (const entity of model.entityTypes) {
    const properties = entity.properties ?? [];
    const bound = boundSources(entity);
    if (!bound.length) continue;
    const mapped = new Set(properties.map(mappedField).filter(Boolean));

    if (!properties.some(mappedField)) {
      findings.push(finding(
        "ENTITY_SOURCE_UNMAPPED", "WARN", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」绑了表，但没有任何属性映射到列上。`,
        "在属性的「映射列」里填上源表列名；一个都没填的话，实例化出来的对象全是空值。",
      ));
      continue;
    }

    const primary = bound[0];
    const unmappedKeys = (primary.primaryKey ?? []).filter((column) => !mapped.has(column));
    if (unmappedKeys.length) {
      findings.push(finding(
        "ENTITY_PRIMARY_KEY_UNMAPPED", "WARN", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」的主键列「${unmappedKeys.join("、")}」没有属性映射过去。`,
        "对象身份取的是主键列，没有属性接住它，对象就既读不出主键、也连不上补充来源。",
      ));
    }

    const unmappedRequired = properties.filter((property) => property.required && !mappedField(property));
    if (unmappedRequired.length) {
      findings.push(finding(
        "ENTITY_REQUIRED_PROPERTY_UNMAPPED", "WARN", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」的必填属性「${unmappedRequired.map((property) => property.name).join("、")}」没有映射列。`,
        "必填属性在写入时会被校验，取不到值就写不进去：要么补映射列，要么取消必填。",
      ));
    }
  }
  return findings;
}

/** 对象类型 / 关系类型 / 分组：名称撞车、命名风格混着来。 */
function reviewNaming(model: ReviewableDefinition): ModelingFinding[] {
  const findings: ModelingFinding[] = [];
  const scopes: { scope: ReviewScope; label: string; items: readonly { id: string; name: string }[] }[] = [
    { scope: "OBJECT_TYPE", label: "对象类型", items: model.entityTypes },
    { scope: "RELATION_TYPE", label: "关系类型", items: model.relationshipTypes },
    { scope: "GROUP", label: "概念分组", items: model.groups ?? [] },
  ];
  for (const { scope, label, items } of scopes) {
    for (const bucket of duplicateNames(items)) {
      for (const item of bucket) {
        findings.push(finding(
          `${scope === "OBJECT_TYPE" ? "ENTITY" : scope === "RELATION_TYPE" ? "RELATION" : "GROUP"}_DUPLICATE_NAME`,
          "WARN", scope, item,
          `${label}「${item.name}」和 ${bucket.length - 1} 个同类定义重名（只是大小写或空格不同）。`,
          "名称是推理与工具调用时的唯一入口，重名会让模型和用户都分不清指的是哪一个，改成一个更有区分度的名字。",
        ));
      }
    }
  }

  const styles = new Map<string, string[]>();
  for (const entity of model.entityTypes) {
    const style = namingStyle(entity.name);
    if (style) styles.set(style, [...(styles.get(style) ?? []), entity.name]);
  }
  // 名字太少时"混着来"没有意义，不报。
  if (styles.size > 1 && model.entityTypes.length >= 4) {
    const detail = [...styles].map(([style, names]) => `${style}（${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}）`).join("；");
    findings.push(finding(
      "NAMING_MIXED_STYLE", "INFO", "ONTOLOGY", null,
      `对象类型的命名风格不统一：${detail}。`,
      "统一成一种写法（例如全用中文业务名）后，模型检索与人工评审都更稳。",
    ));
  }
  return findings;
}

/** 同一个属性名在不同对象类型里类型不一致 —— 同一个业务概念被写成了两种类型。 */
function reviewPropertyTypeConflicts(model: ReviewableDefinition): ModelingFinding[] {
  const byName = new Map<string, { name: string; types: Map<string, string[]> }>();
  for (const entity of model.entityTypes) {
    for (const property of entity.properties ?? []) {
      const entry = byName.get(key(property.name)) ?? { name: property.name, types: new Map<string, string[]>() };
      entry.types.set(property.dataType, [...(entry.types.get(property.dataType) ?? []), entity.name]);
      byName.set(key(property.name), entry);
    }
  }
  const findings: ModelingFinding[] = [];
  for (const entry of byName.values()) {
    if (entry.types.size < 2) continue;
    const detail = [...entry.types]
      .map(([dataType, entities]) => `${dataType}（${[...new Set(entities)].slice(0, 3).join("、")}）`)
      .join(" / ");
    findings.push(finding(
      "PROPERTY_TYPE_CONFLICT", "INFO", "ONTOLOGY", null,
      `属性「${entry.name}」在不同对象类型里类型不一致：${detail}。`,
      "同一个业务概念（例如「统计日期」）在不同类型里应当是同一个类型，否则跨类型比较、排序、做接口实现时会对不上。",
    ));
  }
  return findings;
}

/** 关系类型：端点没选、自环、同一对端点重复、没有描述、名字和对象类型撞车。 */
function reviewRelationships(model: ReviewableDefinition): ModelingFinding[] {
  const findings: ModelingFinding[] = [];
  const entityNames = new Map(model.entityTypes.map((entity) => [key(entity.name), entity.name]));
  const byPair = new Map<string, ReviewableRelationshipType[]>();

  for (const relation of model.relationshipTypes) {
    const source = (relation.sourceEntityTypeId ?? "").trim();
    const target = (relation.targetEntityTypeId ?? "").trim();
    if (!source || !target) {
      findings.push(finding(
        "RELATION_ENDPOINT_MISSING", "WARN", "RELATION_TYPE", relation,
        `关系类型「${relation.name}」的${!source && !target ? "起点和终点" : !source ? "起点" : "终点"}还没选对象类型。`,
        "关系类型必须连两个对象类型，端点空着的话这条关系既画不出来也用不了。",
      ));
    } else if (source === target) {
      findings.push(finding(
        "RELATION_SELF_LOOP", "INFO", "RELATION_TYPE", relation,
        `关系类型「${relation.name}」的起点和终点是同一个对象类型（自环）。`,
        "层级、转派、推荐这类语义确实需要自环；如果只是选错了端点，现在改掉。",
      ));
    }
    if (source && target) {
      const pairKey = [source, target].sort().join("|");
      byPair.set(pairKey, [...(byPair.get(pairKey) ?? []), relation]);
    }
    if (!(relation.description ?? "").trim()) {
      findings.push(finding(
        "RELATION_NO_DESCRIPTION", "INFO", "RELATION_TYPE", relation,
        `关系类型「${relation.name}」没有写说明。`,
        "写清业务含义（谁对谁、什么条件下成立），模型在推理时才不会把方向用反。",
      ));
    }
    if (entityNames.has(key(relation.name))) {
      findings.push(finding(
        "RELATION_NAME_COLLIDES", "INFO", "RELATION_TYPE", relation,
        `关系类型「${relation.name}」和一个对象类型同名。`,
        "同名的类型和关系在检索结果里会长得一样，容易选错；关系类型建议写成动词短语（如「属于」「负责」）。",
      ));
    }
  }

  for (const bucket of byPair.values()) {
    if (bucket.length < 2) continue;
    for (const relation of bucket) {
      findings.push(finding(
        "RELATION_DUPLICATE_PAIR", "INFO", "RELATION_TYPE", relation,
        `同一对对象类型之间有 ${bucket.length} 条关系类型：${bucket.map((item) => `「${item.name}」`).join("、")}。`,
        "如果它们表达的是同一件事，合并成一条（用属性区分差别）；确实是两件事就把说明写清。",
      ));
    }
  }
  return findings;
}

/** 接口：空契约、没人实现也没人继承。 */
function reviewInterfaces(model: ReviewableDefinition): ModelingFinding[] {
  const interfaces = model.interfaces ?? [];
  const findings: ModelingFinding[] = [];
  const implemented = new Set<string>();
  for (const entity of model.entityTypes) for (const id of entity.implements ?? []) implemented.add(id);
  const extended = new Set<string>();
  for (const item of interfaces) for (const id of item.extends ?? []) extended.add(id);

  for (const item of interfaces) {
    const properties = item.properties ?? [];
    const constraints = item.linkConstraints ?? [];
    if (!properties.length && !constraints.length) {
      findings.push(finding(
        "INTERFACE_EMPTY", "WARN", "INTERFACE", item,
        `接口「${item.name}」既没有属性也没有关系约束，是个空契约。`,
        "接口的价值就是「实现我的对象类型必须长什么样」：补上属性或关系约束，否则谁实现它都没有约束力。",
      ));
    }
    if (!implemented.has(item.id) && !extended.has(item.id)) {
      findings.push(finding(
        "INTERFACE_UNUSED", "INFO", "INTERFACE", item,
        `接口「${item.name}」没有任何对象类型实现、也没有被别的接口继承。`,
        "没人用的接口只是负担；要么让相关对象类型实现它，要么删掉。",
      ));
    }
  }
  return findings;
}

/** 概念分组：空分组、对象类型指向不存在的分组。 */
function reviewGroups(model: ReviewableDefinition): ModelingFinding[] {
  const groups = model.groups ?? [];
  const findings: ModelingFinding[] = [];
  const memberCount = new Map<string, number>();
  for (const entity of model.entityTypes) {
    const groupId = (entity.groupId ?? "").trim();
    if (!groupId) continue;
    memberCount.set(groupId, (memberCount.get(groupId) ?? 0) + 1);
  }
  for (const group of groups) {
    if (!memberCount.get(group.id)) {
      findings.push(finding(
        "GROUP_EMPTY", "INFO", "GROUP", group,
        `概念分组「${group.name}」下面还没有对象类型。`,
        "空分组在图谱里会画出一个空框；把成员归进来，或者先删掉这个分组。",
      ));
    }
  }
  const known = new Set(groups.map((group) => group.id));
  for (const entity of model.entityTypes) {
    const groupId = (entity.groupId ?? "").trim();
    if (groupId && !known.has(groupId)) {
      findings.push(finding(
        "ENTITY_GROUP_MISSING", "WARN", "OBJECT_TYPE", entity,
        `对象类型「${entity.name}」指向了一个不存在的概念分组。`,
        "分组被删过或草稿被合并过会这样：重新给它选一个分组，否则它在「按分组」视图里会掉队。",
      ));
    }
  }
  return findings;
}

/** 动作与规则：空动作、code 撞车、规则没条件 / 没提示语 / 指向不存在的动作。 */
function reviewActionsAndRules(model: ReviewableDefinition): ModelingFinding[] {
  const findings: ModelingFinding[] = [];
  const actions = model.actionTypes ?? [];
  const rules = model.rules ?? [];
  const actionIds = new Set(actions.map((action) => action.id));

  const byCode = new Map<string, ReviewableAction[]>();
  for (const action of actions) {
    const code = (action.code ?? "").trim();
    if (code) byCode.set(key(code), [...(byCode.get(key(code)) ?? []), action]);
  }
  for (const bucket of byCode.values()) {
    if (bucket.length < 2) continue;
    for (const action of bucket) {
      findings.push(finding(
        "ACTION_DUPLICATE_CODE", "WARN", "ACTION", action,
        `动作「${action.name}」的标识「${action.code}」和别的动作重复。`,
        "标识是动作对外暴露的工具名，重复会让调用方选错；改成互不相同的机器名。",
      ));
    }
  }

  for (const action of actions) {
    if (!(action.edits ?? []).length) {
      findings.push(finding(
        "ACTION_WITHOUT_EDIT", "INFO", "ACTION", action,
        `动作「${action.name}」没有任何写操作。`,
        "没有写操作的动作执行完什么都不会变；如果它只是查询，应该做成对象类型上的展示，而不是动作。",
      ));
    }
    if (!(action.description ?? "").trim()) {
      findings.push(finding(
        "ACTION_NO_DESCRIPTION", "INFO", "ACTION", action,
        `动作「${action.name}」没有写说明。`,
        "说明是给人也是给模型看的：写清「这个动作解决什么业务问题、有什么后果」。",
      ));
    }
  }

  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!(rule.conditions ?? []).length) {
      findings.push(finding(
        "RULE_WITHOUT_CONDITION", "WARN", "RULE", rule,
        `规则「${rule.name}」没有任何条件，会对所有对象无条件生效。`,
        "无条件生效通常是漏配：补上条件，或者明确写成「整体闸门」并在说明里写清。",
      ));
    }
    if ((rule.effect === "BLOCK" || rule.effect === "WARN") && !(rule.message ?? "").trim()) {
      findings.push(finding(
        "RULE_EMPTY_MESSAGE", "WARN", "RULE", rule,
        `规则「${rule.name}」拦人或提示时没有给用户看的原因。`,
        "用户只会看到一句「操作被拒绝」，不知道改哪里；把原因写进规则提示语。",
      ));
    }
    const actionId = (rule.actionId ?? "").trim();
    if (actionId && !actionIds.has(actionId)) {
      findings.push(finding(
        "RULE_ACTION_MISSING", "WARN", "RULE", rule,
        `规则「${rule.name}」绑定的动作已经不在本体里了。`,
        "重新选一个动作，或者改成对所有动作生效（清空绑定）。",
      ));
    }
  }
  return findings;
}

/** 全部规则，按"先说对象类型、再说关系类型"的顺序跑，输出顺序稳定。 */
const RULES: ((model: ReviewableDefinition) => ModelingFinding[])[] = [
  reviewEntityEmptiness,
  reviewDisplayProperty,
  reviewSourceMapping,
  reviewOrphans,
  reviewNaming,
  reviewPropertyTypeConflicts,
  reviewRelationships,
  reviewInterfaces,
  reviewGroups,
  reviewActionsAndRules,
];

export function reviewOntologyModel(model: ReviewableDefinition): ModelingFinding[] {
  return RULES.flatMap((rule) => rule(model));
}

export type ModelingReviewSummary = {
  total: number;
  warn: number;
  info: number;
  /** 按主体分类的条数，界面用来做分组标题。 */
  byScope: { scope: ReviewScope; count: number }[];
  /** 一句可以直接显示/交给模型的话。 */
  headline: string;
};

export function summarizeModelingReview(findings: readonly ModelingFinding[]): ModelingReviewSummary {
  const warn = findings.filter((item) => item.level === "WARN").length;
  const info = findings.length - warn;
  const counts = new Map<ReviewScope, number>();
  for (const item of findings) counts.set(item.scope, (counts.get(item.scope) ?? 0) + 1);
  return {
    total: findings.length,
    warn,
    info,
    byScope: [...counts].map(([scope, count]) => ({ scope, count })),
    headline: findings.length
      ? `建模体检：${warn} 项该改、${info} 项可选优化。`
      : "建模体检：没有发现问题。",
  };
}