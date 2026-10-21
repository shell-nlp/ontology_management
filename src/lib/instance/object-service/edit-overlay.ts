import { getVersionRecord, readVersionSnapshot, listVersionRecords, type VersionSnapshot } from "@/lib/versioning/snapshot";
import { changedProperties, overlayObjectProperties } from "@/lib/ontology/object-edits";
import { primaryKeyFromProperties, objectRefOf } from "@/lib/ontology/object-identity";
import { titleOf } from "./data-source";
import type { ObjectContext, ObjectQuery, ObjectQueryResult, ObjectRecord } from "./types";
import type { LogicalPlan } from "@/lib/query-dsl/ast";
import { getOdsStore } from "@/lib/infrastructure/ods";
import { snapshotFromVersionChanges } from "@/lib/instance/ods/published-changes";

export async function readEditSnapshot(context: ObjectContext): Promise<VersionSnapshot | null> {
  let versionId = context.versionId;
  if (versionId) {
    const explicit = await getVersionRecord(versionId);
    if (!explicit) return null;
    if (explicit.status === "DRAFT") return readVersionSnapshot(versionId);
  } else {
    versionId = (await listVersionRecords(context.targetId)).find((version) => version.status === "PUBLISHED")?.id ?? null;
  }
  if (!versionId) return null;
  try {
    const changes = await getOdsStore().readVersionChanges(versionId);
    if (changes.objects.length || changes.relationships.length) {
      return snapshotFromVersionChanges(context.definition, changes);
    }
  } catch {
    // 兼容尚未升级到发布变更集的旧部署；发布覆盖层清空后这里会自然返回空快照。
  }
  return readVersionSnapshot(versionId);
}

export function applyObjectEdit(context: ObjectContext, snapshot: VersionSnapshot | null, record: ObjectRecord | null, entityTypeName: string, objectId: string): ObjectRecord | null {
  const type = context.definition.entityTypes.find((item) => item.name === entityTypeName);
  if (!type || !snapshot) return record;
  const edit = snapshot.objectEdits?.[objectId];
  const node = snapshot.nodes.find((item) => item.id === objectId && item.labels.includes(entityTypeName));
  if (edit?.deleted) return null;
  if (!node) return record;
  if (edit && edit.entityTypeId !== type.id) return record;
  if (record && edit?.base) {
    const properties = overlayObjectProperties(context.definition, type.id, record.properties, edit.base, node.properties);
    return { ...record, editMode: "OVERRIDE", properties, title: titleOf(type, properties, record.primaryKey), warnings: [...record.warnings, "已合并当前版本的对象编辑；未改属性仍读取当前源数据。"] };
  }
  if (!edit || edit.base === null) {
    const properties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => type.properties.some((property) => property.name === key)));
    const primaryKey = primaryKeyFromProperties(type, properties).primaryKey;
    return { objectId: node.id, entityType: type.name, properties, primaryKey, objectRef: objectRefOf(type.name, primaryKey), title: titleOf(type, properties, primaryKey), origin: "source", editMode: "LOCAL", warnings: ["当前版本创建的本地对象，尚未写入源业务库。"] };
  }
  return record;
}

export async function assertQueryEditConsistency(context: ObjectContext, plan: LogicalPlan) {
  // 发布版本的稀疏变更已经由 ClickHouse 查询层合并；这里只对显式草稿版本做一致性检查。
  if (!context.versionId) return;
  const snapshot = await readEditSnapshot(context);
  if (!snapshot) return;
  const ids = new Set([...plan.entities.values()].map((entity) => entity.entityTypeId));
  for (const [id, edit] of Object.entries(snapshot.objectEdits ?? {})) {
    if (!ids.has(edit.entityTypeId)) continue;
    const node = snapshot.nodes.find((item) => item.id === id);
    if (edit.deleted || edit.base === null || Object.keys(changedProperties(edit.base, node?.properties ?? {})).length) {
      throw new Error("草稿查询涉及尚未进入 ODS 的本地编辑。请先发布版本到 ODS，或按主键查看合并对象。");
    }
  }
}

export async function queryWithEdits(context: ObjectContext, query: ObjectQuery, execute: (query: ObjectQuery) => Promise<ObjectQueryResult>): Promise<ObjectQueryResult> {
  const snapshot = await readEditSnapshot(context);
  const type = context.definition.entityTypes.find((item) => item.name === query.entityType);
  if (!snapshot || !type) return execute(query);
  const edits = Object.entries(snapshot.objectEdits ?? {}).filter(([, edit]) => edit.entityTypeId === type.id);
  const localNodes = snapshot.nodes.filter((node) => node.labels.includes(type.name) && !snapshot.objectEdits?.[node.id]?.deleted && (!snapshot.objectEdits?.[node.id] || snapshot.objectEdits[node.id].base === null));
  const touched = new Set<string>();
  for (const [id, edit] of edits) {
    if (!edit.base) continue;
    const node = snapshot.nodes.find((item) => item.id === id);
    for (const name of Object.keys(changedProperties(edit.base, node?.properties ?? {}))) touched.add(name);
  }
  if (query.paging) return execute(query); // materialization copies the source, never version edits
  const dependent = [...(query.filters ?? []).map((filter) => filter.property), ...(query.sort ?? []).map((sort) => sort.property)];
  if (dependent.some((name) => touched.has(name))) {
    throw new Error("草稿预览的筛选或排序涉及本地覆盖属性，暂时不能安全下推。发布后由 ODS 版本变更集查询，或按主键查看合并对象。");
  }
  if (query.keys?.length) {
    const result = await execute(query);
    const ids = new Set(result.rows.map((row) => row.objectId));
    for (const node of localNodes) {
      const local = applyObjectEdit(context, snapshot, null, type.name, node.id);
      if (local && !ids.has(node.id) && query.keys.some((key) => Object.entries(key).every(([column, value]) => local.primaryKey[column] === value))) result.rows.push(local);
    }
    result.rows = result.rows.map((row) => applyObjectEdit(context, snapshot, row, type.name, row.objectId)).filter((row): row is ObjectRecord => Boolean(row));
    return { ...result, total: result.rows.length };
  }
  if (query.text && touched.size && snapshot.publishedChanges) {
    const needle = query.text.toLowerCase();
    const matches = (record: ObjectRecord) => Object.values(record.properties).some((value) => String(value ?? "").toLowerCase().includes(needle));
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const source = await execute({ ...query, limit, offset: 0, count: false });
    const merged = new Map<string, ObjectRecord>();
    for (const row of source.rows) {
      const edited = applyObjectEdit(context, snapshot, row, type.name, row.objectId);
      if (edited && matches(edited)) merged.set(edited.objectId, edited);
    }
    for (const [, edit] of edits) {
      if (!edit.base || edit.deleted) continue;
      const page = await execute({ ...query, text: undefined, keys: [edit.primaryKey], limit: 1, offset: 0, count: false });
      for (const row of page.rows) {
        const edited = applyObjectEdit(context, snapshot, row, type.name, row.objectId);
        if (edited && matches(edited)) merged.set(edited.objectId, edited);
      }
    }
    for (const node of localNodes) {
      const local = applyObjectEdit(context, snapshot, null, type.name, node.id);
      if (local && matches(local)) merged.set(local.objectId, local);
    }
    return {
      ...source,
      rows: [...merged.values()].slice(0, limit),
      total: null,
      warnings: [...source.warnings, "搜索结果已合并当前发布版本的本地 CRUD；总数不提供精确值。"],
    };
  }
  if (query.text && touched.size) {
    throw new Error("草稿预览的关键词检索涉及本地覆盖属性，暂时不能安全下推。发布后由 ODS 版本变更集查询，或按主键查看合并对象。");
  }
  // Avoid inventing a merged aggregate or a global sort across databases and local edits.
  if (localNodes.length && (query.filters?.length || query.sort?.length)) {
    throw new Error("当前版本包含本地新建对象，跨源筛选和排序尚不能保证全量口径。请按主键查询，或移除筛选查看合并列表。");
  }
  const limit = Math.min(200, Math.max(1, query.limit ?? 20));
  const offset = Math.max(0, query.offset ?? 0);
  const matchingLocals = localNodes.filter((node) => !query.text || Object.values(node.properties).some((value) => String(value ?? "").toLowerCase().includes(query.text!.toLowerCase())));
  const locals = matchingLocals.slice(offset, offset + limit).map((node) => applyObjectEdit(context, snapshot, null, type.name, node.id)).filter((row): row is ObjectRecord => Boolean(row));
  const result = locals.length === limit
    ? { entityType: type.name, rows: [], total: null, origin: "none" as const, warnings: [], tookMs: 0 }
    : await execute({ ...query, offset: Math.max(0, offset - matchingLocals.length), limit: limit - locals.length });
  const rows = result.rows.map((row) => applyObjectEdit(context, snapshot, row, type.name, row.objectId)).filter((row): row is ObjectRecord => Boolean(row));
  const deleted = edits.some(([, edit]) => edit.deleted);
  return { ...result, rows: [...locals, ...rows], total: deleted ? null : result.total === null ? null : result.total + matchingLocals.length, warnings: [...result.warnings, ...(deleted ? ["当前版本隐藏了部分源对象；总数未作跨源精确统计，当前页可能少于页大小。"] : [])] };
}
