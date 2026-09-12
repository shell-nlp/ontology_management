import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { getGraphStore, type GraphData, type GraphTarget } from "@/lib/graph";
import { withAdvisoryLock } from "@/lib/platform-db";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { ActionBlockedError, runAction, validateActionDefinition, visibleActions, type ActionOutcome, type ActionRunInput, type ActionVisibility } from "@/lib/action-engine";
import { parsePropertyValues } from "@/lib/instance-property-editor";
import type { EntityRecord, RelationshipRecord, RuntimeTypeSet } from "@/lib/graph/types";

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

export type VersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export type VersionRecord = {
  id: string;
  target_id: string;
  version_number: number;
  status: VersionStatus;
  definition: OntologyDefinition;
  created_by: string;
  created_at: string;
  published_at: string | null;
  artifact_path: string;
  entity_count: number;
  relationship_count: number;
  content_hash: string | null;
};

type SnapshotManifest = {
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

export async function removeTargetSnapshotDirectory(targetId: string) {
  const directory = path.join(/*turbopackIgnore: true*/ snapshotRoot(), safeSegment(targetId));
  await rm(/*turbopackIgnore: true*/ directory, { recursive: true, force: true });
}

function artifactFiles(directory: string) {
  return {
    definition: path.join(/*turbopackIgnore: true*/ directory, "definition.json"),
    nodes: path.join(/*turbopackIgnore: true*/ directory, "nodes.csv"),
    relationships: path.join(/*turbopackIgnore: true*/ directory, "relationships.csv"),
    manifest: path.join(/*turbopackIgnore: true*/ directory, "manifest.json"),
  };
}

async function readManifest(directory: string) {
  const text = await readFile(path.join(/*turbopackIgnore: true*/ directory, "manifest.json"), "utf8");
  return JSON.parse(text) as SnapshotManifest;
}

async function readManifestSafe(directory: string): Promise<SnapshotManifest | null> {
  try {
    return await readManifest(directory);
  } catch {
    return null;
  }
}

async function writeManifest(directory: string, manifest: SnapshotManifest) {
  await atomicWrite(path.join(/*turbopackIgnore: true*/ directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readDefinition(directory: string): Promise<OntologyDefinition> {
  return ontologyDefinitionSchema.parse(JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ directory, "definition.json"), "utf8")));
}

function toVersionRecord(manifest: SnapshotManifest, directory: string): Omit<VersionRecord, "definition"> {
  return {
    id: manifest.versionId,
    target_id: manifest.targetId,
    version_number: manifest.versionNumber,
    status: manifest.status ?? "ARCHIVED",
    created_by: manifest.createdBy ?? "",
    created_at: manifest.createdAt ?? new Date(0).toISOString(),
    published_at: manifest.publishedAt ?? null,
    artifact_path: directory,
    entity_count: manifest.entityCount ?? 0,
    relationship_count: manifest.relationshipCount ?? 0,
    content_hash: manifest.contentHash || null,
  };
}

async function findVersionDirectory(versionId: string) {
  const root = snapshotRoot();
  let targets: string[];
  try {
    targets = await readdir(root);
  } catch {
    return null;
  }
  for (const segment of targets) {
    if (!VERSION_SEGMENT.test(segment)) continue;
    const directory = path.join(root, segment, safeSegment(versionId));
    try {
      const manifest = await readManifest(directory);
      if (manifest.versionId === versionId) return directory;
    } catch {
      // not in this target
    }
  }
  return null;
}

export async function listVersionRecords(targetId: string): Promise<VersionRecord[]> {
  const directory = path.join(/*turbopackIgnore: true*/ snapshotRoot(), safeSegment(targetId));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }
  const records: VersionRecord[] = [];
  for (const segment of entries) {
    if (!VERSION_SEGMENT.test(segment)) continue;
    const versionDir = path.join(directory, segment);
    try {
      const manifest = await readManifest(versionDir);
      if (manifest.targetId !== targetId) continue;
      records.push({ ...toVersionRecord(manifest, versionDir), definition: await readDefinition(versionDir) });
    } catch {
      // skip unreadable version directory
    }
  }
  return records.sort((a, b) => b.version_number - a.version_number);
}

export async function getVersionRecord(versionId: string): Promise<VersionRecord | null> {
  const directory = await findVersionDirectory(versionId);
  if (!directory) return null;
  const manifest = await readManifest(directory);
  return { ...toVersionRecord(manifest, directory), definition: await readDefinition(directory) };
}

export async function createVersionRecord(input: { targetId: string; versionNumber: number; createdBy: string; definition: OntologyDefinition }): Promise<VersionRecord> {
  const id = randomUUID();
  const directory = versionArtifactDirectory(input.targetId, id);
  const now = new Date().toISOString();
  await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true });
  await atomicWrite(path.join(/*turbopackIgnore: true*/ directory, "definition.json"), `${JSON.stringify(input.definition, null, 2)}\n`);
  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_FORMAT,
    versionId: id,
    targetId: input.targetId,
    versionNumber: input.versionNumber,
    status: "DRAFT",
    createdAt: now,
    createdBy: input.createdBy,
    publishedAt: null,
    entityCount: 0,
    relationshipCount: 0,
    contentHash: "",
    updatedAt: now,
  };
  await writeManifest(directory, manifest);
  return { ...toVersionRecord(manifest, directory), definition: input.definition };
}

export async function updateVersionRecord(versionId: string, patch: { status?: VersionStatus; publishedAt?: string | null }) {
  const directory = await findVersionDirectory(versionId);
  if (!directory) throw new Error("本体版本不存在。");
  const manifest = await readManifest(directory);
  await writeManifest(directory, {
    ...manifest,
    status: patch.status ?? manifest.status,
    publishedAt: patch.publishedAt !== undefined ? patch.publishedAt : manifest.publishedAt,
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteVersionRecord(versionId: string) {
  const directory = await findVersionDirectory(versionId);
  if (!directory) throw new Error("本体版本不存在。");
  await rm(/*turbopackIgnore: true*/ directory, { recursive: true, force: true });
}

export async function deleteTargetVersions(targetId: string) {
  const directory = path.join(/*turbopackIgnore: true*/ snapshotRoot(), safeSegment(targetId));
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  const count = entries.filter((segment) => VERSION_SEGMENT.test(segment)).length;
  await rm(/*turbopackIgnore: true*/ directory, { recursive: true, force: true });
  return count;
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

async function atomicWrite(filePath: string, content: string) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(/*turbopackIgnore: true*/ temporary, content, "utf8");
  await rename(/*turbopackIgnore: true*/ temporary, /*turbopackIgnore: true*/ filePath);
}

async function writeSnapshotFiles(record: VersionRecord, snapshot: VersionSnapshot) {
  const validated: VersionSnapshot = {
    definition: ontologyDefinitionSchema.parse(snapshot.definition),
    nodes: snapshot.nodes.map((node) => nodeSchema.parse(node)),
    relationships: snapshot.relationships.map((relationship) => relationshipSchema.parse(relationship)),
  };
  const directory = versionArtifactDirectory(record.target_id, record.id);
  const files = artifactFiles(directory);
  const content = snapshotContent(validated);
  const previous = await readManifestSafe(directory);
  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_FORMAT,
    versionId: record.id,
    targetId: record.target_id,
    versionNumber: record.version_number,
    status: previous?.status ?? record.status,
    createdAt: previous?.createdAt ?? record.created_at,
    createdBy: previous?.createdBy ?? record.created_by,
    publishedAt: previous?.publishedAt ?? record.published_at,
    entityCount: validated.nodes.length,
    relationshipCount: validated.relationships.length,
    contentHash: content.contentHash,
    updatedAt: new Date().toISOString(),
  };
  await mkdir(/*turbopackIgnore: true*/ directory, { recursive: true });
  await Promise.all([
    atomicWrite(files.definition, content.definition),
    atomicWrite(files.nodes, content.nodes),
    atomicWrite(files.relationships, content.relationships),
  ]);
  await writeManifest(directory, manifest);
  return manifest;
}

function parseProperties(value: string) {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("快照属性列必须是 JSON 对象。");
  return parsed as Record<string, unknown>;
}

async function readSnapshotFiles(record: VersionRecord): Promise<VersionSnapshot> {
  const directory = versionArtifactDirectory(record.target_id, record.id);
  const files = artifactFiles(directory);
  const [definitionText, nodesText, relationshipsText, manifestText] = await Promise.all([
    readFile(/*turbopackIgnore: true*/ files.definition, "utf8"),
    readFile(/*turbopackIgnore: true*/ files.nodes, "utf8"),
    readFile(/*turbopackIgnore: true*/ files.relationships, "utf8"),
    readFile(/*turbopackIgnore: true*/ files.manifest, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SnapshotManifest;
  if (manifest.formatVersion !== SNAPSHOT_FORMAT || manifest.versionId !== record.id || manifest.targetId !== record.target_id) {
    throw new Error("版本快照清单与版本记录不一致。");
  }
  const contentHash = createHash("sha256").update(definitionText).update(nodesText).update(relationshipsText).digest("hex");
  if (contentHash !== manifest.contentHash) throw new Error("版本快照内容校验失败，文件可能已被外部修改。");
  const nodeRows = parse(nodesText, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const relationshipRows = parse(relationshipsText, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  return {
    definition: ontologyDefinitionSchema.parse(JSON.parse(definitionText)),
    nodes: nodeRows.map((item) => nodeSchema.parse({ id: item["node_id:ID"], labels: item[":LABEL"].split(";").filter(Boolean), properties: parseProperties(item.properties) })),
    relationships: relationshipRows.map((item) => relationshipSchema.parse({ id: item["relationship_id:ID"], sourceId: item[":START_ID"], targetId: item[":END_ID"], type: item[":TYPE"], properties: parseProperties(item.properties) })),
  };
}

export async function exportTargetSnapshot(target: GraphTarget, definition: OntologyDefinition): Promise<VersionSnapshot> {
  const exported = await getGraphStore(target).exportGraph();
  const snapshotIds = new Map<string, string>();
  const usedIds = new Set<string>();
  const isUuid = (value: string) => VERSION_SEGMENT.test(value);
  const storedIdOf = (properties: Record<string, unknown>) => (typeof properties[INTERNAL_ID] === "string" ? (properties[INTERNAL_ID] as string) : null);
  /** 后端元素 id -> 快照 UUID。优先保留后端里存的稳定 id，否则按需生成。 */
  const snapshotIdOf = (rawId: string, properties: Record<string, unknown>) => {
    const existing = snapshotIds.get(rawId);
    if (existing) return existing;
    const stored = storedIdOf(properties);
    const preferred = stored && !usedIds.has(stored) ? stored : isUuid(rawId) && !usedIds.has(rawId) ? rawId : randomUUID();
    usedIds.add(preferred);
    snapshotIds.set(rawId, preferred);
    return preferred;
  };
  const nodes = exported.nodes.map((node) => nodeSchema.parse({
    id: snapshotIdOf(node.id, node.properties),
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
  return snapshot.nodes
    .filter((node) => !options.label || node.labels.includes(options.label))
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
    labels: [...labelCounts].map(([name, count]) => ({ name, count, properties: snapshot.definition.entityTypes.find((type) => type.name === name)?.properties })),
    relationshipTypes: [...relationshipCounts].map(([name, count]) => ({ name, count, properties: snapshot.definition.relationshipTypes.find((type) => type.name === name)?.properties })),
    entityCount: snapshot.nodes.length,
    relationshipCount: snapshot.relationships.length,
    relationshipEndpoints,
  };
}

const MAX_INDEXED_VALUE_BYTES = 8191;

export function validateVersionSnapshot(snapshot: VersionSnapshot) {
  const violations: { rule: string; message: string; count: number }[] = [];
  const entityTypes = new Map(snapshot.definition.entityTypes.map((entity) => [entity.name, entity]));
  const relationshipTypes = new Map(snapshot.definition.relationshipTypes.map((relationship) => [relationship.name, relationship]));
  const entityTypesById = new Map(snapshot.definition.entityTypes.map((entity) => [entity.id, entity]));
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const uniqueValues = new Map<string, Set<string>>();
  const oversizedUnique = new Map<string, { typeName: string; propertyName: string; nodes: SnapshotNode[] }>();
  for (const node of snapshot.nodes) {
    const managed = node.labels.filter((label) => entityTypes.has(label));
    if (managed.length !== 1 || managed.length !== node.labels.length) {
      violations.push({ rule: node.id, message: "对象必须且只能使用一个草稿中定义的类。", count: 1 });
      continue;
    }
    const type = entityTypes.get(managed[0])!;
    const businessProperties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
    try { parsePropertyValues(type.properties, businessProperties); } catch (error) {
      violations.push({ rule: `${type.name}:${node.id}`, message: error instanceof Error ? error.message : "对象属性校验失败。", count: 1 });
    }
    for (const property of type.properties.filter((item) => item.unique && node.properties[item.name] != null)) {
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
      violations.push({ rule: `${type.name}:${relationship.id}`, message: "关系端点不符合草稿中的类契约。", count: 1 });
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
    violations.push({ rule: `${entry.typeName}.${entry.propertyName}`, message: `唯一属性「${entry.propertyName}」存在 ${entry.nodes.length} 个超过 Neo4j 索引大小限制（约 ${MAX_INDEXED_VALUE_BYTES} 字节）的值，无法建立唯一约束。涉及：${involved}。请将该属性改为非唯一，或缩短字段内容后重试。`, count: entry.nodes.length });
  }
  return [...violations, ...validateActionDefinition(snapshot.definition)];
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
    if (!type) throw new Error("类未在当前草稿中定义。");
    const node = nodeSchema.parse({ id: randomUUID(), labels: [type.name], properties: parsePropertyValues(type.properties, rawProperties) });
    snapshot.nodes.push(node);
    return entityFromSnapshot(node);
  });
}

export async function updateSnapshotEntity(versionId: string, entityId: string, rawProperties: Record<string, unknown>) {
  return mutateDraftSnapshot(versionId, (snapshot) => {
    const node = snapshot.nodes.find((item) => item.id === entityId);
    if (!node) return null;
    const type = snapshot.definition.entityTypes.find((item) => node.labels.includes(item.name));
    if (!type) throw new Error("类未在当前草稿中定义。");
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
