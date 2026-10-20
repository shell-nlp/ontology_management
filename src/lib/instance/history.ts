import { randomUUID } from "node:crypto";
import { In, MoreThan } from "typeorm";
import { getHistoryStore } from "@/lib/infrastructure/history";
import { InstanceHistoryEntity, InstanceHistoryChunkEntity, jsonValue, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { createDataSourceObjectSource } from "@/lib/instance/object-service/data-source";
import { resolveObjectContext } from "@/lib/instance/object-service";

const holder = globalThis as typeof globalThis & { __historyJobs?: Map<string, boolean> };
const active = holder.__historyJobs ??= new Map();
const boundary = "显式采集区间快照；源表跨页、跨类型不承诺同一事务时点。只冻结源对象投影，不含人工编辑覆盖。";
const view = (row: InstanceHistoryEntity) => ({ id: row.id, targetId: row.targetId, versionId: row.versionId, entityTypes: row.entityTypes, status: row.status, rows: Number(row.rows), pages: row.pages, message: row.message, createdAt: row.createdAt, finishedAt: row.finishedAt });

export async function listInstanceHistory(targetId: string) {
  const repo = await platformRepo(InstanceHistoryEntity);
  const interrupted = await repo.find({ where: { targetId, status: In(["QUEUED", "RUNNING", "CANCELLING"]) } });
  for (const row of interrupted) if (!active.has(row.id)) await repo.update(row.id, { status: "INTERRUPTED", message: "服务已重启，重新采集后才能查询完整历史。", finishedAt: new Date() });
  return (await repo.find({ where: { targetId }, order: { createdAt: "DESC" }, take: 100 })).map(view);
}

export async function captureInstanceHistory(targetId: string, versionId: string | undefined, names: string[]) {
  const context = await resolveObjectContext(targetId, versionId);
  const chosen = [...new Set(names)];
  if (!chosen.length) throw new Error("请选择要采集的对象类型。");
  for (const name of chosen) {
    const type = context.definition.entityTypes.find((entity) => entity.name === name);
    if (!type?.sources[0]?.dataSourceId || !type.sources[0].primaryKey.length) throw new Error(`「${name}」需要绑定来源及完整主键后才能采集。`);
  }
  const repo = await platformRepo(InstanceHistoryEntity);
  const row = repo.create({ id: randomUUID(), targetId, versionId: context.versionId!, definition: jsonValue(context.definition), entityTypes: jsonValue(chosen), status: "QUEUED", rows: "0", pages: 0, message: boundary, createdAt: new Date(), finishedAt: null });
  active.set(row.id, false);
  await repo.save(row);
  void (async () => {
    try {
      row.status = "RUNNING"; await repo.save(row);
      const source = createDataSourceObjectSource();
      const store = getHistoryStore();
      for (const name of chosen) {
        const type = context.definition.entityTypes.find((entity) => entity.name === name)!;
        const columns = type.sources[0].primaryKey;
        let scanned = 0;
        let total: number | null = null;
        let values: unknown[] | undefined;
        for (;;) {
          if (active.get(row.id)) throw new Error("CANCELLED");
          const page = await source.query(context.definition, name, { entityType: name, limit: 500, cursor: { columns, values }, count: scanned === 0, paging: true });
          if (scanned === 0) total = page.total;
          const seen = new Set<string>();
          for (const item of page.rows) {
            if (!item.objectId || seen.has(item.objectId)) throw new Error(`「${name}」源主键不完整或不唯一，拒绝静默折叠历史行。请修正主键或配置去重口径。`);
            seen.add(item.objectId);
          }
          if (page.rows.length) {
            await store.write(row.id, row.pages, name, page.rows);
            scanned += page.rows.length; row.rows = String(Number(row.rows) + page.rows.length); row.pages += 1;
            if (active.get(row.id)) row.status = "CANCELLING";
            await repo.save(row);
          }
          if (page.rows.length < page.limit) break;
          const last = page.rows.at(-1)!;
          const next = columns.map((column) => last.primaryKey[column]);
          if (values && JSON.stringify(values) === JSON.stringify(next)) throw new Error("历史采集分页未前进，已停止。");
          values = next;
        }
        if (total !== null && scanned !== total) throw new Error(`「${name}」源报告 ${total} 行、只采集 ${scanned} 行；可能主键重复或采集中源数据变更，拒绝发布不完整历史。`);
      }
      if (active.get(row.id)) throw new Error("CANCELLED");
      row.status = "DONE"; row.message = boundary;
    } catch (error) {
      row.status = error instanceof Error && error.message === "CANCELLED" ? "CANCELLED" : "FAILED";
      row.message = error instanceof Error ? error.message : String(error);
    } finally { row.finishedAt = new Date(); await repo.save(row); active.delete(row.id); }
  })();
  return view(row);
}

async function requireHistory(id: string, targetId: string) {
  const row = await (await platformRepo(InstanceHistoryEntity)).findOne({ where: { id, targetId } });
  if (!row) throw new Error("历史快照不存在或不属于当前本体。");
  return row;
}

export async function readInstanceHistory(id: string, targetId: string, options: { entityType?: string; offset?: number; limit?: number; warm?: boolean } = {}) {
  const row = await requireHistory(id, targetId);
  if (row.status !== "DONE") throw new Error("历史采集尚未完整完成，不能当作历史数据查询。");
  const limit = Math.min(200, Math.max(1, options.limit ?? 20));
  let skip = Math.max(0, options.offset ?? 0);
  const repo = await platformRepo(InstanceHistoryChunkEntity);
  // Only page metadata is read first; compressed payloads are fetched one at a time.
  const where = { snapshotId: id, ...(options.entityType ? { entityType: options.entityType } : {}) };
  const total = Number(await repo.sum("rows", where) ?? 0);
  const rows = [];
  let lastPage = -1;
  while (rows.length < limit) {
    const chunks = await repo.find({ where: { ...where, page: MoreThan(lastPage) }, select: { page: true, rows: true }, order: { page: "ASC" }, take: 100 });
    if (!chunks.length) break;
    for (const chunk of chunks) {
      lastPage = chunk.page;
      if (skip >= chunk.rows) { skip -= chunk.rows; continue; }
      const decoded = await getHistoryStore().read(id, chunk.page);
      rows.push(...decoded.slice(skip, skip + limit - rows.length)); skip = 0;
      if (rows.length >= limit) break;
    }
  }
  return { snapshot: view(row), definition: ontologyDefinitionSchema.parse(row.definition), rows, total, warnings: [boundary], warmed: Boolean(options.warm) };
}

export async function deleteOrCancelInstanceHistory(id: string, targetId: string) {
  const row = await requireHistory(id, targetId);
  if (active.has(id)) { active.set(id, true); await (await platformRepo(InstanceHistoryEntity)).update(id, { status: "CANCELLING", message: "取消中，当前源页结束后停止。" }); return { cancelled: true, deleted: false }; }
  getHistoryStore().evict(id);
  await (await platformRepo(InstanceHistoryEntity)).delete({ id, targetId });
  return { cancelled: false, deleted: true };
}
