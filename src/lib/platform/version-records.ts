import { jsonValue, platformRepo, withPlatformQueryRunner } from "@/lib/platform/db";
import { OntologyConceptEntity, OntologyVersionEntity } from "@/lib/platform/db/entities";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { conceptsOfDefinition, type OntologyConcept } from "@/lib/ontology/concepts";

/**
 * 本体版本记录的**存储层**（2026-10-10 从磁盘迁到 PG）。
 *
 * 这一层只管"表里有什么"：实体 ↔ 领域对象的映射、增删改查、以及概念索引的写入。
 * 快照文件、路径、锁、发布编排都在 `@/lib/versioning/snapshot`，这里不认识文件系统。
 *
 * 两条边界：
 * - `snapshot` 是**实例快照**（nodes + relationships），这一层当不透明 jsonb 存；
 *   具体校验（zod）在 `@/lib/versioning/snapshot` 做。
 * - 领域类型 `VersionRecord` 刻意**不含 snapshot**：它会随 `/api/ontology` 列表发给浏览器，
 *   带上整份实例快照就是几百 KB 起步。要快照请用 `getVersionRecordRow` 或版本快照接口。
 */
export type VersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

/** 实例快照的存储形状：这一层不解释它，读出来的人负责校验。 */
export type StoredSnapshot = { nodes: unknown[]; relationships: unknown[] };

export type VersionRecordRow = {
  id: string;
  target_id: string;
  version_number: number;
  status: VersionStatus;
  definition: OntologyDefinition;
  snapshot: StoredSnapshot | null;
  created_by: string;
  created_at: string;
  published_at: string | null;
  entity_count: number;
  relationship_count: number;
  content_hash: string | null;
};

/** 对外（含 API 响应）的版本记录：去掉实例快照。 */
export type VersionRecord = Omit<VersionRecordRow, "snapshot"> & {
  /** 有实例快照时是它的目录名（只作"有没有快照"的标记与实际存储位），没有就是空串。 */
  artifact_path: string;
};

const STATUSES: VersionStatus[] = ["DRAFT", "PUBLISHED", "ARCHIVED"];

export function isVersionStatus(value: unknown): value is VersionStatus {
  return typeof value === "string" && (STATUSES as string[]).includes(value);
}

function toRow(entity: OntologyVersionEntity): VersionRecordRow {
  return {
    id: entity.id,
    target_id: entity.targetId,
    version_number: entity.versionNumber,
    status: isVersionStatus(entity.status) ? entity.status : "ARCHIVED",
    definition: ontologyDefinitionSchema.parse(entity.definition),
    snapshot: (entity.snapshot ?? null) as StoredSnapshot | null,
    created_by: entity.createdBy ?? "",
    created_at: entity.createdAt.toISOString(),
    published_at: entity.publishedAt ? entity.publishedAt.toISOString() : null,
    entity_count: entity.entityCount ?? 0,
    relationship_count: entity.relationshipCount ?? 0,
    content_hash: entity.contentHash || null,
  };
}

/** 一个本体存储下的全部版本，版本号从大到小（和磁盘实现的排序一致）。 */
export async function listVersionRecordRows(targetId: string): Promise<VersionRecordRow[]> {
  const repo = await platformRepo(OntologyVersionEntity);
  const rows = await repo.find({ where: { targetId }, order: { versionNumber: "DESC" } });
  return rows.map(toRow);
}

export async function getVersionRecordRow(versionId: string): Promise<VersionRecordRow | null> {
  const repo = await platformRepo(OntologyVersionEntity);
  const row = await repo.findOne({ where: { id: versionId } });
  return row ? toRow(row) : null;
}

export async function insertVersionRecordRow(input: {
  id: string;
  targetId: string;
  versionNumber: number;
  status?: VersionStatus;
  createdBy: string;
  createdAt?: string;
  publishedAt?: string | null;
  definition: OntologyDefinition;
  snapshot?: StoredSnapshot | null;
  entityCount?: number;
  relationshipCount?: number;
  contentHash?: string | null;
}): Promise<VersionRecordRow> {
  const repo = await platformRepo(OntologyVersionEntity);
  const existing = await repo.findOne({ where: { id: input.id } });
  // 幂等：老数据迁移是"边读边写"，重跑不能因为主键冲突炸掉（版本号唯一约束同理）。
  if (existing) return toRow(existing);
  const now = new Date();
  await repo.insert({
    id: input.id,
    targetId: input.targetId,
    versionNumber: input.versionNumber,
    status: input.status ?? "DRAFT",
    definition: jsonValue(input.definition),
    snapshot: input.snapshot ? jsonValue(input.snapshot) : null,
    createdBy: input.createdBy,
    createdAt: input.createdAt ? new Date(input.createdAt) : now,
    publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
    entityCount: input.entityCount ?? 0,
    relationshipCount: input.relationshipCount ?? 0,
    contentHash: input.contentHash ?? null,
    updatedAt: now,
  });
  const row = await repo.findOne({ where: { id: input.id } });
  if (!row) throw new Error("本体版本写入后读不回来。");
  return toRow(row);
}

export async function updateVersionRecordRow(versionId: string, patch: {
  status?: VersionStatus;
  publishedAt?: string | null;
  definition?: OntologyDefinition;
  snapshot?: StoredSnapshot | null;
  entityCount?: number;
  relationshipCount?: number;
  contentHash?: string | null;
}): Promise<VersionRecordRow | null> {
  const repo = await platformRepo(OntologyVersionEntity);
  const row = await repo.findOne({ where: { id: versionId } });
  if (!row) return null;
  const next: Partial<OntologyVersionEntity> = { updatedAt: new Date() };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.publishedAt !== undefined) next.publishedAt = patch.publishedAt ? new Date(patch.publishedAt) : null;
  if (patch.definition !== undefined) next.definition = jsonValue(patch.definition);
  if (patch.snapshot !== undefined) next.snapshot = patch.snapshot ? jsonValue(patch.snapshot) : null;
  if (patch.entityCount !== undefined) next.entityCount = patch.entityCount;
  if (patch.relationshipCount !== undefined) next.relationshipCount = patch.relationshipCount;
  if (patch.contentHash !== undefined) next.contentHash = patch.contentHash;
  await repo.update({ id: versionId }, next);
  const updated = await repo.findOne({ where: { id: versionId } });
  return updated ? toRow(updated) : null;
}

/** 删版本：连同它的概念索引一起删（概念表没有外键，必须手动收）。 */
export async function deleteVersionRecordRow(versionId: string): Promise<void> {
  const [versionRepo, conceptRepo] = await Promise.all([platformRepo(OntologyVersionEntity), platformRepo(OntologyConceptEntity)]);
  await conceptRepo.delete({ versionId });
  await versionRepo.delete({ id: versionId });
}

export async function deleteTargetVersionRecords(targetId: string): Promise<number> {
  const [versionRepo, conceptRepo] = await Promise.all([platformRepo(OntologyVersionEntity), platformRepo(OntologyConceptEntity)]);
  const count = await versionRepo.count({ where: { targetId } });
  await conceptRepo.delete({ targetId });
  await versionRepo.delete({ targetId });
  return count;
}

/**
 * 概念索引：一行一个概念（对象类型 / 属性 / 关系类型 / 接口 / 指标 / 动作 / 规则 / 分组）。
 *
 * 现在只写文本，够全文与 trigram 检索用；**将来加向量检索时只差"算 embedding"这一步** ——
 * 列与索引由 `ensureConceptSearchIndex()` 在库支持时补（装不上就如实没有）。
 */
export async function replaceVersionConcepts(versionId: string, targetId: string, definition: OntologyDefinition): Promise<number> {
  const repo = await platformRepo(OntologyConceptEntity);
  const concepts: OntologyConcept[] = conceptsOfDefinition(definition);
  await repo.delete({ versionId });
  if (!concepts.length) return 0;
  const now = new Date();
  // 分批发：一个本体几百到几千条概念，一次 insert 太多会顶到参数上限。
  for (let index = 0; index < concepts.length; index += 500) {
    await repo.insert(concepts.slice(index, index + 500).map((concept) => ({
      versionId,
      targetId,
      kind: concept.kind,
      name: concept.name.slice(0, 200),
      objectType: concept.objectType.slice(0, 200),
      searchText: concept.text.slice(0, 4000),
      updatedAt: now,
    })));
    // search_doc / embedding 是 PG 专有列，由库自己维护（生成列），这里不写。
  }
  return concepts.length;
}

let conceptIndexPromise: Promise<void> | undefined;

/**
 * 概念索引的"库特性"补丁：全文生成列 + GIN、名字的 trigram 索引，以及
 * **pgvector 可用时的 `embedding vector(1536)` 列 + hnsw 索引**（和 `object_entries` 一个套路）。
 *
 * 装不上扩展就如实降级（不是错误）：文本检索照常，向量检索这一路等有扩展时再补。
 * 幂等，可以重复调用；只在第一次写入概念时触发。
 */
export async function ensureConceptSearchIndex(): Promise<void> {
  conceptIndexPromise ??= bootstrapConceptSearchIndex().catch((error) => {
    conceptIndexPromise = undefined;
    throw error;
  });
  return conceptIndexPromise;
}

async function tryExtension(name: "pg_trgm" | "vector"): Promise<boolean> {
  try {
    await withPlatformQueryRunner((runner) => runner.query(`CREATE EXTENSION IF NOT EXISTS ${name}`));
    return true;
  } catch {
    return false;
  }
}

async function bootstrapConceptSearchIndex(): Promise<void> {
  const trigram = await tryExtension("pg_trgm");
  const vector = await tryExtension("vector");
  await withPlatformQueryRunner(async (runner) => {
    await runner.query(`ALTER TABLE ontology_platform.ontology_concepts ADD COLUMN IF NOT EXISTS search_doc tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED`);
    await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_search_idx ON ontology_platform.ontology_concepts USING gin (search_doc)`);
    if (trigram) {
      await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_name_trgm_idx ON ontology_platform.ontology_concepts USING gin (name gin_trgm_ops)`);
    }
    if (vector) {
      await runner.query(`ALTER TABLE ontology_platform.ontology_concepts ADD COLUMN IF NOT EXISTS embedding vector(1536)`);
      await runner.query(`CREATE INDEX IF NOT EXISTS ontology_concepts_embedding_idx ON ontology_platform.ontology_concepts USING hnsw (embedding vector_cosine_ops)`);
    }
  });
}
