import { jsonValue, platformRepo, OntologyEntity, GraphTargetEntity } from "@/lib/db";
import { BUILTIN_EMBEDDED_TARGET_ID, type GraphTarget } from "@/lib/graph/types";
import { getTarget, parseTargetOptions } from "@/lib/targets";
import { removeTargetSnapshotDirectory } from "@/lib/version-snapshot";

/**
 * 本体：平台的隔离单位。
 *
 * 一个本体占一份图数据（`target_id` 唯一），所以隔离不再要求用户去理解
 * 「数据集 / 命名图」——建本体时只挑一个存储资源，剩下的由这里分配：
 * - Apache Jena：在这个 Fuseki 上另开一条受管记录，命名图取 `urn:ontology:<id>`，
 *   同一个 Fuseki 可以承载任意多个本体；
 * - 隔离由命名图承担，所以同一个 Fuseki 上可以并存任意多个本体。
 */
export type Ontology = {
  id: string;
  identifier: string;
  name: string;
  description: string;
  color: string;
  tags: string[];
  /** 这份本体实际写入的图存储记录。 */
  target_id: string;
  /** 用户当初挑的存储资源；受管记录靠它归组。 */
  owner_target_id: string | null;
  namespace: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/** 标识符：给 URL 与导出用。中文名字取不出字母，就退回 id 前 8 位。 */
function slugify(value: string, fallback: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `ontology-${fallback.slice(0, 8)}`;
}

/** 实体 -> 领域记录（本体沿用 snake_case 口径）。 */
function toOntology(row: OntologyEntity): Ontology {
  return {
    id: row.id,
    identifier: row.identifier,
    name: row.name,
    description: row.description,
    color: row.color,
    tags: row.tags ?? [],
    target_id: row.targetId,
    owner_target_id: row.ownerTargetId,
    namespace: row.namespace,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function uniqueIdentifier(base: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const repo = await platformRepo(OntologyEntity);
    const existing = await repo.findOne({ where: { identifier: candidate }, select: { id: true } });
    if (!existing) return candidate;
  }
  throw new Error("无法生成本体标识，请换一个名称。");
}

export async function listOntologies(): Promise<Ontology[]> {
  const repo = await platformRepo(OntologyEntity);
  const rows = await repo.find({ order: { updatedAt: "DESC" } });
  return rows.map(toOntology);
}

export async function getOntology(id: string): Promise<Ontology | null> {
  const repo = await platformRepo(OntologyEntity);
  const row = await repo.findOne({ where: { id } });
  return row ? toOntology(row) : null;
}

export async function getOntologyByTargetId(targetId: string): Promise<Ontology | null> {
  const repo = await platformRepo(OntologyEntity);
  const row = await repo.findOne({ where: { targetId } });
  return row ? toOntology(row) : null;
}

/** 受管存储记录：只在「存储资源」页归到某个资源下面显示，不当作独立资源让用户去选。 */
async function createManagedTarget(storage: GraphTarget, ontologyId: string, name: string, namespace: string) {
  const repo = await platformRepo(GraphTargetEntity);
  const taken = await repo.findOne({ where: { name }, select: { id: true } });
  const targetName = taken ? `${name} · ${ontologyId.slice(0, 4)}` : name;
  const id = crypto.randomUUID();
  const options: Record<string, unknown> = { ...parseTargetOptions(storage.options), namedGraph: namespace };
  delete options.builtin;
  await repo.insert({
    id,
    name: targetName,
    kind: storage.kind,
    uri: storage.uri,
    databaseName: storage.database_name,
    username: storage.username,
    credentialSecret: storage.credential_secret,
    options: jsonValue(options),
  });
  return id;
}

export async function createOntology(
  input: { name: string; description?: string; color?: string; tags?: string[]; storageTargetId: string; identifier?: string },
  userId?: string,
): Promise<Ontology> {
  const name = input.name.trim();
  if (!name) throw new Error("请填写本体名称。");
  const storage = await getTarget(input.storageTargetId);
  if (!storage) throw new Error("存储资源不存在。");

  const id = crypto.randomUUID();
  // 每个本体独占一个命名图（urn:ontology:<id>），这就是多本体隔离的单位：
  // 同一个 Fuseki 数据集上可以并存任意多个本体，不必各起一套实例。
  const namespace = `urn:ontology:${id}`;
  const targetId = await createManagedTarget(storage, id, name, namespace);

  // 导入本体包时希望能沿用包里的标识；被占了就自动往后加序号，不因为重名而失败。
  const identifier = await uniqueIdentifier(slugify(input.identifier?.trim() || name, id));
  const repo = await platformRepo(OntologyEntity);
  await repo.insert({
    id,
    identifier,
    name,
    description: (input.description ?? "").trim(),
    color: (input.color ?? "").trim(),
    tags: input.tags ?? [],
    targetId,
    ownerTargetId: storage.id === BUILTIN_EMBEDDED_TARGET_ID ? null : storage.id,
    namespace,
    createdBy: userId ?? null,
  });
  const created = await getOntology(id);
  if (!created) throw new Error("本体创建失败。");
  return created;
}

export async function updateOntology(
  id: string,
  patch: { name?: string; description?: string; color?: string; tags?: string[] },
): Promise<Ontology> {
  const current = await getOntology(id);
  if (!current) throw new Error("本体不存在。");
  const changes: Partial<OntologyEntity> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("本体名称不能为空。");
    changes.name = name;
  }
  if (patch.description !== undefined) changes.description = patch.description.trim();
  if (patch.color !== undefined) changes.color = patch.color.trim();
  if (patch.tags !== undefined) changes.tags = patch.tags;
  if (!Object.keys(changes).length) return current;
  const repo = await platformRepo(OntologyEntity);
  await repo.update({ id }, { ...changes, updatedAt: new Date() });

  // 本体改名时，受管存储记录跟着改（它只是这段隔离空间的载体，名字应该和本体一致）。
  if (patch.name !== undefined && await managedTargetId(current)) {
    const targets = await platformRepo(GraphTargetEntity);
    await targets.update({ id: current.target_id }, { name: patch.name.trim() });
  }
  const updated = await getOntology(id);
  if (!updated) throw new Error("本体不存在。");
  return updated;
}

/**
 * 删本体。受管存储记录是它专用的隔离空间（一个命名图），跟着一起删。
 */
export async function deleteOntology(id: string): Promise<{ removedTargetId: string | null }> {
  const current = await getOntology(id);
  if (!current) throw new Error("本体不存在。");
  const managedId = await managedTargetId(current);
  const repo = await platformRepo(OntologyEntity);
  await repo.delete({ id });
  if (!managedId) return { removedTargetId: null };
  const targets = await platformRepo(GraphTargetEntity);
  await targets.delete({ id: managedId });
  await removeTargetSnapshotDirectory(managedId);
  return { removedTargetId: managedId };
}

/** 虚拟根资源没有 FK 行；仍通过每个本体专属的 namedGraph 标识识别受管目标。 */
async function managedTargetId(ontology: Ontology): Promise<string | null> {
  if (ontology.owner_target_id) return ontology.target_id;
  if (!ontology.namespace) return null;
  const target = await getTarget(ontology.target_id);
  return target?.kind === "EMBEDDED" && target.options?.namedGraph === ontology.namespace ? target.id : null;
}
