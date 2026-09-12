import type { EntitySource } from "@/lib/ontology";

/**
 * 数据来源绑定的共享逻辑：一个类可以挂多份表，按主键合并属性
 * （Palantir 的 column-wise MDO，见 @/lib/ontology 里的来源 schema）。
 *
 * 这里刻意不引入 zod：定义的形状在 @/lib/ontology 里声明，本文件只放纯函数，
 * 服务端（发布前检查）和浏览器（编辑面板）用同一份判断，两边不会各说各话。
 */

/** 加多来源之前的老字段折成主来源时用的固定 id，保证每次读出来都一样。 */
export const LEGACY_PRIMARY_SOURCE_ID = "primary";

/** 加多来源之前的形状：一个类只有一份来源，没有 id。 */
export type LegacyEntitySource = Omit<EntitySource, "id">;

/**
 * 读一个类的来源清单：老的 `source` 折成主来源，得到的永远是同一种形状。
 * 服务端读快照时已经归一过（见 @/lib/ontology 的 transform），这里是兜底。
 */
export function entitySources(entity: { sources?: EntitySource[]; source?: LegacyEntitySource } | null | undefined): EntitySource[] {
  if (!entity) return [];
  if (entity.sources?.length) return entity.sources;
  const legacy = entity.source;
  if (!legacy) return [];
  const bound = Boolean(legacy.dataSourceId || legacy.view || legacy.primaryKey?.length || legacy.titleField);
  return bound ? [{ ...legacy, id: LEGACY_PRIMARY_SOURCE_ID, primaryKey: legacy.primaryKey ?? [] }] : [];
}

export function newEntitySourceId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `source-${Math.random().toString(36).slice(2, 10)}`;
}

/** 界面上怎么称呼一份来源：有表名就用表名，没有就老实说没选。 */
export function sourceName(source: Pick<EntitySource, "view"> | null | undefined) {
  return source?.view?.trim() || "未选表";
}

/**
 * 一份来源的「表身份」：换资源或换表之后，之前读到的那份字段清单就不再算数，
 * 界面靠这个 key 判断缓存还对不对得上。
 */
export function sourceFieldsKey(source: Pick<EntitySource, "dataSourceId" | "view">) {
  return `${source.dataSourceId}|${source.view.trim()}`;
}

/** 主来源 / 补充来源在各处的叫法：0 是主来源，其余按序号排。 */
export function sourceRoleLabel(index: number) {
  return index === 0 ? "主来源" : `补充来源 ${index}`;
}

/**
 * 一条绑定问题。`severity: "WARN"` 是「还没配完，不挡发布」；
 * 不带 severity 的是自相矛盾的配置（连接键对不上之类），会挡住发布。
 */
export type SourceViolation = { rule: string; message: string; count: number; severity?: "WARN" };

/** 判断只看这几项：类叫什么、挂了几份来源、属性映射到哪份来源。 */
export type SourceScope = {
  name: string;
  sources?: EntitySource[];
  properties?: { name: string; sourceId?: string; sourceField?: string }[];
};

function isBlank(source: EntitySource) {
  return !source.dataSourceId && !source.view;
}

/** 连接键只看填了值的列，空占位不算。 */
function mappedKeys(source: EntitySource) {
  return source.primaryKey.filter((column) => column?.trim()).length;
}

/**
 * 来源绑定的自检：编辑面板保存前和发布前检查共用这一套判断。
 *
 * 拦下来的只有「自己跟自己矛盾」的配置：补充来源选了表却没有连接键、
 * 连接键列数和主键列数对不上、属性指向一份已经不存在的来源。
 * 「还没填完」（没选表、没指定主键）只提示不拦——平台现在不从绑定取数，
 * 建模阶段允许先把结构搭起来。
 */
export function validateEntitySources(scope: SourceScope): SourceViolation[] {
  const sources = scope.sources ?? [];
  const properties = scope.properties ?? [];
  if (!sources.length) {
    return properties.filter((property) => property.sourceField).map((property) => ({
      rule: `${scope.name}.${property.name}`,
      message: `属性「${property.name}」映射了数据列，但类「${scope.name}」还没有数据来源，这个映射落不了地。`,
      count: 1,
      severity: "WARN" as const,
    }));
  }

  const violations: SourceViolation[] = [];
  const primary = sources[0];
  if (isBlank(primary)) {
    violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的主来源还没选表 / 视图。`, count: 1, severity: "WARN" });
  } else if (!primary.primaryKey.length) {
    violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的主来源还没指定主键列，对象的身份还没定下来。`, count: 1, severity: "WARN" });
  }

  sources.slice(1).forEach((source, offset) => {
    const label = sourceRoleLabel(offset + 1);
    if (isBlank(source)) {
      violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的${label} 还没选表 / 视图。`, count: 1, severity: "WARN" });
      return;
    }
    if (!source.dataSourceId || !source.view) {
      violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的${label} 只填了一半：数据资源和表 / 视图都要选。`, count: 1 });
      return;
    }
    const keys = mappedKeys(source);
    if (!keys) {
      violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的${label} 还没指定连接键：这张表里哪几列对应对象主键。`, count: 1 });
    } else if (primary.primaryKey.length && keys !== primary.primaryKey.length) {
      violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」的${label} 填了 ${keys} 个连接键，主键有 ${primary.primaryKey.length} 列，两边要对齐。`, count: 1 });
    }
  });

  const seen = new Map<string, number>();
  sources.forEach((source, index) => {
    if (isBlank(source) || !source.view) return;
    const key = `${source.dataSourceId}|${source.schema}|${source.view}`;
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, index); return; }
    violations.push({ rule: `${scope.name}.sources`, message: `类「${scope.name}」把同一张表 ${source.view} 挂了两次（${sourceRoleLabel(first)}、${sourceRoleLabel(index)}）。`, count: 1, severity: "WARN" });
  });

  const known = new Set(sources.map((source) => source.id));
  for (const property of properties) {
    if (property.sourceId && !known.has(property.sourceId)) {
      violations.push({ rule: `${scope.name}.${property.name}`, message: `属性「${property.name}」映射的来源已不在类「${scope.name}」上，请重新指定。`, count: 1 });
    }
  }
  return violations;
}
