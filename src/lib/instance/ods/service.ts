import { randomUUID } from "node:crypto";
import { In } from "typeorm";
import { getDataSource, openDataSource } from "@/lib/datasource/sources";
import type { DataSourceRowFilter, DataSourceRowQuery, DataViewField } from "@/lib/datasource/types";
import { getOdsStore, odsStorageType, odsStorageTable, type OdsColumn, type OdsTableSpec } from "@/lib/infrastructure/ods";
import { OdsSourceEntity, OdsSyncJobEntity, jsonValue, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import { withAdvisoryLock, writeAuditEntry } from "@/lib/platform/platform-db";

export type OdsSyncMode = "FULL" | "INCREMENTAL";
export type OdsStatus = "NEVER" | "RUNNING" | "READY" | "FAILED" | "STALE";
export type OdsJobStatus = "QUEUED" | "RUNNING" | "CANCELLING" | "DONE" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export type OdsSourceView = {
  id: string;
  dataSourceId: string;
  dataSourceName: string;
  schemaName: string;
  tableName: string;
  tableKind: string;
  columns: OdsColumn[];
  primaryKeyColumns: string[];
  watermarkColumn: string;
  syncMode: OdsSyncMode;
  enabled: boolean;
  chTable: string;
  status: OdsStatus;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  autoReconcileHours: number;
  nextReconcileAt: string | null;
  lastSyncJobId: string | null;
  rowCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OdsSyncJobView = {
  id: string;
  sourceId: string;
  status: OdsJobStatus;
  mode: OdsSyncMode;
  scanned: number;
  rows: number;
  pages: number;
  total: number | null;
  truncated: boolean;
  message: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type OdsConfigInput = {
  dataSourceId: string;
  schema: string;
  table: string;
  tableKind?: string;
  columns?: string[];
  primaryKeyColumns?: string[];
  watermarkColumn?: string;
  syncMode?: OdsSyncMode;
  enabled?: boolean;
  autoReconcileHours?: number;
};

type RunnerState = { queue: string[]; running: boolean; recovered: boolean; activeJobId: string | null; cancelRequested: Set<string>; schedulerStarted: boolean };

export function isOdsReconcileDue(source: Pick<OdsSourceEntity, "enabled" | "autoReconcileHours" | "nextReconcileAt">, now = new Date()) {
  return source.enabled
    && source.autoReconcileHours > 0
    && (!source.nextReconcileAt || source.nextReconcileAt.getTime() <= now.getTime());
}

function runnerState(): RunnerState {
  const holder = globalThis as typeof globalThis & { __ontologyOdsRunner?: RunnerState };
  holder.__ontologyOdsRunner ??= { queue: [], running: false, recovered: false, activeJobId: null, cancelRequested: new Set(), schedulerStarted: false };
  return holder.__ontologyOdsRunner;
}

function columnsOf(value: unknown, fallback: OdsColumn[]): OdsColumn[] {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      name: String(row.name ?? "").trim(),
      sourceType: String(row.sourceType ?? "").trim(),
      clickhouseType: String(row.clickhouseType ?? "String").trim(),
      nullable: Boolean(row.nullable),
      primaryKey: Boolean(row.primaryKey),
      comment: String(row.comment ?? ""),
    };
  }).filter((column) => column.name && column.clickhouseType);
}

function primaryKeysOf(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback;
  return value.map((item) => String(item ?? "").trim()).filter(Boolean);
}

function toSource(row: OdsSourceEntity, dataSourceName = ""): OdsSourceView {
  const columns = columnsOf(row.columns, []);
  return {
    id: row.id,
    dataSourceId: row.dataSourceId,
    dataSourceName,
    schemaName: row.schemaName,
    tableName: row.tableName,
    tableKind: row.tableKind,
    columns,
    primaryKeyColumns: primaryKeysOf(row.primaryKeyColumns, columns.filter((column) => column.primaryKey).map((column) => column.name)),
    watermarkColumn: row.watermarkColumn,
    syncMode: row.syncMode === "INCREMENTAL" ? "INCREMENTAL" : "FULL",
    enabled: row.enabled,
    chTable: row.chTable,
    status: ["NEVER", "RUNNING", "READY", "FAILED", "STALE"].includes(row.status) ? row.status as OdsStatus : "FAILED",
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastFullSyncAt: row.lastFullSyncAt?.toISOString() ?? null,
    autoReconcileHours: Number(row.autoReconcileHours ?? 24),
    nextReconcileAt: row.nextReconcileAt?.toISOString() ?? null,
    lastSyncJobId: row.lastSyncJobId,
    rowCount: Number(row.rowCount ?? 0),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toJob(row: OdsSyncJobEntity): OdsSyncJobView {
  return {
    id: row.id,
    sourceId: row.sourceId,
    status: ["QUEUED", "RUNNING", "CANCELLING", "DONE", "FAILED", "CANCELLED", "INTERRUPTED"].includes(row.status) ? row.status as OdsJobStatus : "FAILED",
    mode: row.mode === "INCREMENTAL" ? "INCREMENTAL" : "FULL",
    scanned: Number(row.scanned ?? 0),
    rows: Number(row.rows ?? 0),
    pages: Number(row.pages ?? 0),
    total: row.total === null ? null : Number(row.total),
    truncated: row.truncated,
    message: row.message,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

async function mapSourceNames(rows: OdsSourceEntity[]) {
  const ids = [...new Set(rows.map((row) => row.dataSourceId))];
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, (await getDataSource(id).catch(() => null))?.name ?? "");
  return rows.map((row) => toSource(row, names.get(row.dataSourceId) ?? ""));
}

export async function listOdsSources(): Promise<OdsSourceView[]> {
  ensureOdsReconcileScheduler();
  const repo = await platformRepo(OdsSourceEntity);
  return mapSourceNames(await repo.find({ order: { updatedAt: "DESC" } }));
}

export async function getOdsSource(id: string): Promise<OdsSourceView | null> {
  const repo = await platformRepo(OdsSourceEntity);
  const row = await repo.findOne({ where: { id } });
  return row ? (await mapSourceNames([row]))[0] : null;
}

async function fieldsFor(input: Pick<OdsConfigInput, "dataSourceId" | "schema" | "table">) {
  const source = await getDataSource(input.dataSourceId);
  if (!source) throw new Error("数据资源不存在。");
  if (!source.enabled) throw new Error(`数据资源「${source.name}」已停用。`);
  const connector = await openDataSource(source);
  const fields = await connector.describeView({ schema: input.schema || undefined, name: input.table });
  if (!fields.length) throw new Error(`表或视图「${input.schema ? `${input.schema}.` : ""}${input.table}」没有可读字段。`);
  return { source, fields };
}

export async function saveOdsSource(input: OdsConfigInput, user: { id: string }): Promise<OdsSourceView> {
  const { source, fields } = await fieldsFor(input);
  const selected = new Set((input.columns?.length ? input.columns : fields.map((field) => field.name)).map((name) => name.trim()).filter(Boolean));
  const chosen: DataViewField[] = fields.filter((field) => selected.has(field.name));
  const reserved = new Set(["_source_id", "_row_key", "_source_updated_at", "_sync_batch", "_is_deleted"]);
  if (chosen.some((field) => reserved.has(field.name.toLowerCase()))) throw new Error("源列与 ODS 内部列重名，请通过源视图为这些业务列改名后同步。");
  if (!chosen.length) throw new Error("至少要选择一列同步到 ODS。");
  const missing = [...selected].filter((name) => !fields.some((field) => field.name === name));
  if (missing.length) throw new Error(`源表里没有这些列：${missing.join(", ")}。`);
  const pkColumns = [...new Set((input.primaryKeyColumns?.length ? input.primaryKeyColumns : chosen.filter((field) => field.primaryKey).map((field) => field.name)).map((name) => name.trim()).filter(Boolean))];
  if (!pkColumns.length) throw new Error("ODS 必须配置至少一个主键列；表没有主键时请手工选择能唯一标识一行的列。");
  if (pkColumns.some((name) => !chosen.some((field) => field.name === name))) throw new Error("主键列必须在本次同步列里。");
  const syncMode: OdsSyncMode = input.syncMode === "INCREMENTAL" ? "INCREMENTAL" : "FULL";
  const watermark = String(input.watermarkColumn ?? "").trim();
  if (syncMode === "INCREMENTAL" && !watermark) throw new Error("增量同步必须选择水位列。");
  if (watermark && !chosen.some((field) => field.name === watermark)) throw new Error("水位列必须在本次同步列里。");

  const columns: OdsColumn[] = chosen.map((field) => ({
    name: field.name,
    sourceType: field.typeDetail || field.dataType,
    clickhouseType: odsStorageType(field.typeDetail || field.dataType, source.kind),
    nullable: field.nullable,
    primaryKey: pkColumns.includes(field.name),
    comment: field.comment,
  }));
  const repo = await platformRepo(OdsSourceEntity);
  const existing = await repo.findOne({ where: { dataSourceId: input.dataSourceId, schemaName: input.schema, tableName: input.table } });
  const now = new Date();
  const autoReconcileHours = Math.max(0, Math.floor(input.autoReconcileHours ?? existing?.autoReconcileHours ?? 24));
  const id = existing?.id ?? randomUUID();
  const row = repo.create({
    id,
    dataSourceId: input.dataSourceId,
    schemaName: input.schema,
    tableName: input.table,
    tableKind: input.tableKind ?? existing?.tableKind ?? "table",
    columns: jsonValue(columns),
    primaryKeyColumns: jsonValue(pkColumns),
    watermarkColumn: watermark,
    syncMode,
    enabled: input.enabled ?? existing?.enabled ?? true,
    chTable: existing?.chTable ?? odsStorageTable(input.dataSourceId, input.schema, input.table),
    status: existing && existing.status === "READY" ? "STALE" : existing?.status ?? "NEVER",
    lastSyncAt: existing?.lastSyncAt ?? null,
    lastFullSyncAt: existing?.lastFullSyncAt ?? null,
    autoReconcileHours,
    nextReconcileAt: autoReconcileHours > 0
      ? existing?.nextReconcileAt ?? new Date(now.getTime() + autoReconcileHours * 60 * 60_000)
      : null,
    lastSyncJobId: existing?.lastSyncJobId ?? null,
    rowCount: existing?.rowCount ?? "0",
    lastError: existing?.lastError ?? null,
    lastWatermark: existing?.lastWatermark ?? null,
    createdBy: existing?.createdBy ?? user.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  await repo.save(row);
  await writeAuditEntry({ actorId: user.id, action: "ODS_SOURCE_CONFIGURED", details: { sourceId: id, dataSourceId: input.dataSourceId, schema: input.schema, table: input.table, columns: chosen.map((field) => field.name), primaryKeyColumns: pkColumns, syncMode } });
  return (await mapSourceNames([row]))[0];
}

export async function updateOdsSettings(id: string, input: { enabled?: boolean; autoReconcileHours?: number }): Promise<OdsSourceView> {
  const repo = await platformRepo(OdsSourceEntity);
  const row = await repo.findOne({ where: { id } });
  if (!row) throw new Error("ODS 配置不存在。");
  if (input.enabled !== undefined) row.enabled = input.enabled;
  if (input.autoReconcileHours !== undefined) {
    row.autoReconcileHours = Math.max(0, Math.floor(input.autoReconcileHours));
    row.nextReconcileAt = row.autoReconcileHours > 0 ? new Date(Date.now() + row.autoReconcileHours * 60 * 60_000) : null;
  }
  row.updatedAt = new Date();
  await repo.save(row);
  return (await mapSourceNames([row]))[0];
}

export async function deleteOdsSource(id: string): Promise<void> {
  const repo = await platformRepo(OdsSourceEntity);
  const row = await repo.findOne({ where: { id } });
  if (!row) return;
  await getOdsStore().drop(row.id, row.chTable);
  const jobs = await platformRepo(OdsSyncJobEntity);
  await jobs.delete({ sourceId: row.id });
  await repo.remove(row);
}

export async function listOdsJobs(sourceId?: string): Promise<OdsSyncJobView[]> {
  const repo = await platformRepo(OdsSyncJobEntity);
  const state = runnerState();
  const inflight = new Set([...state.queue, ...(state.activeJobId ? [state.activeJobId] : [])]);
  const candidates = await repo.find({
    where: sourceId
      ? { sourceId, status: In(["QUEUED", "RUNNING", "CANCELLING"]) }
      : { status: In(["QUEUED", "RUNNING", "CANCELLING"]) },
  });
  const interrupted = candidates.filter((job) => !inflight.has(job.id));
  if (interrupted.length) {
    const now = new Date();
    for (const job of interrupted) {
      job.status = "INTERRUPTED";
      job.message = "服务进程已重启，上一轮同步未完成。线上 ODS 保持上一次完整镜像，可重新发起同步。";
      job.finishedAt = now;
    }
    await repo.save(interrupted);
    const sources = await platformRepo(OdsSourceEntity);
    const sourceRows = await sources.find({ where: { id: In([...new Set(interrupted.map((job) => job.sourceId))]) } });
    for (const source of sourceRows) {
      if (source.status !== "RUNNING") continue;
      source.status = source.lastSyncAt ? "STALE" : "NEVER";
      source.updatedAt = now;
    }
    if (sourceRows.length) await sources.save(sourceRows);
  }
  const rows = await repo.find({ where: sourceId ? { sourceId } : {}, order: { queuedAt: "DESC" }, take: 100 });
  return rows.map(toJob);
}

/** 取消 ODS 同步：排队任务立即撤销，运行中任务在当前源页读完后停止。 */
export async function cancelOdsSync(jobId: string, user?: { id: string }): Promise<OdsSyncJobView> {
  const jobs = await platformRepo(OdsSyncJobEntity);
  const job = await jobs.findOne({ where: { id: jobId } });
  if (!job) throw new Error("ODS 同步任务不存在。");
  if (["DONE", "FAILED", "CANCELLED", "INTERRUPTED"].includes(job.status)) return toJob(job);
  const state = runnerState();
  if (job.status === "QUEUED") {
    state.queue = state.queue.filter((id) => id !== jobId);
    job.status = "CANCELLED";
    job.message = "排队时被取消。";
    job.finishedAt = new Date();
    const sources = await platformRepo(OdsSourceEntity);
    const source = await sources.findOne({ where: { id: job.sourceId } });
    if (source) {
      source.status = source.lastSyncAt ? "STALE" : "NEVER";
      source.updatedAt = new Date();
      await sources.save(source);
    }
  } else {
    job.status = "CANCELLING";
    job.message = "取消中…（正在读完当前源页，生产镜像不会被破坏）";
    state.cancelRequested.add(jobId);
  }
  await jobs.save(job);
  if (user?.id) await writeAuditEntry({ actorId: user.id, action: "ODS_SYNC_CANCEL_REQUESTED", details: { jobId, sourceId: job.sourceId } });
  return toJob(job);
}

function specOf(row: OdsSourceEntity): OdsTableSpec {
  return {
    sourceId: row.id,
    tableName: row.chTable,
    columns: columnsOf(row.columns, []),
    primaryKeyColumns: primaryKeysOf(row.primaryKeyColumns, []),
  };
}

function exactColumn(row: Record<string, unknown>, column: string) {
  const key = Object.keys(row).find((name) => name.toLowerCase() === column.toLowerCase());
  return key ? row[key] : undefined;
}

class OdsCancelledError extends Error {
  constructor() {
    super("ODS 同步已取消。");
    this.name = "OdsCancelledError";
  }
}

async function* sourceRows(input: {
  source: Awaited<ReturnType<typeof getDataSource>> & object;
  row: OdsSourceEntity;
  mode: OdsSyncMode;
  pageSize: number;
  updateProgress: (value: { scanned: number; rows: number; pages: number; total: number | null; checkpoint?: unknown }) => Promise<void>;
  getProgress: () => { scanned: number; rows: number; pages: number };
  onWatermark: (value: unknown) => void;
  shouldCancel: () => boolean;
}) {
  const connector = await openDataSource(input.source);
  if (!connector.selectRows) throw new Error("数据资源不支持结构化取行，无法同步 ODS。");
  const columns = columnsOf(input.row.columns, []).map((column) => column.name);
  const primaryKeyColumns = primaryKeysOf(input.row.primaryKeyColumns, []);
  const incremental = input.mode === "INCREMENTAL";
  const watermarkColumn = input.row.watermarkColumn;
  const initialWatermark = input.row.lastWatermark;
  let after: unknown[] | undefined;
  let sourcePages = 0;
  let total: number | null = null;
  const view = { schema: input.row.schemaName || undefined, name: input.row.tableName };
  const initialFilters: DataSourceRowFilter[] = incremental && initialWatermark !== null && initialWatermark !== undefined
    ? [{ column: watermarkColumn, operator: "GTE", value: String(initialWatermark) }]
    : [];
  if (connector.countRows) total = await connector.countRows({ view, filters: initialFilters }).catch(() => null);
  for (;;) {
    if (input.shouldCancel()) throw new OdsCancelledError();
    const filters: DataSourceRowFilter[] = initialFilters;
    const query: DataSourceRowQuery = {
      view,
      columns,
      filters,
      limit: input.pageSize,
      orderBy: [...new Set(incremental ? [watermarkColumn, ...primaryKeyColumns] : primaryKeyColumns)],
      ...(after ? { after } : {}),
    };
    const page = await connector.selectRows(query);
    if (input.shouldCancel()) throw new OdsCancelledError();
    const orderColumns = query.orderBy ?? [];
    if (orderColumns.length !== (after?.length ?? 0) && after) throw new Error("ODS 游标列数不一致。");
    for (const row of page.rows) {
      if (incremental) input.onWatermark(exactColumn(row, watermarkColumn));
      yield row;
    }
    sourcePages += 1;
    const progress = input.getProgress();
    await input.updateProgress({ ...progress, pages: Math.max(progress.pages, sourcePages), total, checkpoint: after ? { columns: orderColumns, values: after } : null });
    const effectiveLimit = page.rowLimit > 0 ? page.rowLimit : input.pageSize;
    if (page.rows.length < effectiveLimit) break;
    const last = page.rows[page.rows.length - 1];
    const next = last ? orderColumns.map((column) => exactColumn(last, column)) : [];
    if (!next.length || next.some((value) => value === undefined || value === null || value === "")) {
      throw new Error(`源表主键/水位列「${orderColumns.join(", ")}」在分页边界为空，无法安全继续同步 ODS。`);
    }
    after = next;
  }
}

async function runJob(jobId: string) {
  const state = runnerState();
  state.activeJobId = jobId;
  const jobs = await platformRepo(OdsSyncJobEntity);
  const job = await jobs.findOne({ where: { id: jobId } });
  if (!job || job.status !== "QUEUED") { state.activeJobId = null; return; }
  const sources = await platformRepo(OdsSourceEntity);
  const source = await sources.findOne({ where: { id: job.sourceId } });
  if (!source) {
    job.status = "FAILED"; job.message = "ODS 配置已不存在。"; job.finishedAt = new Date();
    await jobs.save(job);
    state.activeJobId = null;
    return;
  }
  job.status = "RUNNING";
  job.startedAt = new Date();
  await jobs.save(job);
  source.status = "RUNNING";
  source.updatedAt = new Date();
  await sources.save(source);
  let progress = { scanned: 0, rows: 0, pages: 0 };
  let total: number | null = null;
  let watermark: unknown = source.lastWatermark;
  const updateProgress = async (value: { scanned: number; rows: number; pages: number; total: number | null; checkpoint?: unknown }) => {
    progress = { scanned: value.scanned, rows: value.rows, pages: value.pages };
    total = value.total;
    job.scanned = String(value.scanned); job.rows = String(value.rows); job.pages = value.pages; job.total = value.total === null ? null : String(value.total);
    job.checkpoint = jsonValue(value.checkpoint ?? null);
    await jobs.save(job);
  };
  try {
    const dataSource = await getDataSource(source.dataSourceId);
    if (!dataSource) throw new Error("数据资源不存在。");
    const store = getOdsStore();
    const spec = specOf(source);
    const rows = sourceRows({
      source: dataSource,
      row: source,
      mode: job.mode === "INCREMENTAL" ? "INCREMENTAL" : "FULL",
      pageSize: 5000,
      updateProgress,
      getProgress: () => progress,
      onWatermark: (value) => { if (value !== undefined && value !== null) watermark = value; },
      shouldCancel: () => state.cancelRequested.has(jobId),
    });
    const result = job.mode === "INCREMENTAL"
      ? await store.writeIncremental({ spec, rows, batchId: Date.now(), onProgress: async (value) => updateProgress({ ...value, total }) })
      : await store.writeFull({ spec, rows, batchId: Date.now(), onProgress: async (value) => updateProgress({ ...value, total }) });
    job.status = "DONE";
    job.message = [
      `已读取 ${result.rows.toLocaleString()} 行，镜像可读 ${result.storedRows.toLocaleString()} 行。`,
      ...result.warnings,
    ].join(" ");
    job.rows = String(result.storedRows);
    job.finishedAt = new Date();
    await jobs.save(job);
    source.status = "READY";
    source.lastSyncAt = new Date();
    if (job.mode === "FULL") {
      source.lastFullSyncAt = source.lastSyncAt;
      source.nextReconcileAt = source.autoReconcileHours > 0
        ? new Date(source.lastSyncAt.getTime() + source.autoReconcileHours * 60 * 60_000)
        : null;
    }
    source.lastSyncJobId = job.id;
    source.rowCount = String(await store.count(spec));
    source.lastError = null;
    source.lastWatermark = job.mode === "INCREMENTAL" && watermark !== undefined ? jsonValue(watermark) : null;
    source.updatedAt = new Date();
    await sources.save(source);
  } catch (error) {
    const cancelled = error instanceof OdsCancelledError || state.cancelRequested.has(jobId);
    const message = cancelled
      ? job.mode === "FULL" ? "全量同步已取消，影子表已回收，上一份镜像保持不变。" : "增量同步已取消；已写入的页保留，检查点未推进。镜像暂停读取，重新增量或全量校准后恢复。"
      : error instanceof Error ? error.message : "未知错误";
    job.status = cancelled ? "CANCELLED" : "FAILED"; job.message = message; job.finishedAt = new Date(); await jobs.save(job);
    source.status = cancelled ? "STALE" : "FAILED"; source.lastError = cancelled ? null : message; source.lastSyncJobId = job.id; source.updatedAt = new Date(); await sources.save(source);
  } finally {
    state.cancelRequested.delete(jobId);
    state.activeJobId = null;
  }
}

async function drain() {
  const state = runnerState();
  if (state.running) return;
  state.running = true;
  try {
    for (;;) {
      const id = state.queue.shift();
      if (!id) break;
      state.activeJobId = id;
      await runJob(id);
    }
  } finally {
    state.running = false;
  }
}

export async function enqueueOdsSync(sourceId: string, user?: { id: string }, options: { mode?: OdsSyncMode } = {}): Promise<OdsSyncJobView> {
  const sources = await platformRepo(OdsSourceEntity);
  const source = await sources.findOne({ where: { id: sourceId } });
  if (!source) throw new Error("ODS 配置不存在。");
  if (!source.enabled) throw new Error("这个 ODS 已停用，不能同步。");
  const jobs = await platformRepo(OdsSyncJobEntity);
  const active = await jobs.findOne({ where: { sourceId, status: In(["QUEUED", "RUNNING", "CANCELLING"]) } });
  if (active) throw new Error("这个 ODS 已有排队中或运行中的任务，完成或取消后再发起新任务。");
  const mode = options.mode ?? (source.syncMode === "INCREMENTAL" ? "INCREMENTAL" : "FULL");
  if (mode === "INCREMENTAL" && !source.watermarkColumn) throw new Error("增量同步必须先配置水位列；首次同步或校准请选全量。");
  const row = jobs.create({
    id: randomUUID(),
    sourceId,
    status: "QUEUED",
    mode,
    scanned: "0",
    rows: "0",
    pages: 0,
    total: null,
    truncated: false,
    message: null,
    queuedAt: new Date(),
    startedAt: null,
    finishedAt: null,
    createdBy: user?.id ?? null,
    checkpoint: null,
  });
  await jobs.save(row);
  source.lastSyncJobId = row.id;
  source.status = "RUNNING";
  source.lastError = null;
  source.updatedAt = new Date();
  await sources.save(source);
  runnerState().queue.push(row.id);
  if (user?.id) await writeAuditEntry({ actorId: user.id, action: "ODS_SYNC_QUEUED", details: { odsSourceId: sourceId, jobId: row.id, mode } });
  void drain();
  return toJob(row);
}

/** 扫描一次到期 ODS 并排全量校准。advisory lock 让多实例只会有一个调度者。 */
export async function runDueOdsReconciles(now = new Date()): Promise<number> {
  return withAdvisoryLock("ontology_ods_reconcile_scheduler", async () => {
    const sources = await platformRepo(OdsSourceEntity);
    const due = (await sources.find({ where: { enabled: true } })).filter((source) => isOdsReconcileDue(source, now));
    let queued = 0;
    for (const source of due) {
      try {
        const job = await enqueueOdsSync(source.id, undefined, { mode: "FULL" });
        await sources.update(source.id, {
          nextReconcileAt: new Date(now.getTime() + Math.max(1, source.autoReconcileHours) * 60 * 60_000),
          updatedAt: now,
        });
        await writeAuditEntry({ action: "ODS_FULL_RECONCILE_SCHEDULED", details: { sourceId: source.id, jobId: job.id } });
        queued += 1;
      } catch {
        // 已有任务、配置失效等不能阻塞其它 ODS；下一轮仍会再检查。
      }
    }
    return queued;
  });
}

/** 进程内轻量调度器：首次访问 ODS 清单时启动，每 5 分钟检查一次。 */
export function ensureOdsReconcileScheduler(): void {
  const state = runnerState();
  if (state.schedulerStarted) return;
  state.schedulerStarted = true;
  void runDueOdsReconciles().catch(() => undefined);
  const timer = setInterval(() => { void runDueOdsReconciles().catch(() => undefined); }, 5 * 60_000);
  timer.unref?.();
}
