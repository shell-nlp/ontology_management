import { z } from "zod";
// 别名导入：下面 planBundleImport 的参数也叫 newId（调用方可注入生成器），不能撞名。
import { newId as createId } from "@/lib/ids";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";

/**
 * 本体包（ontology bundle）：把一份本体的**结构**装进一个 JSON 文件，方便传播。
 *
 * 为什么要有它：平台内部的版本快照是一整个目录（`definition.json` + `nodes.csv` +
 * `relationships.csv` + `manifest.json`），id 全是本机的 UUID，换台机器就没意义。
 * 传播需要的是另一种东西 —— 单文件、自描述、id 能跨段引用、并且**不含实例数据**。
 *
 * 第一版只装结构（schema-only），和 bkn-foundry 导出的知识网络一个定位。
 * 实例数据将来要带的话，加一个可选的 `instances` 字段即可，格式版本不用动。
 *
 * 两个刻意的不变量：
 * 1. `definition` 就是平台内部的 `OntologyDefinition`，**原样进出，不做形状转换** ——
 *    这样导出/导入不会出现"两份定义各说各话"。
 * 2. 包里**绝不写凭据**。数据资源只记「连哪儿」（kind / host / port / 库 / 模式），
 *    导入端按这些坐标去匹配本机已登记的资源。
 */

export const BUNDLE_FORMAT = "ontology.bundle";
export const BUNDLE_FORMAT_VERSION = 1;

/** 写进文件的生成者信息。版本与 MCP 服务的 serverInfo 保持一致。 */
export const BUNDLE_GENERATOR = { name: "ontology-management", version: "0.1.0" } as const;

/**
 * 包里的数据资源：只描述连接坐标。
 * `id` 是**导出环境**里的 `data_sources.id`，只作为 `definition` 里引用的还原键；
 * 导入端不看这个 id，只按坐标匹配本机资源。
 */
const bundleDataSourceSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().max(200).default(""),
  /** 导出端已经删掉这条资源时会是空串，导入端只按坐标匹配，不靠 kind 兜底。 */
  kind: z.string().trim().max(32).default(""),
  host: z.string().trim().max(200).default(""),
  port: z.number().int().min(1).max(65535).optional(),
  databaseName: z.string().trim().max(200).default(""),
  schemaName: z.string().trim().max(200).default(""),
});

export const ontologyBundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.number().int().min(1),
  exportedAt: z.string().trim().min(1),
  generator: z.object({ name: z.string().trim().min(1).max(64), version: z.string().trim().max(32).default("") }).optional(),
  ontology: z.object({
    identifier: z.string().trim().max(64).default(""),
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    color: z.string().max(32).default(""),
    tags: z.array(z.string().trim().min(1).max(32)).max(24).default([]),
  }),
  statistics: z
    .object({
      objectTypes: z.number().int().min(0),
      relationTypes: z.number().int().min(0),
      actionTypes: z.number().int().min(0),
      rules: z.number().int().min(0),
      objects: z.number().int().min(0),
      relationships: z.number().int().min(0),
    })
    .optional(),
  dataSources: z.array(bundleDataSourceSchema).default([]),
  definition: ontologyDefinitionSchema,
});

export type OntologyBundle = z.infer<typeof ontologyBundleSchema>;
export type BundleDataSource = z.infer<typeof bundleDataSourceSchema>;

/** 导出端要提供的数据资源形状（结构兼容 DataSourceRecord，不需要引入服务端模块）。 */
export type BundleSourceInput = {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number;
  database_name: string;
  schema_name: string;
};

function usedDataSourceIds(definition: OntologyDefinition) {
  const ids = new Set<string>();
  for (const type of definition.entityTypes) {
    for (const source of type.sources) if (source.dataSourceId) ids.add(source.dataSourceId);
  }
  return [...ids];
}

/** 导出：组装单文件本体包。 */
export function buildOntologyBundle(input: {
  ontology: { identifier: string; name: string; description?: string; color?: string; tags?: string[] };
  definition: OntologyDefinition;
  /** 本机已登记的数据资源，用来把定义里的 id 换成可读的连接坐标。 */
  dataSources?: BundleSourceInput[];
  /** 实例数量；只用于统计信息，不导出实例数据本身。 */
  instances?: { objects?: number; relationships?: number };
  exportedAt?: string;
}): OntologyBundle {
  const { definition } = input;
  const byId = new Map((input.dataSources ?? []).map((item) => [item.id, item]));
  const sources: BundleDataSource[] = usedDataSourceIds(definition).map((id) => {
    const record = byId.get(id);
    if (!record) {
      // 引用了本机已经删掉的数据资源：如实写成一个只有 id 的占位，导入端会提示匹配不上。
      return { id, kind: "", name: "", host: "", databaseName: "", schemaName: "" };
    }
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      host: record.host,
      port: record.port,
      databaseName: record.database_name,
      schemaName: record.schema_name,
    };
  });
  return {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    generator: { ...BUNDLE_GENERATOR },
    ontology: {
      identifier: input.ontology.identifier,
      name: input.ontology.name,
      description: input.ontology.description ?? "",
      color: input.ontology.color ?? "",
      tags: input.ontology.tags ?? [],
    },
    statistics: {
      objectTypes: definition.entityTypes.length,
      relationTypes: definition.relationshipTypes.length,
      actionTypes: definition.actionTypes.length,
      rules: definition.rules.length,
      objects: input.instances?.objects ?? 0,
      relationships: input.instances?.relationships ?? 0,
    },
    dataSources: sources,
    definition,
  };
}

/**
 * 导入第三步：把包里的 id 全部换成新号，并接回本机的数据资源。
 *
 * 为什么要换号：平台里的 id 都是 UUID，直接沿用会和外环境撞车或指向不存在的对象。
 * 换号只发生在**一次遍历**里 —— 先收集包里的全部 id，一次映射，再统一改写引用，
 * 避免"边改边查"造成的漏改。
 */
export type BundleImportPlan = {
  bundle: OntologyBundle;
  /** 可以直接写进草稿的定义：id 已换新，来源绑定已按坐标接回本机。 */
  definition: OntologyDefinition;
  /** 给人看的注意事项：数据资源没匹配上之类。 */
  warnings: string[];
};

/** 本机数据资源的最小形状，用于按连接坐标匹配。 */
export type LocalSourceRef = { id: string; kind: string; host: string; port: number; database_name: string; schema_name: string };

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function sourceLabel(reference: BundleDataSource) {
  if (!reference.kind) return `未知资源（${reference.id}）`;
  const where = [reference.host, reference.port ? `:${reference.port}` : "", reference.databaseName ? `/${reference.databaseName}` : ""].join("");
  return `${reference.kind} ${where}${reference.schemaName ? `（模式 ${reference.schemaName}）` : ""}`;
}

/**
 * 按连接坐标把包里的数据资源接到本机资源上。
 * 先按五项全等匹配；只差模式时放宽一次并给出提醒；还是找不到就把绑定留空。
 */
function mapDataSources(bundle: OntologyBundle, localSources: LocalSourceRef[], warnings: string[]) {
  const map = new Map<string, string>();
  for (const reference of bundle.dataSources) {
    const exact = localSources.find(
      (item) =>
        normalize(item.kind) === normalize(reference.kind) &&
        normalize(item.host) === normalize(reference.host) &&
        Number(item.port) === Number(reference.port) &&
        normalize(item.database_name) === normalize(reference.databaseName) &&
        normalize(item.schema_name) === normalize(reference.schemaName),
    );
    if (exact) {
      map.set(reference.id, exact.id);
      continue;
    }
    const loose = localSources.find(
      (item) =>
        normalize(item.kind) === normalize(reference.kind) &&
        normalize(item.host) === normalize(reference.host) &&
        Number(item.port) === Number(reference.port) &&
        normalize(item.database_name) === normalize(reference.databaseName),
    );
    if (loose) {
      map.set(reference.id, loose.id);
      warnings.push(`数据资源「${sourceLabel(reference)}」按连接坐标匹配到了本机资源，但模式不一致（本机是「${loose.schema_name || "空"}」），请核对类上的来源绑定。`);
      continue;
    }
    map.set(reference.id, "");
    const holders = bundle.definition.entityTypes
      .filter((type) => type.sources.some((source) => source.dataSourceId === reference.id))
      .map((type) => type.name);
    warnings.push(
      `数据资源「${sourceLabel(reference)}」在本机没有登记，${holders.length ? `对象类型「${holders.join("、")}」的` : ""}来源绑定已留空，导入后请重新选表。`,
    );
  }
  return map;
}

/** 收集定义里出现过的全部 id（含接口、端点、动作作用域与规则引用）。 */
function collectDefinitionIds(definition: OntologyDefinition) {
  const ids = new Set<string>();
  // 概念分组与接口的 id 和对象类型共用一套 id 空间：导入时要一起换新，`groupId` / `implements` 才能跟着指对。
  for (const item of definition.interfaces) {
    if (item.id) ids.add(item.id);
    for (const parent of item.extends) if (parent) ids.add(parent);
    for (const constraint of item.linkConstraints) if (constraint.targetId) ids.add(constraint.targetId);
  }
  for (const group of definition.groups) if (group.id) ids.add(group.id);
  for (const type of definition.entityTypes) {
    if (type.id) ids.add(type.id);
    if (type.groupId) ids.add(type.groupId);
    for (const interfaceId of type.implements) if (interfaceId) ids.add(interfaceId);
  }
  for (const relation of definition.relationshipTypes) {
    if (relation.id) ids.add(relation.id);
    if (relation.sourceEntityTypeId) ids.add(relation.sourceEntityTypeId);
    if (relation.targetEntityTypeId) ids.add(relation.targetEntityTypeId);
  }
  for (const action of definition.actionTypes) {
    if (action.id) ids.add(action.id);
    if (action.scopeEntityTypeId) ids.add(action.scopeEntityTypeId);
    for (const param of action.params) if (param.entityTypeId) ids.add(param.entityTypeId);
    for (const edit of action.edits) {
      if (edit.entityTypeId) ids.add(edit.entityTypeId);
      if (edit.relationshipTypeId) ids.add(edit.relationshipTypeId);
    }
  }
  for (const rule of definition.rules) {
    if (rule.id) ids.add(rule.id);
    if (rule.actionId) ids.add(rule.actionId);
    for (const condition of rule.conditions) if (condition.subject.relationshipTypeId) ids.add(condition.subject.relationshipTypeId);
  }
  return [...ids];
}

/** 按映射改写整份定义；没在映射里的引用原样保留（由校验去报"引用了不存在的东西"）。 */
export function relinkDefinitionIds(
  definition: OntologyDefinition,
  idMap: Map<string, string>,
  sourceMap: Map<string, string>,
): OntologyDefinition {
  const id = (value: string) => (value ? idMap.get(value) ?? value : value);
  const source = (value: string) => (value ? sourceMap.get(value) ?? "" : value);
  return {
    groups: definition.groups.map((group) => ({ ...group, id: id(group.id) })),
    interfaces: definition.interfaces.map((item) => ({
      ...item,
      id: id(item.id),
      promotedFromEntityTypeId: item.promotedFromEntityTypeId ? id(item.promotedFromEntityTypeId) : item.promotedFromEntityTypeId,
      extends: item.extends.map(id),
      linkConstraints: item.linkConstraints.map((constraint) => ({ ...constraint, targetId: id(constraint.targetId) })),
    })),
    entityTypes: definition.entityTypes.map((type) => ({
      ...type,
      id: id(type.id),
      groupId: id(type.groupId),
      implements: type.implements.map(id),
      sources: type.sources.map((item) => ({ ...item, dataSourceId: source(item.dataSourceId) })),
    })),
    relationshipTypes: definition.relationshipTypes.map((relation) => ({
      ...relation,
      id: id(relation.id),
      sourceEntityTypeId: id(relation.sourceEntityTypeId),
      targetEntityTypeId: id(relation.targetEntityTypeId),
    })),
    actionTypes: definition.actionTypes.map((action) => ({
      ...action,
      id: id(action.id),
      scopeEntityTypeId: id(action.scopeEntityTypeId),
      params: action.params.map((param) => ({ ...param, entityTypeId: id(param.entityTypeId) })),
      edits: action.edits.map((edit) => ({ ...edit, entityTypeId: id(edit.entityTypeId), relationshipTypeId: id(edit.relationshipTypeId) })),
    })),
    rules: definition.rules.map((rule) => ({
      ...rule,
      id: id(rule.id),
      actionId: id(rule.actionId),
      conditions: rule.conditions.map((condition) => ({
        ...condition,
        subject: { ...condition.subject, relationshipTypeId: id(condition.subject.relationshipTypeId) },
      })),
    })),
  };
}

/** 校验 z 的报错，翻成一句能直接显示给用户的说明。 */
function describeBundleIssues(issues: z.ZodIssue[]) {
  const first = issues[0];
  if (!first) return "本体包格式不对。";
  const path = first.path.join(".");
  const where = path ? `字段 ${path}：` : "";
  return `本体包格式不对 —— ${where}${first.message}。`;
}

/** 导入第一步：解析文件文本并校验。报错说清楚是"不是本体包"还是"字段不合法"。 */
export function parseOntologyBundle(text: string): OntologyBundle {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("文件是空的。");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error("这个文件不是合法 JSON，确认一下是不是选错了文件。");
  }
  return readOntologyBundle(raw);
}

export function readOntologyBundle(raw: unknown): OntologyBundle {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("本体包应该是一个 JSON 对象。");
  const record = raw as Record<string, unknown>;
  if (record.format !== BUNDLE_FORMAT) {
    throw new Error(`这不是本体包：format 应该是「${BUNDLE_FORMAT}」，实际是「${String(record.format ?? "空")}」。`);
  }
  const version = Number(record.formatVersion);
  if (!Number.isInteger(version) || version < 1) throw new Error("本体包缺少 formatVersion。");
  if (version > BUNDLE_FORMAT_VERSION) {
    throw new Error(`这个本体包是更新版本导出的（v${version}），当前平台只认到 v${BUNDLE_FORMAT_VERSION}。请升级平台后再导入。`);
  }
  const parsed = ontologyBundleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(describeBundleIssues(parsed.error.issues));
  return parsed.data;
}

/** 导入第二步：换 id + 接回本机数据资源。 */
export function planBundleImport(
  bundle: OntologyBundle,
  localSources: LocalSourceRef[],
  newId: () => string = () => createId(),
): BundleImportPlan {
  const warnings: string[] = [];
  const sourceMap = mapDataSources(bundle, localSources, warnings);
  const idMap = new Map(collectDefinitionIds(bundle.definition).map((old) => [old, newId()]));
  const definition = relinkDefinitionIds(bundle.definition, idMap, sourceMap);
  return { bundle, definition, warnings };
}

/** 下载用的文件名：优先用标识，退回名字，再退回 id。 */
export function bundleFileName(ontology: { identifier?: string; name: string }) {
  const base = (ontology.identifier || ontology.name || "ontology")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `${base || "ontology"}.ontology.json`;
}
