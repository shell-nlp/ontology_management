import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { getGraphStore, type GraphData, type GraphTarget } from "@/lib/framework/graph";
import { withAdvisoryLock } from "@/lib/platform/platform-db";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { validateEntitySources } from "@/lib/ontology/sources";
import { relationshipKeyViolations } from "@/lib/ontology/relationship-keys";
import { linkSourceViolations } from "@/lib/ontology/link-source";
import { metricViolations } from "@/lib/ontology/metrics";
import { validateInterfaceImplementations, validateInterfaces } from "@/lib/ontology/interfaces";
import {
  deleteTargetVersionRecords,
  deleteVersionRecordRow,
  getVersionRecordRow,
  insertVersionRecordRow,
  isVersionStatus,
  listVersionRecordRows,
  replaceVersionConcepts,
  updateVersionRecordRow,
  type VersionRecord,
  type VersionRecordRow,
  type VersionStatus,
} from "@/lib/platform/version-records";
import { ActionBlockedError, runAction, validateActionDefinition, visibleActions, type ActionOutcome, type ActionRunInput, type ActionVisibility } from "@/lib/instance/action-engine";
import { parsePropertyValues } from "@/lib/instance/instance-property-editor";
import { objectIdOf, primaryKeyConflicts, resolveObjectIdentity } from "@/lib/instance/object-identity";
import type { EntityRecord, RelationshipRecord, RuntimeTypeSet } from "@/lib/framework/graph/types";

export type { VersionRecord, VersionStatus } from "@/lib/platform/version-records";

/**
 * 本体版本与快照 —— 2026-10-10 起**数据全在平台库**。
 *
 * 以前版本记录与定义落在磁盘 .data/ontology-versions/<targetId>/<versionId>/；
 * 现在 ontology_platform.ontology_versions 一行装下定义 + 元数据 + **实例快照**
 * （nodes / relationships 一个 jsonb），磁盘上不再有本体数据。用户口径：
 * 「本体定义不要存到磁盘，要存到 PG 数据库中」「实现完成和迁移后记得把磁盘原有的删除掉」。
 *
 * 这个文件只管**领域编排**：zod 校验、内容哈希、锁、发布/草稿变更、动作与位置；
 * 表读写全在 @/lib/platform/version-records，路径与老文件只出现在下面的迁移函数里。
 */
const INTERNAL_ID = "__ontology_id";
const INTERNAL_VERSION_ID = "__ontology_version_id";
const SNAPSHOT_FORMAT = 1;
const VERSION_SEGMENT = /^[0-9a-f-]{36}$/i;

const nodeSchema = z.object({
  id: z.string().uuid(),
  labels: z.array(z.string().min(1)).min(1),
  properties: z.record(z.string(), z.unknown()),
});

const relationshipSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  type: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});

export type SnapshotNode = z.infer<typeof nodeSchema>;
export type SnapshotRelationship = z.infer<typeof relationshipSchema>;
export type VersionSnapshot = {
  definition: OntologyDefinition;
  nodes: SnapshotNode[];
  relationships: SnapshotRelationship[];
};

/** 老磁盘版 manifest.json 的形状：只用于**入迁**，不再写回磁盘。 */
type LegacyManifest = {
  formatVersion: number;
  versionId: string;
  targetId: string;
  versionNumber: number;
  status: VersionStatus;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  entityCount: number;
  relationshipCount: number;
  contentHash: string;
  updatedAt: string;
};

const locks = new Map<string, Promise<void>>();
const targetLocks = new Map<string, Promise<void>>();

/** 历史版本的落点（只读）：.data/ontology-versions，可用 ONTOLOGY_VERSION_DIR 覆盖。 */
function snapshotRoot() {
  const configured = process.env.ONTOLOGY_VERSION_DIR;
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  return path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "ontology-versions");
}

function safeSegment(value: string) {
  if (!VERSION_SEGMENT.test(value)) throw new Error("版本快照标识不合法。");
  return value;
}

export function versionArtifactDirectory(targetId: string, versionId: string) {
  return path.join(/*turbopackIgnore: true*/ snapshotRoot(), safeSegment(targetId), safeSegment(versionId));
}

function legacyArtifactFiles(directory: string) {
  return {
    definition: path.join(/*turbopackIgnore: true*/ directory, "definition.json"),
    nodes: path.join(/*turbopackIgnore: true*/ directory, "nodes.csv"),
    relationships: path.join(/*turbopackIgnore: true*/ directory, "relationships.csv"),
    manifest: path.join(/*turbopackIgnore: true*/ directory, "manifest.json"),
  };
}

/**
 * 存储行 -> 对外记录。
 *
 * `artifact_path` 这个名字是磁盘时代的遗留（快照目录），现在它**只是个"有没有实例快照"的标记**
 * （界面拿它决定显示哈希还是「无实例快照」）。快照本体在
 * `ontology_platform.ontology_versions.snapshot` 那一列，不再有文件路径可给。
 */
function toRecord(row: VersionRecordRow): VersionRecord {
  return {
    id: row.id,
    target_id: row.target_id,
    version_number: row.version_number,
    status: row.status,
    definition: row.definition,
    created_by: row.created_by,
    created_at: row.created_at,
    published_at: row.published_at,
    artifact_path: row.content_hash ? "postgres:ontology_versions.snapshot" : "",
    entity_count: row.entity_count,
    relationship_count: row.relationship_count,
    content_hash: row.content_hash,
  };
}

async function readLegacySnapshot(directory: string): Promise<{ nodes: SnapshotNode[]; relationships: SnapshotRelationship[] }> {
  const files = legacyArtifactFiles(directory);
  const [nodesText, relationshipsText] = await Promise.all([
    readFile(/*turbopackIgnore: true*/ files.nodes, "utf8").catch(() => ""),
    readFile(/*turbopackIgnore: true*/ files.relationships, "utf8").catch(() => ""),
  ]);
  const nodeRows = nodesText.trim() ? (parse(nodesText, { columns: true, skip_empty_lines: true }) as Record<string, string>[]) : [];
  const relationshipRows = relationshipsText.trim() ? (parse(relationshipsText, { columns: true, skip_empty_lines: true }) as Record<string, string>[]) : [];
  return {
    nodes: nodeRows.map((item) => nodeSchema.parse({ id: item["node_id:ID"], labels: item[":LABEL"].split(";").filter(Boolean), properties: parseProperties(item.properties) })),
    relationships: relationshipRows.map((item) => relationshipSchema.parse({ id: item["relationship_id:ID"], sourceId: item[":START_ID"], targetId: item[":END_ID"], type: item[":TYPE"], properties: parseProperties(item.properties) })),
  };
}

let legacyMigration: Promise<void> | undefined;

/**
 * 一次性把磁盘上的历史版本搬进平台库，**搬完立刻删磁盘副本**。
 *
 * - 幂等：已经入库的版本（按 id 查得到）只删磁盘、不重复写；
 * - 逐个版本删：某个坏目录迁移失败时只保留它自己，下次访问再重试，不连累别的版本；
 * - 只在第一次访问版本数据时跑一次（进程内 memo）。
 */
export async function migrateLegacyVersionFiles(): Promise<void> {
  legacyMigration ??= migrateLegacyVersionFilesOnce().catch((error) => {
    legacyMigration = undefined;
    throw error;
  });
  return legacyMigration;
}

async function migrateLegacyVersionFilesOnce(): Promise<void> {
  const root = snapshotRoot();
  let targets: string[];
  try {
    targets = await readdir(/*turbopackIgnore: true*/ root);
  } catch {
    return; // 没有历史目录 = 已经迁过（或全新部署）
  }
  let migrated = 0;
  for (const targetSegment of targets) {
    if (!VERSION_SEGMENT.test(targetSegment)) continue;
    const targetDirectory = path.join(/*turbopackIgnore: true*/ root, targetSegment);
    let versions: string[];
    try {
      versions = await readdir(/*turbopackIgnore: true*/ targetDirectory);
    } catch {
      continue;
    }
    for (const versionSegment of versions) {
      if (!VERSION_SEGMENT.test(versionSegment)) continue;
      const directory = path.join(/*turbopackIgnore: true*/ targetDirectory, versionSegment);
      try {
        const manifest = JSON.parse(await readFile(/*turbopackIgnore: true*/ legacyArtifactFiles(directory).manifest, "utf8")) as LegacyManifest;
        if (manifest.targetId !== targetSegment || manifest.versionId !== versionSegment) continue;
        if (!(await getVersionRecordRow(versionSegment))) {
          const definition = ontologyDefinitionSchema.parse(JSON.parse(await readFile(/*turbopackIgnore: true*/ legacyArtifactFiles(directory).definition, "utf8")));
          const snapshot = await readLegacySnapshot(directory);
          const content = snapshotContent({ definition, nodes: snapshot.nodes, relationships: snapshot.relationships });
          await insertVersionRecordRow({
            id: versionSegment,
            targetId: manifest.targetId,
            versionNumber: manifest.versionNumber,
            status: isVersionStatus(manifest.status) ? manifest.status : "ARCHIVED",
            createdBy: manifest.createdBy ?? "",
            createdAt: manifest.createdAt,
            publishedAt: manifest.publishedAt ?? null,
            definition,
            snapshot: { nodes: snapshot.nodes, relationships: snapshot.relationships },
            entityCount: snapshot.nodes.length,
            relationshipCount: snapshot.relationships.length,
            contentHash: content.contentHash,
          });
          await replaceVersionConcepts(versionSegment, manifest.targetId, definition).catch(() => 0);
          migrated += 1;
        }
        await rm(/*turbopackIgnore: true*/ directory, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[version-store] 历史版本 ${versionSegment} 迁移失败，保留磁盘文件待下次重试：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 空的才删得掉；删不掉说明还有没迁成功的，下次再试。
    await rmdir(/*turbopackIgnore: true*/ targetDirectory).catch(() => undefined);
  }
  await rmdir(/*turbopackIgnore: true*/ root).catch(() => undefined);
  if (migrated) console.log(`[version-store] 已把 ${migrated} 个磁盘上的历史版本迁进平台库（磁盘副本已删除）。`);
}

export async function listVersionRecords(targetId: string): Promise<VersionRecord[]> {
  await migrateLegacyVersionFiles();
  return (await listVersionRecordRows(targetId)).map(toRecord);
}

export async function getVersionRecord(versionId: string): Promise<VersionRecord | null> {
  await migrateLegacyVersionFiles();
  const row = await getVersionRecordRow(versionId);
  return row ? toRecord(row) : null;
}

export async function createVersionRecord(input: { targetId: string; versionNumber: number; createdBy: string; definition: OntologyDefinition }): Promise<VersionRecord> {
  await migrateLegacyVersionFiles();
  const definition = ontologyDefinitionSchema.parse(input.definition);
  const id = randomUUID();
  const row = await insertVersionRecordRow({
    id,
    targetId: input.targetId,
    versionNumber: input.versionNumber,
    createdBy: input.createdBy,
    definition,
  });
  await replaceVersionConcepts(id, input.targetId, definition).catch((error) => {
    console.warn("[version-store] 概念索引写入失败（不影响版本本身）：", error instanceof Error ? error.message : error);
  });
  return toRecord(row);
}

export async function updateVersionRecord(versionId: string, patch: { status?: VersionStatus; publishedAt?: string | null }) {
  const row = await updateVersionRecordRow(versionId, patch);
  if (!row) throw new Error("本体版本不存在。");
}

/** 删一个版本。**不抛「不存在」**：调用方多在回滚失败的清理路径上，宽容比抛错有用。 */
export async function deleteVersionRecord(versionId: string) {
  await migrateLegacyVersionFiles().catch(() => undefined);
  await deleteVersionRecordRow(versionId);
}

export async function deleteTargetVersions(targetId: string) {
  await migrateLegacyVersionFiles().catch(() => undefined);
  const count = await deleteTargetVersionRecords(targetId);
  await rm(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ snapshotRoot(), safeSegment(targetId)), { recursive: true, force: true }).catch(() => undefined);
  return count;
}

/** 兼容旧调用（删本体存储、删本体时清理）：数据在平台库，这里顺带清掉可能残留的磁盘目录。 */
export async function removeTargetSnapshotDirectory(targetId: string) {
  await deleteTargetVersions(targetId).catch(() => 0);
}
async function withSnapshotLock<T>(versionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(versionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(versionId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(versionId) === queued) locks.delete(versionId);
  }
}

export async function withTargetLock<T>(targetId: string, operation: () => Promise<T>): Promise<T> {
  const previous = targetLocks.get(targetId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  targetLocks.set(targetId, queued);
  await previous;
  try {
    // 先在本实例排队，再拿数据库级锁，保证多实例部署时同一个本体存储只有一个发布在进行。
    return await withAdvisoryLock(`ontology:target:${targetId}`, operation);
  } finally {
    release();
    if (targetLocks.get(targetId) === queued) targetLocks.delete(targetId);
  }
}

function stripInternalProperties(properties: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => key !== INTERNAL_ID && key !== INTERNAL_VERSION_ID));
}

function snapshotContent(snapshot: VersionSnapshot) {
  const definition = `${JSON.stringify(snapshot.definition, null, 2)}\n`;
  const nodes = stringify(snapshot.nodes.map((node) => ({
    "node_id:ID": node.id,
    ":LABEL": node.labels.join(";"),
    properties: JSON.stringify(node.properties),
  })), { header: true, columns: ["node_id:ID", ":LABEL", "properties"] });
  const relationships = stringify(snapshot.relationships.map((relationship) => ({
    "relationship_id:ID": relationship.id,
    ":START_ID": relationship.sourceId,
    ":END_ID": relationship.targetId,
    ":TYPE": relationship.type,
    properties: JSON.stringify(relationship.properties),
  })), { header: true, columns: ["relationship_id:ID", ":START_ID", ":END_ID", ":TYPE", "properties"] });
  const contentHash = createHash("sha256").update(definition).update(nodes).update(relationships).digest("hex");
  return { definition, nodes, relationships, contentHash };
}

async function writeSnapshotFiles(record: VersionRecord, snapshot: VersionSnapshot) {
  const validated: VersionSnapshot = {
    definition: ontologyDefinitionSchema.parse(snapshot.definition),
    nodes: snapshot.nodes.map((node) => nodeSchema.parse(node)),
    relationships: snapshot.relationships.map((relationship) => relationshipSchema.parse(relationship)),
  };
  const content = snapshotContent(validated);
  const updated = await updateVersionRecordRow(record.id, {
    definition: validated.definition,
    snapshot: { nodes: validated.nodes, relationships: validated.relationships },
    entityCount: validated.nodes.length,
    relationshipCount: validated.relationships.length,
    contentHash: content.contentHash,
  });
  if (!updated) throw new Error("本体版本不存在。");
  // 概念索引跟着定义一起刷：它是将来向量检索的落点，写失败不能让版本保存失败。
  await replaceVersionConcepts(record.id, record.target_id, validated.definition).catch((error) => {
    console.warn("[version-store] 概念索引写入失败（不影响版本本身）：", error instanceof Error ? error.message : error);
  });
  return {
    formatVersion: SNAPSHOT_FORMAT,
    versionId: updated.id,
    targetId: updated.target_id,
    versionNumber: updated.version_number,
    status: updated.status,
    createdAt: updated.created_at,
    createdBy: updated.created_by,
    publishedAt: updated.published_at,
    entityCount: updated.entity_count,
    relationshipCount: updated.relationship_count,
    contentHash: updated.content_hash ?? "",
    updatedAt: new Date().toISOString(),
  };
}

function parseProperties(value: string) {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("快照属性列必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

async function readSnapshotFiles(record: VersionRecord): Promise<VersionSnapshot> {
  const row = await getVersionRecordRow(record.id);
  if (!row) throw new Error("本体版本不存在。");
  if (!row.snapshot) throw new Error("这个版本还没有实例快照，先创建草稿或发布一次。");
  const definition = ontologyDefinitionSchema.parse(row.definition);
  const nodes = (row.snapshot.nodes ?? []).map((node) => nodeSchema.parse(node));
  const relationships = (row.snapshot.relationships ?? []).map((item) => relationshipSchema.parse(item));
  // 完整性口径不变：定义 + 节点 + 关系三段算一个 sha256，写入时记、读出来比。
  const content = snapshotContent({ definition, nodes, relationships });
  if (row.content_hash && content.contentHash !== row.content_hash) throw new Error("版本快照内容校验失败，可能被外部改写。");
  return { definition, nodes, relationships };
}

export async function exportTargetSnapshot(target: GraphTarget, definition: OntologyDefinition): Promise<VersionSnapshot> {
  const exported = await getGraphStore(target).exportGraph();
  const snapshotIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const isUuid = (value: string) => VERSION_SEGMENT.test(value);
  const storedIdOf = (properties: Record<string, unknown>) => (typeof properties[INTERNAL_ID] === "string" ? (properties[INTERNAL_ID] as string) : null);
  /**
   * 对象身份 = (对象类型, 主键)：能算出来就用它，图里那条记录换一次快照也还是同一个对象（S1）。
   * 标签里可能带接口名，只有定义里的对象类型才算得出身份。
   */
  const identityIdOf = (labels: string[], properties: Record<string, unknown>) => {
    for (const label of labels) {
      const type = definition.entityTypes.find((entity) => entity.name === label);
      if (!type) continue;
      const identity = resolveObjectIdentity(type, properties);
      if (identity) return identity.id;
    }
    return null;
  };
  /** 后端元素 id -> 快照 UUID。优先保留后端里存的稳定 id，否则按需生成。 */
  const snapshotIdOf = (rawId: string, properties: Record<string, unknown>, labels: string[] = []) => {
    const existing = snapshotIds.get(rawId);
    if (existing) return existing;
    const stored = storedIdOf(properties);
    const derived = identityIdOf(labels, properties);
    const preferred = stored && !usedIds.has(stored)
      ? stored
      : derived && !usedIds.has(derived)
        ? derived
        : isUuid(rawId) && !usedIds.has(rawId)
          ? rawId
          : randomUUID();
    usedIds.add(preferred);
    snapshotIds.set(rawId, preferred);
    return preferred;
  };
  const nodes = exported.nodes.map((node) => nodeSchema.parse({
    id: snapshotIdOf(node.id, node.properties, node.labels),
    labels: node.labels,
    properties: stripInternalProperties(node.properties),
  }));
  const relationships = exported.relationships.map((relationship) => {
    const sourceId = snapshotIds.get(relationship.sourceId);
    const targetId = snapshotIds.get(relationship.targetId);
    if (!sourceId || !targetId) throw new Error("导出关系时找不到端点对象。");
    return relationshipSchema.parse({
      id: snapshotIdOf(relationship.id, relationship.properties),
      sourceId,
      targetId,
      type: relationship.type,
      properties: stripInternalProperties(relationship.properties),
    });
  });
  return { definition: ontologyDefinitionSchema.parse(definition), nodes, relationships };
}

export async function initializeVersionSnapshot(versionId: string, target: GraphTarget, sourceVersionId?: string | null) {
  return withSnapshotLock(versionId, async () => {
    const row = await getVersionRecord(versionId);
    if (!row) throw new Error("本体版本不存在。");
    let snapshot: VersionSnapshot;
    if (sourceVersionId) {
      const source = await getVersionRecord(sourceVersionId);
      if (!source || source.target_id !== row.target_id) throw new Error("快照来源版本不存在或不属于当前本体存储。");
      snapshot = await readSnapshotFiles(source);
      snapshot = { ...snapshot, definition: row.definition };
    } else {
      snapshot = await exportTargetSnapshot(target, row.definition);
    }
    return writeSnapshotFiles(row, snapshot);
  });
}

export async function ensureVersionSnapshot(versionId: string, target: GraphTarget) {
  const row = await getVersionRecord(versionId);
  if (!row) throw new Error("本体版本不存在。");
  if (row.target_id !== target.id) throw new Error("版本不属于当前本体存储。");
  if (!row.content_hash) {
    if (row.status === "ARCHIVED") throw new Error("该旧归档版本创建时尚未保存实例快照，不能用当前图数据伪造历史版本。");
    await initializeVersionSnapshot(versionId, target);
  }
  return readVersionSnapshot(versionId);
}

export async function readVersionSnapshot(versionId: string) {
  const row = await getVersionRecord(versionId);
  if (!row) throw new Error("本体版本不存在。");
  return readSnapshotFiles(row);
}

export async function mutateDraftSnapshot<T>(versionId: string, mutation: (snapshot: VersionSnapshot) => T | Promise<T>) {
  return withSnapshotLock(versionId, async () => {
    const row = await getVersionRecord(versionId);
    if (!row) throw new Error("本体版本不存在。");
    if (row.status !== "DRAFT") throw new Error("只有草稿版本可以修改实例数据。");
    const snapshot = await readSnapshotFiles(row);
    const result = await mutation(snapshot);
    await writeSnapshotFiles(row, snapshot);
    return result;
  });
}

export async function updateSnapshotDefinition(versionId: string, definition: OntologyDefinition) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const next = ontologyDefinitionSchema.parse(definition);
    const nextEntities = new Map(next.entityTypes.map((entity) => [entity.id, entity]));
    const nextRelationships = new Map(next.relationshipTypes.map((relationship) => [relationship.id, relationship]));
    for (const current of snapshot.definition.entityTypes) {
      const replacement = nextEntities.get(current.id);
      if (!replacement || replacement.name === current.name) continue;
      for (const node of snapshot.nodes) node.labels = node.labels.map((label) => label === current.name ? replacement.name : label);
    }
    for (const current of snapshot.definition.relationshipTypes) {
      const replacement = nextRelationships.get(current.id);
      if (!replacement || replacement.name === current.name) continue;
      for (const relationship of snapshot.relationships) if (relationship.type === current.name) relationship.type = replacement.name;
    }
    snapshot.definition = next;
    return snapshot.definition;
  });
}

export function entityFromSnapshot(node: SnapshotNode): EntityRecord {
  return { id: node.id, labels: node.labels, properties: node.properties };
}

export function relationshipFromSnapshot(relationship: SnapshotRelationship, nodes: Map<string, SnapshotNode>): RelationshipRecord {
  const source = nodes.get(relationship.sourceId);
  const target = nodes.get(relationship.targetId);
  return {
    id: relationship.id,
    type: relationship.type,
    sourceId: relationship.sourceId,
    targetId: relationship.targetId,
    properties: relationship.properties,
    sourceLabels: source?.labels,
    sourceProperties: source?.properties,
    targetLabels: target?.labels,
    targetProperties: target?.properties,
  };
}

function searchable(values: unknown[]) {
  return values.map((value) => typeof value === "object" ? JSON.stringify(value) : String(value ?? "")).join(" ").toLocaleLowerCase();
}

export function listSnapshotEntities(snapshot: VersionSnapshot, options: { label?: string | null; search?: string | null; limit?: number } = {}) {
  const search = options.search?.trim().toLocaleLowerCase();
  // 按对象类型筛就是字面匹配（类之间不再有父子关系；接口那层传播在图库侧读路径上做）。
  const labels = options.label ? new Set([options.label]) : null;
  return snapshot.nodes
    .filter((node) => !labels || node.labels.some((label) => labels.has(label)))
    .filter((node) => !search || searchable(Object.values(node.properties)).includes(search))
    .slice(0, options.limit ?? 200)
    .map(entityFromSnapshot);
}

export function listSnapshotRelationships(snapshot: VersionSnapshot, options: { type?: string | null; search?: string | null; limit?: number } = {}) {
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const search = options.search?.trim().toLocaleLowerCase();
  return snapshot.relationships
    .filter((relationship) => !options.type || relationship.type === options.type)
    .filter((relationship) => {
      if (!search) return true;
      const source = nodes.get(relationship.sourceId);
      const target = nodes.get(relationship.targetId);
      return searchable([relationship.type, ...Object.values(relationship.properties), ...Object.values(source?.properties ?? {}), ...Object.values(target?.properties ?? {})]).includes(search);
    })
    .slice(0, options.limit ?? 200)
    .map((relationship) => relationshipFromSnapshot(relationship, nodes));
}

export function graphFromSnapshot(snapshot: VersionSnapshot, options: { labels?: string[]; relationshipTypes?: string[]; search?: string | null; nodeLimit?: number } = {}): GraphData {
  const labels = new Set(options.labels ?? []);
  const relationshipTypes = new Set(options.relationshipTypes ?? []);
  const search = options.search?.trim().toLocaleLowerCase();
  let nodes = snapshot.nodes.filter((node) => (!labels.size || node.labels.some((label) => labels.has(label))) && (!search || searchable([...node.labels, ...Object.values(node.properties)]).includes(search)));
  if (relationshipTypes.size) {
    const endpointIds = new Set(snapshot.relationships.filter((relationship) => relationshipTypes.has(relationship.type)).flatMap((relationship) => [relationship.sourceId, relationship.targetId]));
    nodes = nodes.filter((node) => endpointIds.has(node.id));
  }
  nodes = nodes.slice(0, options.nodeLimit ?? 300);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes: nodes.map(entityFromSnapshot),
    relationships: snapshot.relationships
      .filter((relationship) => nodeIds.has(relationship.sourceId) && nodeIds.has(relationship.targetId) && (!relationshipTypes.size || relationshipTypes.has(relationship.type)))
      .map((relationship) => ({ id: relationship.id, type: relationship.type, source: relationship.sourceId, target: relationship.targetId, properties: relationship.properties })),
  };
}

/** 一个类的属性。**不再有继承**：这一份就是类自己定义的属性（写实例 / 表单 / 唯一值校验共用）。 */
export function classProperties(definition: OntologyDefinition, typeName: string) {
  const type = definition.entityTypes.find((item) => item.name === typeName);
  return type ? type.properties : undefined;
}

export function runtimeTypesFromSnapshot(snapshot: VersionSnapshot): RuntimeTypeSet {
  const labelCounts = new Map(snapshot.definition.entityTypes.map((type) => [type.name, 0]));
  const relationshipCounts = new Map(snapshot.definition.relationshipTypes.map((type) => [type.name, 0]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const relationshipEndpoints: Record<string, { source: string; target: string }> = {};
  const entityTypesById = new Map(snapshot.definition.entityTypes.map((type) => [type.id, type]));
  for (const relationship of snapshot.definition.relationshipTypes) {
    const source = entityTypesById.get(relationship.sourceEntityTypeId)?.name;
    const target = entityTypesById.get(relationship.targetEntityTypeId)?.name;
    if (source && target) relationshipEndpoints[relationship.name] = { source, target };
  }
  for (const node of snapshot.nodes) for (const label of node.labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  for (const relationship of snapshot.relationships) {
    relationshipCounts.set(relationship.type, (relationshipCounts.get(relationship.type) ?? 0) + 1);
    const source = nodes.get(relationship.sourceId)?.labels[0];
    const target = nodes.get(relationship.targetId)?.labels[0];
    if (source && target && !relationshipEndpoints[relationship.type]) relationshipEndpoints[relationship.type] = { source, target };
  }
  return {
    labels: [...labelCounts].map(([name, count]) => ({ name, count, properties: classProperties(snapshot.definition, name) })),
    relationshipTypes: [...relationshipCounts].map(([name, count]) => ({ name, count, properties: snapshot.definition.relationshipTypes.find((type) => type.name === name)?.properties })),
    entityCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
    relationshipEndpoints,
  };
}

const MAX_INDEXED_VALUE_BYTES = 8191;

/** 发布前检查的一条结论：severity 为 WARN 的只是提醒，不挡发布。 */
export type SnapshotViolation = { rule: string; message: string; count: number; severity?: "WARN" };

export function validateVersionSnapshot(snapshot: VersionSnapshot, knownSourceIds?: readonly string[]) {
  const violations: SnapshotViolation[] = [];
  /*
   * 对象身份是 (对象类型, 主键)：同一个对象类型里主键重复 = 本体里同一个对象存在两份，
   * 后续按主键取数、写回、索引都会打架，所以这一条**挡发布**（不是提醒）。
   */
  for (const conflict of primaryKeyConflicts(snapshot.definition, snapshot.nodes)) {
    violations.push({
      rule: `${conflict.typeName}.主键`,
      message: `主键重复：「${conflict.key}」出现在 ${conflict.ids.length} 个「${conflict.typeName}」对象上（${conflict.ids.join("、")}）。同一个对象类型里主键必须唯一。`,
      count: conflict.ids.length,
    });
  }
  // 来源绑定（一个类挂多份表，按主键合并属性）是建模信息，图里看不出来，只能查定义。
  for (const entity of snapshot.definition.entityTypes) violations.push(...validateEntitySources(entity, { knownSourceIds }));
  // 关系类型的键映射同理：它是定义层的声明，指向不存在的属性时换台机器导入就是悬空引用。
  for (const item of relationshipKeyViolations(snapshot.definition)) violations.push(item);
  // 关系类型的数据来源（D2）：配了但取不出实例的话，图上看不到边，这里提醒一句（不挡发布）。
  for (const item of linkSourceViolations(snapshot.definition)) violations.push(item);
  // 指标：指向不存在的对象类型 / 属性就是悬空引用，模型拿着它也算不出数。
  for (const item of metricViolations(snapshot.definition)) violations.push(item);
  const entityTypes = new Map(snapshot.definition.entityTypes.map((entity) => [entity.name, entity]));
  const relationshipTypes = new Map(snapshot.definition.relationshipTypes.map((relationship) => [relationship.name, relationship]));
  const entityTypesById = new Map(snapshot.definition.entityTypes.map((entity) => [entity.id, entity]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const uniqueValues = new Map<string, Set<string>>();
  const oversizedUnique = new Map<string, { typeName: string; propertyName: string; nodes: SnapshotNode[] }>();
  for (const node of snapshot.nodes) {
    const managed = node.labels.filter((label) => entityTypes.has(label));
    if (managed.length !== 1 || managed.length !== node.labels.length) {
      violations.push({ rule: node.id, message: "对象必须且只能使用一个草稿中定义的对象类型。", count: 1 });
      continue;
    }
    const type = entityTypes.get(managed[0])!;
    const properties = type.properties;
    const businessProperties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
    try { parsePropertyValues(properties, businessProperties); } catch (error) {
      violations.push({ rule: `${type.name}:${node.id}`, message: error instanceof Error ? error.message : "对象属性校验失败。", count: 1 });
    }
    for (const property of properties.filter((item) => item.unique && node.properties[item.name] != null)) {
      const key = `${type.id}:${property.name}`;
      const raw = node.properties[property.name];
      const value = JSON.stringify(raw);
      const seen = uniqueValues.get(key) ?? new Set<string>();
      if (seen.has(value)) violations.push({ rule: `${type.name}.${property.name}`, message: "唯一属性存在重复值。", count: 1 });
      seen.add(value);
      uniqueValues.set(key, seen);
      const serialized = typeof raw === "string" ? raw : value;
      if (Buffer.byteLength(serialized, "utf8") > MAX_INDEXED_VALUE_BYTES) {
        const rule = `${type.name}.${property.name}`;
        const entry = oversizedUnique.get(rule) ?? { typeName: type.name, propertyName: property.name, nodes: [] };
        entry.nodes.push(node);
        oversizedUnique.set(rule, entry);
      }
    }
  }
  for (const relationship of snapshot.relationships) {
    const type = relationshipTypes.get(relationship.type);
    const source = nodes.get(relationship.sourceId);
    const target = nodes.get(relationship.targetId);
    if (!type) { violations.push({ rule: relationship.id, message: "关系使用了草稿中不存在的关系类型。", count: 1 }); continue; }
    if (!source || !target) { violations.push({ rule: relationship.id, message: "关系引用了不存在的对象。", count: 1 }); continue; }
    const sourceType = entityTypesById.get(type.sourceEntityTypeId);
    const targetType = entityTypesById.get(type.targetEntityTypeId);
    if (!sourceType || !targetType || !source.labels.includes(sourceType.name) || !target.labels.includes(targetType.name)) {
      violations.push({ rule: `${type.name}:${relationship.id}`, message: "关系端点不符合草稿中的对象类型契约。", count: 1 });
    }
    try { parsePropertyValues(type.properties, relationship.properties); } catch (error) {
      violations.push({ rule: `${type.name}:${relationship.id}`, message: error instanceof Error ? error.message : "关系属性校验失败。", count: 1 });
    }
  }
  for (const entry of oversizedUnique.values()) {
    const displayProperty = snapshot.definition.entityTypes.find((type) => type.name === entry.typeName)?.displayProperty;
    const fallbackKeys = ["表名", "名称", "name", "title", "id"];
    const involved = entry.nodes.map((node) => {
      const keys = displayProperty ? [displayProperty, ...fallbackKeys] : fallbackKeys;
      const readable = keys.map((key) => node.properties[key]).find((value) => (typeof value === "string" && value.trim()) || typeof value === "number");
      const name = readable != null ? String(readable) : node.id;
      const shortName = name.length > 60 ? `${name.slice(0, 60)}…` : name;
      const raw = String(node.properties[entry.propertyName] ?? "");
      const snippet = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
      return `「${shortName}」(${node.id}，${entry.propertyName}开头：${snippet})`;
    }).join("、");
    violations.push({ rule: `${entry.typeName}.${entry.propertyName}`, message: `唯一属性「${entry.propertyName}」有 ${entry.nodes.length} 个值的长度超过 ${MAX_INDEXED_VALUE_BYTES} 字节（约 8KB），不适合当唯一键。涉及：${involved}。请将该属性改为非唯一，或缩短字段内容后重试。`, count: entry.nodes.length });
  }
  /*
   * 接口是抽象契约：声明实现了就必须满足它的必填属性与必填关系约束，否则应用拿到的是缺字段的对象。
   * 这两条校验原先只挂在接口管理页（客户端提示），发布路径上漏了 —— 于是"接口页写着还差 2 项"的草稿照样能发布。
   * 接进发布前校验后，界面上的承诺（发布前校验会拦住没满足的实现）才成立。
   */
  for (const item of [...validateInterfaces(snapshot.definition), ...validateInterfaceImplementations(snapshot.definition)]) {
    violations.push({ rule: item.rule, message: item.message, count: item.count });
  }
  const actionViolations: SnapshotViolation[] = validateActionDefinition(snapshot.definition);
  return [...violations, ...actionViolations];
}

/**
 * 这个对象上应该看到哪些动作。
 *
 * 隐藏规则只看动作执行前就有的数据，所以读的是快照当前的样子，不跑动作。
 */
export async function visibleSnapshotActions(versionId: string, subjectEntityId: string): Promise<ActionVisibility[]> {
  const snapshot = await readVersionSnapshot(versionId);
  return visibleActions(snapshot.definition, snapshot, subjectEntityId);
}

/**
 * 运行动作。
 *
 * 干跑只读快照、返回"会发生什么"；执行则在草稿锁内按最新快照重算一次再落盘，
 * 命中闸门规则时抛出 `ActionBlockedError`，快照文件保持原样。
 */
export async function runSnapshotAction(versionId: string, actionId: string, inputs: ActionRunInput[], options: { dryRun: boolean; subjectEntityId?: string }): Promise<{ outcome: ActionOutcome; applied: boolean }> {
  const row = await getVersionRecord(versionId);
  if (!row) throw new Error("本体版本不存在。");
  if (row.status !== "DRAFT") throw new Error("只有草稿版本可以运行动作，请先创建草稿。");
  const snapshot = await readVersionSnapshot(versionId);
  const preview = runAction(snapshot.definition, snapshot, actionId, inputs, { subjectEntityId: options.subjectEntityId });
  if (options.dryRun || preview.verdict === "BLOCKED") return { outcome: preview, applied: false };
  const outcome = await mutateDraftSnapshot<ActionOutcome>(versionId, (current) => {
    const fresh = runAction(current.definition, current, actionId, inputs, { subjectEntityId: options.subjectEntityId });
    if (fresh.verdict === "BLOCKED") throw new ActionBlockedError(fresh);
    current.nodes = fresh.graph.nodes;
    current.relationships = fresh.graph.relationships;
    return fresh;
  }).catch((reason: unknown) => {
    if (reason instanceof ActionBlockedError) return reason.outcome;
    throw reason;
  });
  return { outcome, applied: outcome.verdict === "PASSED" };
}

export async function createSnapshotEntity(versionId: string, entityType: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const type = snapshot.definition.entityTypes.find((item) => item.name === entityType);
    if (!type) throw new Error("对象类型未在当前草稿中定义。");
    const properties = parsePropertyValues(type.properties, rawProperties);
    /*
     * 对象身份 = (对象类型, 主键)：主键齐全时 id 由主键推出来（确定性），
     * 于是同一个业务记录在本体里只有一份，换快照 / 重复导入都落到同一个对象上（S1）。
     */
    const identity = resolveObjectIdentity(type, properties);
    if (identity && snapshot.nodes.some((node) => node.id === identity.id)) {
      throw new Error(`已经存在主键相同的「${type.name}」对象，不能在同一个本体里重复新建。`);
    }
    const node = nodeSchema.parse({ id: identity?.id ?? randomUUID(), labels: [type.name], properties });
    snapshot.nodes.push(node);
    return entityFromSnapshot(node);
  });
}

export async function updateSnapshotEntity(versionId: string, entityId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const node = snapshot.nodes.find((item) => item.id === entityId);
    if (!node) return null;
    const type = snapshot.definition.entityTypes.find((item) => node.labels.includes(item.name));
    if (!type) throw new Error("对象类型未在当前草稿中定义。");
    const layout = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key === "fx" || key === "fy"));
    node.properties = { ...parsePropertyValues(type.properties, rawProperties), ...layout };
    return entityFromSnapshot(node);
  });
}

export async function deleteSnapshotEntity(versionId: string, entityId: string) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const before = snapshot.nodes.length;
    snapshot.nodes = snapshot.nodes.filter((node) => node.id !== entityId);
    snapshot.relationships = snapshot.relationships.filter((relationship) => relationship.sourceId !== entityId && relationship.targetId !== entityId);
    return before !== snapshot.nodes.length;
  });
}

export async function createSnapshotRelationship(versionId: string, typeName: string, sourceId: string, targetId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const type = snapshot.definition.relationshipTypes.find((item) => item.name === typeName);
    if (!type) throw new Error("关系类型未在当前草稿中定义。");
    const source = snapshot.nodes.find((node) => node.id === sourceId);
    const target = snapshot.nodes.find((node) => node.id === targetId);
    const sourceType = snapshot.definition.entityTypes.find((item) => item.id === type.sourceEntityTypeId);
    const targetType = snapshot.definition.entityTypes.find((item) => item.id === type.targetEntityTypeId);
    if (!source || !target) throw new Error("关系端点不存在。");
    if (!sourceType || !targetType || !source.labels.includes(sourceType.name) || !target.labels.includes(targetType.name)) throw new Error("关系端点不符合草稿类型契约。");
    const relationship = relationshipSchema.parse({ id: randomUUID(), sourceId, targetId, type: type.name, properties: parsePropertyValues(type.properties, rawProperties) });
    snapshot.relationships.push(relationship);
    return relationshipFromSnapshot(relationship, new Map(snapshot.nodes.map((node) => [node.id, node])));
  });
}

export async function updateSnapshotRelationship(versionId: string, relationshipId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const relationship = snapshot.relationships.find((item) => item.id === relationshipId);
    if (!relationship) return null;
    const type = snapshot.definition.relationshipTypes.find((item) => item.name === relationship.type);
    if (!type) throw new Error("关系类型未在当前草稿中定义。");
    relationship.properties = parsePropertyValues(type.properties, rawProperties);
    return relationshipFromSnapshot(relationship, new Map(snapshot.nodes.map((node) => [node.id, node])));
  });
}

export async function deleteSnapshotRelationship(versionId: string, relationshipId: string) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const before = snapshot.relationships.length;
    snapshot.relationships = snapshot.relationships.filter((relationship) => relationship.id !== relationshipId);
    return before !== snapshot.relationships.length;
  });
}

export async function updateSnapshotPositions(versionId: string, items: { elementId: string; x: number; y: number }[]) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const positions = new Map(items.map((item) => [item.elementId, item]));
    let updated = 0;
    for (const node of snapshot.nodes) {
      const position = positions.get(node.id);
      if (!position) continue;
      node.properties = { ...node.properties, fx: position.x, fy: position.y };
      updated += 1;
    }
    return updated;
  });
}
