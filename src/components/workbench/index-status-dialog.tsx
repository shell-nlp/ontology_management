"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Database, Layers, RefreshCw, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/framework/api-client";

/**
 * 「索引与物化」面板（2026-10-12）。
 *
 * 为什么不是两个孤零零的按钮：对象有**两条来路**，界面上必须让人一眼看清区别 ——
 * - **整份物化**：从业务库按对象类型整份写进对象索引（可以检索的副本，权威仍在业务库）；
 * - **本体自建**：手工建的、动作写的、取进草稿的对象，随版本快照走。
 *
 * 所以这里一行一个对象类型、三格状态（**源 / 索引 / 快照**），状态本身就是信息：哪一列是空的、
 * 哪一列只补过一批，一眼能看出来；动作贴着状态放，做完就地刷新。
 * 「只补过一批」这种半份状态必须显形 —— 半份物化会让 `auto` 读法静默截断，用户会以为"这个类型只有 N 个对象"。
 */
type Materialization = {
  entityType: string;
  rows: number;
  scanned: number;
  truncated: boolean;
  pages: number;
  completedAt: string;
};

type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "FAILED" | "INTERRUPTED";
type MaterializeJob = {
  id: string;
  entityType: string;
  status: JobStatus;
  scanned: number;
  rows: number;
  pages: number;
  truncated: boolean;
  message: string | null;
  queuedAt: string;
  finishedAt: string | null;
  /** 已请求取消、但当前这一页还没读完（取消只在页边界生效）。 */
  cancelRequested: boolean;
  /** 这个任务物化的是对象类型（节点）还是关系类型（边）。 */
  kind: "OBJECT_TYPE" | "RELATIONSHIP_TYPE";
};

type Capabilities = { available: boolean; fullText: boolean; trigram: boolean; vector: boolean; embeddingDim: number | null; reason?: string };
type Stats = { entries: number; byLabel: { label: string; count: number }[]; links: number; byRelationship: { label: string; count: number }[]; updatedAt: string | null };

export type IndexTypeRow = { name: string; sourceLabel: string; indexPolicy: "AUTO" | "INDEXED" | "FEDERATED" };
/** 关系类型（边）：配了数据来源（连接表）的才物化得了，`sourceLabel` 就是那张表。 */
export type IndexLinkRow = { name: string; sourceLabel: string };

type Props = {
  targetId: string;
  types: IndexTypeRow[];
  links: IndexLinkRow[];
  mayWrite: boolean;
  onClose: () => void;
  notify: (message: string) => void;
  fail: (reason: unknown) => void;
};

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function IndexStatusDialog({ targetId, types, links, mayWrite, onClose, notify, fail }: Props) {
  const [rows, setRows] = useState<Materialization[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  /** 只看"源可读"的类型 —— 不可读的物化不了，列表里默认不占位置。 */
  const [onlyReadable, setOnlyReadable] = useState(true);
  /** 多选物化：勾中的类型名。 */
  const [selected, setSelected] = useState<string[]>([]);
  const [jobs, setJobs] = useState<MaterializeJob[]>([]);
  const [queuing, setQueuing] = useState(false);
  /** 已点取消、还在等服务端回执的任务 id（这一小段时间界面先显示「取消中…」）。 */
  const [cancelling, setCancelling] = useState<string[]>([]);
  /** 正在删记录的任务 id。 */
  const [deleting, setDeleting] = useState<string[]>([]);
  /** 每页读多少行（源侧分页大小）。上限 500 —— 页面越大，单次查询越重。 */
  const [pageSize, setPageSize] = useState(500);

  /**
   * `silent` = 后台轮询用的静默刷新：**不碰 loading**，所以表格不会被"读取中…"整块顶掉。
   * 不静默的话，跑任务时每 2 秒刷新一次就把整张表清空再填回来 —— 界面一直在闪。
   */
  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoading(true);
    try {
      const data = await api<{ materializations: Materialization[]; capabilities: Capabilities; stats: Stats; jobs: MaterializeJob[] }>(
        `/api/objects/materialize-type?targetId=${encodeURIComponent(targetId)}`,
      );
      setRows(data.materializations);
      setJobs(data.jobs ?? []);
      setCapabilities(data.capabilities);
      setStats(data.stats);
    } catch (reason) {
      fail(reason);
    } finally {
      if (!options?.silent) setLoading(false);
    }
  }, [targetId, fail]);

  useEffect(() => { void load(); }, [load]);

  // 有活动任务时每 2 秒刷新一次（后台任务在服务端串行跑，这里只拉进度）。
  const active = jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING");
  useEffect(() => {
    if (!active) return;
    // 静默刷新：不置 loading，表格不会被整块顶掉再填回来（那看着就是在闪）。
    const timer = setInterval(() => { void load({ silent: true }); }, 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  /**
   * 排队一个类型的整份物化（对象类型或关系类型）—— 接口是异步的，入队就返回，
   * 所以这里只说"已排队"，进度去下面的任务列表看（以前这里按同步结果播报，数字是 undefined）。
   */
  const enqueueOne = async (entityType: string, kind: "OBJECT_TYPE" | "RELATIONSHIP_TYPE") => {
    setBusyType(entityType);
    try {
      await api("/api/objects/materialize-type", {
        method: "POST",
        body: JSON.stringify({ targetId, kind, entityType, pageSize }),
      });
      notify(`「${entityType}」已排队物化：进度在下面的任务列表里看。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusyType(null);
    }
  };

  const materialize = (entityType: string) => enqueueOne(entityType, "OBJECT_TYPE");
  const materializeLink = (relationshipType: string) => enqueueOne(relationshipType, "RELATIONSHIP_TYPE");

  const reindex = async () => {
    setReindexing(true);
    try {
      const result = await api<{ indexed: number }>("/api/object-search/reindex", { method: "POST", body: JSON.stringify({ targetId }) });
      notify(`已按当前发布版本重建索引：快照对象 ${result.indexed} 条（整份物化的对象不在这次替换范围内）。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setReindexing(false);
    }
  };

  /**
   * 整库重建：清掉物化那一份与它的清单 → 按发布快照重建快照索引 → 把可物化的类型重新排队。
   * 会重读业务库，所以点之前先确认。
   */
  const rebuildAll = async () => {
    if (!window.confirm("整库重建会清掉所有物化数据（快照对象保留），并重新排队物化所有可读取的类型 —— 会重读业务库。继续？")) return;
    setReindexing(true);
    try {
      const result = await api<{ indexed: number; clearedMaterialized: number; requeued: number }>("/api/object-search/reindex", {
        method: "POST",
        body: JSON.stringify({ targetId, rebuildMaterialized: true }),
      });
      notify(`整库重建完成：清掉物化 ${result.clearedMaterialized} 条、重建快照对象 ${result.indexed} 条，已重新排队 ${result.requeued} 个类型。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setReindexing(false);
    }
  };

  /** 清除某个类型的物化数据（保留快照对象），行内二次确认。 */
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  /** 「清除物化」要按两下确认：第二次才真删（关系类型那份）。 */
  const [linkConfirm, setLinkConfirm] = useState<string | null>(null);
  const clearMaterialized = async (entityType: string) => {
    if (confirmClear !== entityType) {
      setConfirmClear(entityType);
      setTimeout(() => setConfirmClear((current) => (current === entityType ? null : current)), 3000);
      return;
    }
    setConfirmClear(null);
    setQueuing(true);
    try {
      const result = await api<{ cleared: number }>(`/api/objects/materialize-type?targetId=${encodeURIComponent(targetId)}&entityType=${encodeURIComponent(entityType)}`, { method: "DELETE" });
      notify(`已清除「${entityType}」的物化数据（${result.cleared} 条）——快照对象保留。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setQueuing(false);
    }
  };

  /** 清除某个关系类型的物化边（不动对象、不动快照）。 */
  const clearLink = async (relationshipType: string) => {
    if (linkConfirm !== relationshipType) { setLinkConfirm(relationshipType); return; }
    setLinkConfirm(null);
    setQueuing(true);
    try {
      const result = await api<{ cleared: number }>(`/api/objects/materialize-type?targetId=${encodeURIComponent(targetId)}&relationshipType=${encodeURIComponent(relationshipType)}`, { method: "DELETE" });
      notify(`已清除「${relationshipType}」的物化边（${result.cleared} 条）——对象与快照都保留。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setQueuing(false);
    }
  };

  /**
   * 排队一批物化任务：**服务端串行执行**（并发会同时压业务库），这里只负责入队。
   * 进度与取消都在任务列表里看。
   */
  const enqueue = async (names: string[]) => {
    const queue = names.filter((name) => types.find((type) => type.name === name)?.sourceLabel);
    if (!queue.length) return;
    setQueuing(true);
    try {
      for (const name of queue) {
        await api("/api/objects/materialize-type", { method: "POST", body: JSON.stringify({ targetId, entityType: name, pageSize }) });
      }
      notify(`已排队 ${queue.length} 个物化任务：服务端逐个执行，进度在下面的任务列表里看。`);
      setSelected([]);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setQueuing(false);
    }
  };

  /** 断点续跑：把这一个任务从它已读到的位置接着跑（服务端取它的 scanned 当起点）。 */
  const resume = async (job: { id: string; entityType: string }) => {
    setQueuing(true);
    try {
      await api("/api/objects/materialize-type", {
        method: "POST",
        body: JSON.stringify({ targetId, entityType: job.entityType, resumeFromJobId: job.id }),
      });
      notify(`「${job.entityType}」已从断点继续排队（服务端接着上次没读完的位置读）。`);
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setQueuing(false);
    }
  };

  const cancel = async (jobId: string) => {
    setCancelling((current) => (current.includes(jobId) ? current : [...current, jobId]));
    try {
      await api(`/api/objects/materialize-type?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      fail(reason);
      setCancelling((current) => current.filter((id) => id !== jobId));
    }
  };

  // 删掉一条任务记录（不动物化数据）：只对不在跑的任务开放，正在跑的会被服务端拒绝。
  const deleteJob = async (jobId: string) => {
    setDeleting((current) => (current.includes(jobId) ? current : [...current, jobId]));
    try {
      await api(`/api/objects/materialize-type?deleteJobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setDeleting((current) => current.filter((id) => id !== jobId));
    }
  };

  const busy = queuing;

  const snapshotCount = (name: string) => stats?.byLabel.find((item) => item.label === name)?.count ?? 0;
  const indexed = (name: string) => rows.find((item) => item.entityType === name);
  // FEDERATED 按策略就不进索引：不列进"可物化"，避免做出与策略相反的索引数据。
  const readableTypes = types.filter((type) => Boolean(type.sourceLabel) && type.indexPolicy !== "FEDERATED");
  const visibleTypes = onlyReadable ? readableTypes : types;
  const toggle = (name: string) =>
    setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
  const allVisibleSelected = visibleTypes.length > 0 && visibleTypes.every((type) => !type.sourceLabel || selected.includes(type.name));
  const capabilityLabels = capabilities
    ? [capabilities.fullText ? "全文" : null, capabilities.trigram ? "子串" : null, capabilities.vector ? "向量" : null].filter(Boolean).join(" · ") || "无检索能力"
    : "—";

  return <div className="dialog-backdrop" role="presentation">
    <div className="dialog graph-dialog index-dialog" role="dialog" aria-label="索引与物化">
      <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
      <div className="dialog-icon"><Layers size={22} /></div>
      <span className="eyebrow">对象来源</span>
      <h2>索引与物化</h2>
      <p className="subtle">
        对象索引是可以重建的副本（权威仍在业务库）：这里按**对象类型**把业务库整份物化进来，供检索、过滤与聚合使用；
        **关系类型**的边单独物化（一条边一行，双向共用）。手工建的、动作写的、取进草稿的对象走另一条路，随版本快照发布。
      </p>

      <div className="index-summary">
        <span className={`index-badge${capabilities?.available ? " ok" : " bad"}`}><Database size={13} />ClickHouse</span>
        <span className="index-summary-item">能力<b>{capabilityLabels}</b></span>
        <span className="index-summary-item">索引条目<b>{stats?.entries ?? 0}</b></span>
        <span className="index-summary-item">最近更新<b>{formatTime(stats?.updatedAt ?? null)}</b></span>
        <button className="action compact" onClick={() => void reindex()} disabled={!mayWrite || reindexing} title="按当前发布版本的快照重建快照来源的索引；整份物化的对象不受影响">
          <RefreshCw size={13} />{reindexing ? "重建中…" : "重建快照索引"}
        </button>
        <button className="action compact" onClick={() => void rebuildAll()} disabled={!mayWrite || reindexing} title="清掉全部物化数据与清单，按发布快照重建，再把可物化的类型重新排队（会重读业务库）">
          <RotateCcw size={13} />整库重建
        </button>
      </div>
      <div className="index-toolbar">
        <div className="index-filter" role="group" aria-label="按可读性筛选">
          <button type="button" className={onlyReadable ? "selected" : ""} onClick={() => { setOnlyReadable(true); setSelected([]); }}>仅可读取（{readableTypes.length}）</button>
          <button type="button" className={onlyReadable ? "" : "selected"} onClick={() => { setOnlyReadable(false); setSelected([]); }}>全部（{types.length}）</button>
        </div>
        <span className="index-selected">已选 {selected.length} 个类型</span>
        <label className="index-pagesize" title="每次从业务库读多少行；页面越大，单次查询越重（单次上限 500）">
          每页
          <select value={pageSize} disabled={busy} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={100}>100 行</option>
            <option value={200}>200 行</option>
            <option value={500}>500 行</option>
          </select>
        </label>
        <button className="action compact primary" disabled={!mayWrite || busy || !selected.length} onClick={() => void enqueue(selected)}>
          排队物化选中（{selected.length}）
        </button>
        <button className="action compact" disabled={!mayWrite || busy || !readableTypes.length} onClick={() => void enqueue(readableTypes.map((type) => type.name))}>
          一键排队全部可读取（{readableTypes.length}）
        </button>
      </div>
      {jobs.length > 0 && (() => {
        const activeJobs = jobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
        const doneJobs = jobs.filter((job) => job.status === "DONE").length;
        const failedJobs = jobs.filter((job) => job.status === "FAILED").length;
        const labels: Record<JobStatus, string> = { QUEUED: "排队中", RUNNING: "进行中", DONE: "已完成", CANCELLED: "已取消", FAILED: "失败", INTERRUPTED: "已中断" };
        return <div className="index-jobs">
          <div className="index-jobs-head">
            <span className="eyebrow">物化任务</span>
            <span className="index-jobs-summary">
              {activeJobs.length ? `进行中 ${activeJobs.length}` : "空闲"} · 已完成 {doneJobs}{failedJobs ? ` · 失败 ${failedJobs}` : ""}
            </span>
          </div>
          {activeJobs.length > 0 && <div className="index-job-bar" role="progressbar" aria-label="物化进行中"><i /></div>}
          <div className="index-jobs-list">
            {jobs.map((job) => {
              const runningLike = job.status === "QUEUED" || job.status === "RUNNING";
              const cancellingThis = job.cancelRequested || cancelling.includes(job.id);
              return <div className="index-job" key={job.id}>
                <b>{job.entityType}{job.kind === "RELATIONSHIP_TYPE" ? <em className="index-job-kind">边</em> : null}</b>
                <span className={`index-job-state ${job.status.toLowerCase()}${runningLike && cancellingThis ? " cancelling" : ""}`}>{runningLike && cancellingThis ? "取消中" : labels[job.status]}</span>
                <span className="index-job-progress">已读 {job.scanned} 条 · {job.pages} 页 · 写入 {job.rows} 条</span>
                <small className="index-job-msg" title={job.message ?? ""}>{job.message ?? ""}</small>
                <span className="index-job-actions">
                  {runningLike && (cancellingThis
                    ? <button className="quiet-button small" disabled title="正在读完当前这一页，读完就停">取消中…</button>
                    : <button className="quiet-button small" disabled={!mayWrite} title="排队中会立刻取消；运行中会在当前这一页读完后停" onClick={() => void cancel(job.id)}>取消</button>)}
                  {(job.status === "INTERRUPTED" || job.status === "CANCELLED" || job.status === "FAILED") && (
                    <button className="quiet-button small" disabled={!mayWrite || queuing} title="从上次读到的地方接着跑，不从头来过" onClick={() => void resume(job)}>从断点继续</button>
                  )}
                  {!runningLike && (
                    <button className="quiet-button small" disabled={!mayWrite || deleting.includes(job.id)} title="从任务列表里删掉这条记录（不影响已物化的数据）" onClick={() => void deleteJob(job.id)}>删除</button>
                  )}
                </span>
              </div>;
            })}
          </div>
        </div>;
      })()}
      {!mayWrite && <p className="subtle">当前角色只能查看索引状态；整份物化与重建需要「编辑对象与关系」权限。</p>}
      {capabilities && !capabilities.available && <div className="notice error"><AlertCircle size={15} /><span>索引后端不可用：{capabilities.reason ?? "连接失败"}。对象检索会退回按需回源。</span></div>}

      <div className="index-table" role="table" aria-label="对象类型物化状态">
        <div className="index-row head" role="row">
          <span role="columnheader" className="index-check">
            <input
              type="checkbox"
              aria-label="全选可读取的对象类型"
              checked={allVisibleSelected}
              disabled={!mayWrite || busy || !visibleTypes.some((type) => type.sourceLabel)}
              onChange={(event) => setSelected(event.target.checked ? visibleTypes.filter((type) => type.sourceLabel).map((type) => type.name) : [])}
            />
          </span>
          <span role="columnheader">对象类型</span>
          <span role="columnheader">源</span>
          <span role="columnheader">索引（物化）</span>
          <span role="columnheader">快照（本体自建）</span>
          <span role="columnheader" />
        </div>
        {loading && <div className="index-row"><span className="subtle">读取中…</span></div>}
        {!loading && !types.length && <div className="index-row"><span className="subtle">这份本体还没有对象类型，先到「本体建模」建一个。</span></div>}
        {!loading && !visibleTypes.length && <div className="index-row"><span className="subtle">没有可读取的对象类型：这些类型还没绑定数据资源。</span></div>}
        {!loading && visibleTypes.map((type) => {
          const item = indexed(type.name);
          const state = item ? (item.truncated ? "partial" : "full") : "none";
          return <div className="index-row" key={type.name} role="row">
            <span className="index-check">
              <input
                type="checkbox"
                aria-label={`选择 ${type.name}`}
                checked={selected.includes(type.name)}
                disabled={!mayWrite || busy || !type.sourceLabel}
                onChange={() => toggle(type.name)}
              />
            </span>
            <span className="index-type">
              <b>{type.name}<em className={`index-policy ${type.indexPolicy.toLowerCase()}`}>{type.indexPolicy === "AUTO" ? "AUTO" : type.indexPolicy === "INDEXED" ? "只读索引" : "走业务库"}</em></b>
              <small>{type.sourceLabel || "未绑定数据资源"}</small>
            </span>
            <span className={type.sourceLabel ? "index-cell" : "index-cell muted"}>{type.sourceLabel ? "可读取" : "不可读"}</span>
            <span className="index-cell">
              {state === "none" && <em className="index-state none">未物化</em>}
              {state === "full" && <em className="index-state full">已整份物化 {item?.rows ?? 0} 条</em>}
              {state === "partial" && <em className="index-state partial">只补过一批 · {item?.rows ?? 0} 条</em>}
            </span>
            <span className="index-cell">{snapshotCount(type.name)} 条</span>
            <span className="index-actions">
              {type.indexPolicy === "FEDERATED"
                ? <span className="index-cell muted" title="这个类型按策略走业务库，不进索引；要物化请先到对象类型编辑里把读法改成 AUTO 或 INDEXED">按策略走业务库</span>
                : <button
                    className="action compact"
                    disabled={!mayWrite || busy || !type.sourceLabel}
                    title={type.sourceLabel ? "把业务库里这个类型的对象整份写进索引" : "这个类型还没绑定数据资源"}
                    onClick={() => void materialize(type.name)}
                  >
                    整份物化
                  </button>}
              {type.indexPolicy !== "FEDERATED" && state !== "none" && (
                <button className={confirmClear === type.name ? "action compact danger" : "action compact"} disabled={!mayWrite || busy} title="只清这个类型的物化数据，快照对象保留" onClick={() => void clearMaterialized(type.name)}>
                  {confirmClear === type.name ? "确认清除？" : "清除物化"}
                </button>
              )}
            </span>
          </div>;
        })}
      </div>
      {/*
       * 关系类型（边）。**单独一段**：边和对象是两条并行的物化线，混在一张表里会让人以为
       * "物化了对象类型就有边了" —— 其实必须各自物化，而且两端对象类型没物化时图上画不出边。
       */}
      <div className="index-table" role="table" aria-label="关系类型物化状态">
        <div className="index-row head" role="row">
          <span role="columnheader" className="index-check" />
          <span role="columnheader">关系类型（边）</span>
          <span role="columnheader">连接表</span>
          <span role="columnheader">索引（物化）</span>
          <span role="columnheader">索引里的边</span>
          <span role="columnheader" />
        </div>
        {loading && <div className="index-row"><span className="subtle">读取中…</span></div>}
        {!loading && !links.length && <div className="index-row"><span className="subtle">还没有配数据来源的关系类型：到「关系类型」里给它选一张连接表，这里就能物化边了。</span></div>}
        {!loading && links.map((link) => {
          const item = indexed(link.name);
          const state = item ? (item.truncated ? "partial" : "full") : "none";
          const edgeCount = stats?.byRelationship?.find((row) => row.label === link.name)?.count ?? 0;
          return <div className="index-row" key={`rel:${link.name}`} role="row">
            <span className="index-check" />
            <span className="index-type"><b>{link.name}</b><small>{link.sourceLabel || "未配连接表"}</small></span>
            <span className={link.sourceLabel ? "index-cell" : "index-cell muted"}>{link.sourceLabel || "不可读"}</span>
            <span className="index-cell">
              {state === "none" && <em className="index-state none">未物化</em>}
              {state === "full" && <em className="index-state full">已整份物化 {item?.rows ?? 0} 条</em>}
              {state === "partial" && <em className="index-state partial">只补过一批 · {item?.rows ?? 0} 条</em>}
            </span>
            <span className="index-cell">{edgeCount} 条</span>
            <span className="index-actions">
              <button
                className="action compact"
                disabled={!mayWrite || busy || !link.sourceLabel}
                title={link.sourceLabel ? "把这张连接表里的边整份写进索引（两端对象类型也要物化，图上才画得出边）" : "这个关系类型还没配数据来源"}
                onClick={() => void materializeLink(link.name)}
              >
                整份物化
              </button>
              {state !== "none" && (
                <button className={linkConfirm === link.name ? "action compact danger" : "action compact"} disabled={!mayWrite || busy} title="只清这个关系类型的物化边；对象与快照都保留" onClick={() => void clearLink(link.name)}>
                  {linkConfirm === link.name ? "确认清除？" : "清除物化"}
                </button>
              )}
            </span>
          </div>;
        })}
      </div>
      {rows.some((item) => item.truncated) && <div className="notice error">
        <AlertCircle size={15} />
        <span>
          有类型只物化了一部分（撞到单次上限）：{rows.filter((item) => item.truncated).map((item) => `${item.entityType}（${item.rows} 条）`).join("、")}。
          这些类型在对象页会按索引结果展示，看不到的部分要么重新整份物化，要么把来源切到「业务库」。
        </span>
      </div>}
    </div>
  </div>;
}
