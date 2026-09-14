import { platformQuery } from "@/lib/platform-db";
import type { GraphTarget } from "@/lib/graph/types";
import { getTarget, listTargets, parseTargetOptions } from "@/lib/targets";
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

async function uniqueIdentifier(base: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await platformQuery<{ id: string }>("SELECT id FROM ontology_platform.ontologies WHERE identifier = $1", [candidate]);
    if (!existing.rows.length) return candidate;
  }
  throw new Error("无法生成本体标识，请换一个名称。");
}

export async function listOntologies(): Promise<Ontology[]> {
  const result = await platformQuery<Ontology>(
    `SELECT id, identifier, name, description, color, tags, target_id, owner_target_id, namespace, created_by, created_at, updated_at
       FROM ontology_platform.ontologies
      ORDER BY updated_at DESC`,
  );
  return result.rows;
}

export async function getOntology(id: string): Promise<Ontology | null> {
  const result = await platformQuery<Ontology>(
    `SELECT id, identifier, name, description, color, tags, target_id, owner_target_id, namespace, created_by, created_at, updated_at
       FROM ontology_platform.ontologies WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getOntologyByTargetId(targetId: string): Promise<Ontology | null> {
  const result = await platformQuery<Ontology>(
    `SELECT id, identifier, name, description, color, tags, target_id, owner_target_id, namespace, created_by, created_at, updated_at
       FROM ontology_platform.ontologies WHERE target_id = $1`,
    [targetId],
  );
  return result.rows[0] ?? null;
}

/** 受管存储记录：只在「存储资源」页归到某个资源下面显示，不当作独立资源让用户去选。 */
async function createManagedTarget(storage: GraphTarget, ontologyId: string, name: string, namespace: string) {
  const taken = await platformQuery<{ id: string }>("SELECT id FROM ontology_platform.graph_targets WHERE name = $1", [name]);
  const targetName = taken.rows.length ? `${name} · ${ontologyId.slice(0, 4)}` : name;
  const id = crypto.randomUUID();
  const options = { ...parseTargetOptions(storage.options), namedGraph: namespace };
  await platformQuery(
    `INSERT INTO ontology_platform.graph_targets (id, name, kind, uri, database_name, username, credential_secret, options)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, targetName, storage.kind, storage.uri, storage.database_name, storage.username, storage.credential_secret, JSON.stringify(options)],
  );
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
  await platformQuery(
    `INSERT INTO ontology_platform.ontologies
       (id, identifier, name, description, color, tags, target_id, owner_target_id, namespace, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      identifier,
      name,
      (input.description ?? "").trim(),
      (input.color ?? "").trim(),
      input.tags ?? [],
      targetId,
      storage.id,
      namespace,
      userId ?? null,
    ],
  );
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
  const updates: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("本体名称不能为空。");
    updates.push(`name = $${updates.length + 1}`);
    values.push(name);
  }
  if (patch.description !== undefined) {
    updates.push(`description = $${updates.length + 1}`);
    values.push(patch.description.trim());
  }
  if (patch.color !== undefined) {
    updates.push(`color = $${updates.length + 1}`);
    values.push(patch.color.trim());
  }
  if (patch.tags !== undefined) {
    updates.push(`tags = $${updates.length + 1}`);
    values.push(patch.tags);
  }
  if (!updates.length) return current;
  values.push(id);
  await platformQuery(`UPDATE ontology_platform.ontologies SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${values.length}`, values);

  // 本体改名时，受管存储记录跟着改（它只是这段隔离空间的载体，名字应该和本体一致）。
  if (patch.name !== undefined && current.owner_target_id) {
    await platformQuery("UPDATE ontology_platform.graph_targets SET name = $1 WHERE id = $2", [patch.name.trim(), current.target_id]);
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
  await platformQuery("DELETE FROM ontology_platform.ontologies WHERE id = $1", [id]);
  if (!current.owner_target_id) return { removedTargetId: null };
  await platformQuery("DELETE FROM ontology_platform.graph_targets WHERE id = $1", [current.target_id]);
  await removeTargetSnapshotDirectory(current.target_id);
  return { removedTargetId: current.target_id };
}

/**
 * 迁移：给还没有本体的存储记录补一个默认本体，名字取原本体存储名。
 * 幂等——每次启动跑一遍，已经有的不动。
 */
export async function ensureDefaultOntologies(): Promise<number> {
  const targets = await listTargets();
  if (!targets.length) return 0;
  const claimed = await platformQuery<{ target_id: string }>("SELECT target_id FROM ontology_platform.ontologies");
  const taken = new Set(claimed.rows.map((row) => row.target_id));
  let created = 0;
  for (const target of targets) {
    if (taken.has(target.id)) continue;
    const identifier = await uniqueIdentifier(slugify(target.name, target.id));
    const namespace = target.kind === "JENA" ? String(target.options?.namedGraph ?? "") || null : null;
    await platformQuery(
      `INSERT INTO ontology_platform.ontologies (id, identifier, name, description, color, tags, target_id, owner_target_id, namespace)
       VALUES ($1, $2, $3, '', '', '{}'::text[], $4, NULL, $5)
       ON CONFLICT (target_id) DO NOTHING`,
      [crypto.randomUUID(), identifier, target.name, target.id, namespace],
    );
    created += 1;
  }
  return created;
}

let migration: Promise<number> | undefined;

/** 每个进程跑一次就够；失败的 promise 不留在缓存里，下次请求还能重试。 */
export function ensureOntologyMigration() {
  migration ??= ensureDefaultOntologies().catch((error) => {
    migration = undefined;
    throw error;
  });
  return migration;
}
