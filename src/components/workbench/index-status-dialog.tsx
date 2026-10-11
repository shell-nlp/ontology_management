"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Database, Layers, RefreshCw, X } from "lucide-react";
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
};

type Capabilities = { available: boolean; fullText: boolean; trigram: boolean; vector: boolean; embeddingDim: number | null; reason?: string };
type Stats = { entries: number; byLabel: { label: string; count: number }[]; updatedAt: string | null };

export type IndexTypeRow = { name: string; sourceLabel: string; indexPolicy: "AUTO" | "INDEXED" | "FEDERATED" };

type Props = {
  targetId: string;
  types: IndexTypeRow[];
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

export function IndexStatusDialog({ targetId, types, mayWrite, onClose, notify, fail }: Props) {
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
  /** 每页读多少行（源侧分页大小）。上限 500 —— 页面越大，单次查询越重。 */
  const [pageSize, setPageSize] = useState(500);

  const load = useCallback(async () => {
    setLoading(true);
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
      setLoading(false);
    }
  }, [targetId, fail]);

  useEffect(() => { void load(); }, [load]);

  // 有活动任务时每 2 秒刷新一次（后台任务在服务端串行跑，这里只拉进度）。
  const active = jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(timer);
  }, [active, load]);

  const materialize = async (entityType: string) => {
    setBusyType(entityType);
    try {
      const result = await api<{ rows: number; scanned: number; truncated: boolean; pages: number }>("/api/objects/materialize-type", {
        method: "POST",
        body: JSON.stringify({ targetId, entityType }),
      });
      notify(
        result.truncated
          ? `「${entityType}」物化了 ${result.rows} 条（扫描 ${result.scanned} 条时撞到上限，源里可能还有更多）。`
          : `「${entityType}」已整份物化 ${result.rows} 条，共读 ${result.pages} 页。`,
      );
      await load();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusyType(null);
    }
  };

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

  const cancel = async (jobId: string) => {
    try {
      await api(`/api/objects/materialize-type?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      fail(reason);
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
        对象索引是可以重建的副本（权威仍在业务库）：这里按对象类型把业务库整份物化进来，供检索、过滤与聚合使用。
        手工建的、动作写的、取进草稿的对象走另一条路，随版本快照发布。两条来源互不覆盖。
      </p>

      <div className="index-summary">
        <span className={`index-badge${capabilities?.available ? " ok" : " bad"}`}><Database size={13} />ClickHouse</span>
        <span className="index-summary-item">能力<b>{capabilityLabels}</b></span>
        <span className="index-summary-item">索引条目<b>{stats?.entries ?? 0}</b></span>
        <span className="index-summary-item">最近更新<b>{formatTime(stats?.updatedAt ?? null)}</b></span>
        <button className="action compact" onClick={() => void reindex()} disabled={!mayWrite || reindexing} title="按当前发布版本的快照重建快照来源的索引；整份物化的对象不受影响">
          <RefreshCw size={13} />{reindexing ? "重建中…" : "重建快照索引"}
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
            {jobs.slice(0, 5).map((job) => <div className="index-job" key={job.id}>
              <b>{job.entityType}</b>
              <span className={`index-job-state ${job.status.toLowerCase()}`}>{labels[job.status]}</span>
              <span className="index-job-progress">已读 {job.scanned} 条 · {job.pages} 页 · 写入 {job.rows} 条</span>
              {job.message && <small title={job.message}>{job.message}</small>}
              {(job.status === "QUEUED" || job.status === "RUNNING") && <button className="quiet-button small" onClick={() => void cancel(job.id)}>取消</button>}
            </div>)}
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
