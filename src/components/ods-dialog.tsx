"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Check, Clock3, Loader2, Play, RefreshCcw, Trash2, TriangleAlert, X } from "lucide-react";
import { api } from "@/lib/shared/client/api-client";
import { DialogShell } from "@/components/dialog-shell";
import type { DataViewField, PublicDataSource } from "@/lib/datasource/types";
import "@/components/data-resource-studio.css";
import "@/components/type-edit-dialog.css";

type OdsColumn = { name: string; sourceType: string; clickhouseType: string; nullable: boolean; primaryKey: boolean };
type OdsStatus = "NEVER" | "RUNNING" | "READY" | "FAILED" | "STALE";
type OdsSource = {
  id: string;
  dataSourceId: string;
  schemaName: string;
  tableName: string;
  columns: OdsColumn[];
  primaryKeyColumns: string[];
  watermarkColumn: string;
  syncMode: "FULL" | "INCREMENTAL";
  enabled: boolean;
  chTable: string;
  status: OdsStatus;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  autoReconcileHours: number;
  nextReconcileAt: string | null;
  rowCount: number;
  lastError: string | null;
};
type OdsJob = {
  id: string;
  status: "QUEUED" | "RUNNING" | "CANCELLING" | "DONE" | "FAILED" | "CANCELLED" | "INTERRUPTED";
  mode: "FULL" | "INCREMENTAL";
  scanned: number;
  rows: number;
  total: number | null;
  pages: number;
  message: string | null;
  queuedAt: string;
  finishedAt: string | null;
};

const STATUS_LABEL: Record<OdsStatus, string> = {
  NEVER: "未同步",
  RUNNING: "同步中",
  READY: "可读取",
  FAILED: "同步失败",
  STALE: "配置已变更",
};

function when(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function OdsDialog({ source, schema, table, tableKind, fields, canEdit, onClose, notify, fail }: {
  source: PublicDataSource;
  schema: string;
  table: string;
  tableKind: "table" | "view" | "materialized-view";
  fields: DataViewField[];
  canEdit: boolean;
  onClose: () => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [config, setConfig] = useState<OdsSource | null>(null);
  const [jobs, setJobs] = useState<OdsJob[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>(() => fields.map((field) => field.name));
  const [primaryKeys, setPrimaryKeys] = useState<string[]>(() => fields.filter((field) => field.primaryKey).map((field) => field.name));
  const [watermarkColumn, setWatermarkColumn] = useState("");
  const [syncMode, setSyncMode] = useState<"FULL" | "INCREMENTAL">("FULL");
  const [autoReconcileHours, setAutoReconcileHours] = useState(24);
  const tableName = schema ? `${schema}.${table}` : table;

  const applyConfig = useCallback((next: OdsSource | null) => {
    setConfig(next);
    if (!next) return;
    setSelectedColumns(next.columns.map((column) => column.name));
    setPrimaryKeys(next.primaryKeyColumns);
    setWatermarkColumn(next.watermarkColumn);
    setSyncMode(next.syncMode);
    setAutoReconcileHours(next.autoReconcileHours);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoaded(false);
    try {
      const data = await api<{ sources: OdsSource[] }>("/api/ods");
      const next = data.sources.find((item) => item.dataSourceId === source.id && item.schemaName === schema && item.tableName === table) ?? null;
      applyConfig(next);
      const history = await api<{ jobs: OdsJob[] }>(`/api/ods/jobs${next ? `?sourceId=${encodeURIComponent(next.id)}` : ""}`);
      setJobs(next ? history.jobs : []);
    } catch (reason) {
      fail(reason);
    } finally {
      setLoaded(true);
    }
  }, [applyConfig, fail, schema, source.id, table]);

  useEffect(() => { void Promise.resolve().then(() => load()); }, [load]);
  useEffect(() => {
    if (!config || !jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING" || job.status === "CANCELLING")) return;
    const timer = window.setInterval(() => { void load(true); }, 2000);
    return () => window.clearInterval(timer);
  }, [config, jobs, load]);

  const selected = useMemo(() => fields.filter((field) => selectedColumns.includes(field.name)), [fields, selectedColumns]);
  const payload = () => ({ dataSourceId: source.id, schema, table, tableKind, columns: selectedColumns, primaryKeyColumns: primaryKeys, watermarkColumn, syncMode, enabled: true, autoReconcileHours });

  const save = async () => {
    if (!primaryKeys.length) { fail(new Error("ODS 至少要选一个主键列。")); return; }
    if (syncMode === "INCREMENTAL" && !watermarkColumn) { fail(new Error("增量同步必须选择水位列。")); return; }
    setBusy("save");
    try {
      const data = await api<{ source: OdsSource }>("/api/ods", { method: "POST", body: JSON.stringify(payload()) });
      applyConfig(data.source);
      notify("ODS 配置已保存；点击「开始同步」生成 ClickHouse 源表镜像。");
      await load(true);
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  };

  const activeJob = jobs.find((job) => job.status === "QUEUED" || job.status === "RUNNING" || job.status === "CANCELLING") ?? null;

  const sync = async (mode: "FULL" | "INCREMENTAL") => {
    if (!config) return;
    setBusy(`sync:${mode}`);
    try {
      await api(`/api/ods/${encodeURIComponent(config.id)}/sync`, { method: "POST", body: JSON.stringify({ mode }) });
      notify(mode === "FULL" ? "ODS 全量校准已进入后台队列。" : "ODS 增量追平已进入后台队列。");
      await load(true);
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  };

  const cancel = async (jobId: string) => {
    setBusy(`cancel:${jobId}`);
    try {
      await api(`/api/ods/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      notify("已请求取消；运行中的任务会在当前源页读完后停止。");
      await load(true);
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  };

  const remove = async () => {
    if (!config || !window.confirm(`删除 ${tableName} 的 ODS 镜像？ClickHouse 中的派生表会一并删除，源业务库不受影响。`)) return;
    if (activeJob) { fail(new Error("这个 ODS 正在同步或排队中，请先取消并等待任务结束，再删除镜像。")); return; }
    setBusy("delete");
    try {
      await api(`/api/ods/${encodeURIComponent(config.id)}`, { method: "DELETE" });
      notify("ODS 镜像已删除；源业务库未改动。");
      applyConfig(null);
      setJobs([]);
    } catch (reason) { fail(reason); } finally { setBusy(""); }
  };

  const toggleColumn = (name: string) => {
    setSelectedColumns((current) => current.includes(name) ? current.filter((item) => item !== name) : [...current, name]);
    if (primaryKeys.includes(name) && selectedColumns.includes(name)) setPrimaryKeys((current) => current.filter((item) => item !== name));
    if (watermarkColumn === name && selectedColumns.includes(name)) setWatermarkColumn("");
  };

  return <DialogShell onClose={onClose} label="ODS 源表镜像" className="ods-dialog" closeOnBackdrop={!busy}>
    <header className="ods-dialog-head">
      <span className="ods-icon"><Boxes size={22} /></span>
      <div><span className="eyebrow">ClickHouse ODS · 查询时投影</span><h2>{tableName}</h2><p>只镜像原始业务列；对象实例在查询时按当前本体版本映射形成，不按版本复制。</p></div>
      <div className="ods-head-side">
        <div className="ods-status-block"><span className={`ods-status ${config?.status.toLowerCase() ?? "never"}`}>{config ? STATUS_LABEL[config.status] : "未配置"}</span>{config && <small>{config.chTable}</small>}</div>
        <button type="button" className="ods-close" onClick={onClose} disabled={Boolean(busy)} aria-label="关闭 ODS 镜像配置" title="关闭"><X size={17} /></button>
      </div>
    </header>

    <div className="ods-dialog-body">
    {!loaded ? <div className="ods-loading"><Loader2 size={18} className="drs-spin" />读取 ODS 配置…</div> : <>
      <section className="ods-summary">
        <div><span>源资源</span><b>{source.name}</b></div>
        <div><span>最近同步</span><b>{when(config?.lastSyncAt ?? null)}</b></div>
        <div><span>最近全量</span><b>{when(config?.lastFullSyncAt ?? null)}</b></div>
        <div><span>镜像行数</span><b>{config ? config.rowCount.toLocaleString() : "—"}</b></div>
        <div><span>下次校准</span><b>{when(config?.nextReconcileAt ?? null)}</b></div>
      </section>
      {config?.lastError && <div className="ods-error"><TriangleAlert size={15} /><span>{config.lastError}</span></div>}

      <section className="ods-form-grid">
        <div className="ods-form-block">
          <div className="ods-block-head"><div><span className="eyebrow">01 · 列裁剪</span><h3>同步哪些业务列</h3></div><span>{selectedColumns.length}/{fields.length}</span></div>
          <div className="ods-column-list">
            {fields.map((field) => <label key={field.name} className={selectedColumns.includes(field.name) ? "ods-column selected" : "ods-column"}>
              <input type="checkbox" checked={selectedColumns.includes(field.name)} disabled={!canEdit} onChange={() => toggleColumn(field.name)} />
              <span><b>{field.name}</b><small>{field.typeDetail || field.dataType}{field.comment ? ` · ${field.comment}` : ""}</small></span>
              {field.primaryKey && <i>PK</i>}
            </label>)}
          </div>
        </div>
        <div className="ods-form-block">
          <div className="ods-block-head"><div><span className="eyebrow">02 · 身份与追平</span><h3>主键和同步方式</h3></div></div>
          <label className="ted-field"><span>主键列（必须唯一标识一行）</span><div className="ods-chip-row">{selected.map((field) => <label key={field.name} className={primaryKeys.includes(field.name) ? "ted-chip active" : "ted-chip"}><input type="checkbox" disabled={!canEdit} checked={primaryKeys.includes(field.name)} onChange={() => setPrimaryKeys((current) => current.includes(field.name) ? current.filter((item) => item !== field.name) : [...current, field.name])} />{field.name}</label>)}</div><small>支持复合主键；缺失主键时不允许开启 ODS。</small></label>
          <label className="ted-field"><span>同步方式</span><select className="ted-select" disabled={!canEdit} value={syncMode} onChange={(event) => setSyncMode(event.target.value === "INCREMENTAL" ? "INCREMENTAL" : "FULL")}><option value="FULL">全量：写到影子表后原子替换</option><option value="INCREMENTAL">增量：按水位列追加合并</option></select><small>全量能发现删除；增量只追新增和更新，需要定期做一次全量校准。</small></label>
          <label className="ted-field"><span>增量水位列</span><select className="ted-select" disabled={!canEdit || syncMode !== "INCREMENTAL"} value={watermarkColumn} onChange={(event) => setWatermarkColumn(event.target.value)}><option value="">选择更新时间 / 水位列</option>{selected.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}</select></label>
          <label className="ted-field"><span>自动全量校准间隔</span><div className="ods-inline-input"><input className="ted-input" type="number" min={0} max={8760} disabled={!canEdit} value={autoReconcileHours} onChange={(event) => setAutoReconcileHours(Math.max(0, Math.min(8760, Number(event.target.value) || 0)))} /><em>小时</em></div><small>增量只能追新增和更新；定期全量原子重建才能发现源表删除。填 0 关闭自动校准。</small></label>
        </div>
      </section>

      <section className="ods-jobs">
        <div className="ods-block-head"><div><span className="eyebrow">03 · 后台任务</span><h3>最近同步记录</h3></div><span>{jobs.length} 条</span></div>
        {!jobs.length ? <p className="ods-empty">还没有同步记录。保存配置后开始第一次全量同步。</p> : <div className="ods-job-list">{jobs.slice(0, 8).map((job) => <div key={job.id} className={`ods-job ${job.status.toLowerCase()}`}><span>{job.status === "RUNNING" || job.status === "QUEUED" || job.status === "CANCELLING" ? <Loader2 size={14} className="drs-spin" /> : job.status === "DONE" ? <Check size={14} /> : job.status === "FAILED" ? <TriangleAlert size={14} /> : <Clock3 size={14} />}{job.status}</span><b>{job.mode === "FULL" ? "全量" : "增量"} · {job.rows.toLocaleString()} 行</b><small>{job.message || `${job.pages} 页 · 扫描 ${job.scanned.toLocaleString()} 行`}</small>{canEdit && (job.status === "QUEUED" || job.status === "RUNNING") && <button type="button" className="action compact" disabled={Boolean(busy)} onClick={() => void cancel(job.id)}>{busy === `cancel:${job.id}` ? "取消中" : "取消"}</button>}</div>)}</div>}
      </section>
    </>}
    </div>

    <footer className="ods-dialog-foot">
      {config && canEdit && <button className="action danger" disabled={Boolean(busy) || Boolean(activeJob)} onClick={() => void remove()} title={activeJob ? "同步或排队中不能删除，请先取消任务" : "删除 ClickHouse 派生镜像"}><Trash2 size={14} />{busy === "delete" ? "删除中" : "删除镜像"}</button>}
      <span className="ods-foot-note">ClickHouse 只保存源表副本；本体定义、版本与读取策略仍保存在 PostgreSQL。</span>
      <button className="action" onClick={onClose} disabled={Boolean(busy)}>关闭</button>
      {canEdit && <button className="action" disabled={Boolean(busy)} onClick={() => void save()}>{busy === "save" ? <Loader2 size={14} className="drs-spin" /> : <RefreshCcw size={14} />}保存配置</button>}
      {canEdit && activeJob && <button className="action danger" disabled={Boolean(busy)} onClick={() => void cancel(activeJob.id)}>{busy === `cancel:${activeJob.id}` ? <Loader2 size={14} className="drs-spin" /> : <X size={14} />}取消同步</button>}
      {canEdit && config && config.watermarkColumn && <button className="action primary" disabled={Boolean(busy) || Boolean(activeJob)} onClick={() => void sync("INCREMENTAL")}>{busy === "sync:INCREMENTAL" ? <Loader2 size={14} className="drs-spin" /> : <Play size={14} />}增量追平</button>}
      {canEdit && config && <button className="action" disabled={Boolean(busy) || Boolean(activeJob)} onClick={() => void sync("FULL")}>{busy === "sync:FULL" ? <Loader2 size={14} className="drs-spin" /> : <RefreshCcw size={14} />}全量校准</button>}
    </footer>
  </DialogShell>;
}
