import { readVersionSnapshot, listVersionRecords, type VersionSnapshot } from "@/lib/versioning/snapshot";
import { changedProperties, overlayObjectProperties } from "@/lib/ontology/object-edits";
import { primaryKeyFromProperties, objectRefOf } from "@/lib/ontology/object-identity";
import { titleOf } from "./data-source";
import type { ObjectContext, ObjectQuery, ObjectQueryResult, ObjectRecord } from "./types";
import type { LogicalPlan } from "@/lib/query-dsl/ast";

export async function readEditSnapshot(context: ObjectContext): Promise<VersionSnapshot | null> {
  const versionId = context.versionId ?? (await listVersionRecords(context.targetId)).find((version) => version.status === "PUBLISHED")?.id;
  if (!versionId) return null;
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
  const snapshot = await readEditSnapshot(context);
  if (!snapshot) return;
  const ids = new Set([...plan.entities.values()].map((entity) => entity.entityTypeId));
  for (const [id, edit] of Object.entries(snapshot.objectEdits ?? {})) {
    if (!ids.has(edit.entityTypeId)) continue;
    const node = snapshot.nodes.find((item) => item.id === id);
    if (edit.deleted || edit.base === null || Object.keys(changedProperties(edit.base, node?.properties ?? {})).length) {
      throw new Error("查询涉及尚未写回源业务库的版本编辑。为避免遗漏本地对象或使用旧值统计，本体 SQL 暂停出数；请先通过动作写回并同步 ODS，或按主键查看合并对象。");
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
  if ((query.text && touched.size) || dependent.some((name) => touched.has(name))) {
    throw new Error("本次筛选或排序涉及当前版本覆盖修改的属性，源数据下推不能保证结果完整。请先通过动作写回业务库，再同步 ODS；或按主键查看编辑后的对象。");
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
