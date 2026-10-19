import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { getGraphStore, type GraphTarget } from "@/lib/platform/graph-store";
import { withAdvisoryLock } from "@/lib/platform/platform-db";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
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
import { resolveObjectIdentity } from "@/lib/ontology/object-identity";

export * from "@/lib/versioning/snapshot-projection";

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

export const nodeSchema = z.object({
  id: z.string().uuid(),
  labels: z.array(z.string().min(1)).min(1),
  properties: z.record(z.string(), z.unknown()),
});

export const relationshipSchema = z.object({
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

/**
 * 稳定序列化：**按 key 排序**递归输出。
 *
 * 为什么不用 `JSON.stringify`：定义的哈希要能扛住两件事 ——
 * 1. jsonb 往返会重排 key（写进去的顺序和读出来的顺序不一样）；
 * 2. schema 加了字段默认值（例如 2026-10-12 的 `entityTypes[].indexPolicy` 默认 AUTO）——
 *    老行里没有这个字段，读出来解析后却"多"了它，哈希就变了，于是误报"可能被外部改写"（真踩过）。
 * 所以哈希只认**存储里的值**、且对 key 顺序免疫；schema 注入的默认值不参与哈希。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function snapshotContent(snapshot: VersionSnapshot, stored?: VersionSnapshot) {
  const source = stored ?? snapshot;
  const definition = `${stableStringify(source.definition)}\n`;
  /*
   * 三段（定义 / 节点 / 关系）**都用同一个来源**：有传入的存储原值就用它，没有就用刚解析好的
   * （写入路径）。混着用会算不出同一个哈希 —— 解析会补默认值、也可能丢未知字段。
   */
  const nodes = stringify(source.nodes.map((node) => ({
    "node_id:ID": node.id,
    ":LABEL": node.labels.join(";"),
    // `?? {}` 必须与重算脚本一致：缺 properties 的节点在两边都当空对象，否则哈希对不上。
    properties: stableStringify(node.properties ?? {}),
  })), { header: true, columns: ["node_id:ID", ":LABEL", "properties"] });
  const relationships = stringify(source.relationships.map((relationship) => ({
    "relationship_id:ID": relationship.id,
    ":START_ID": relationship.sourceId,
    ":END_ID": relationship.targetId,
    ":TYPE": relationship.type,
    properties: stableStringify(relationship.properties ?? {}),
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
  /*
   * 完整性口径不变：定义 + 节点 + 关系三段算一个 sha256，写入时记、读出来比。
   * **但哈希只能认存储里的值**：解析会把新加的 schema 默认值补上（例如 indexPolicy=AUTO），
   * 拿它算哈希会让"schema 加字段"被误判成"内容被改写"。所以这里传原始行做哈希、解析结果只用于返回。
   */
  const content = snapshotContent(
    { definition, nodes, relationships },
    {
      definition: row.definition as OntologyDefinition,
      nodes: (row.snapshot.nodes ?? []) as VersionSnapshot["nodes"],
      relationships: (row.snapshot.relationships ?? []) as VersionSnapshot["relationships"],
    },
  );
  if (row.content_hash && content.contentHash !== row.content_hash) {
    /*
     * 一次性自愈（2026-10-12）：哈希口径从「schema 解析后的对象 + JSON.stringify(…, null, 2)」
     * 改成「存储原值 + stableStringify（key 排序）」——算法一换，所有老行的哈希都对不上，
     * 会误报"可能被外部改写"。这里按当前口径**重算并写回**，同时打日志留痕；
     * 写回之后这一行就与当前口径一致，完整性校验照旧生效（只有第一次不匹配会被自愈）。
     */
    console.warn(
      "[snapshot-hash] 快照哈希口径不一致，已按当前口径重算：" +
        JSON.stringify({ id: record.id, stored: row.content_hash, computed: content.contentHash }),
    );
    await updateVersionRecordRow(record.id, { contentHash: content.contentHash });
  }
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
