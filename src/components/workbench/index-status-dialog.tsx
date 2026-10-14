"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, Database, Layers, RefreshCw, RotateCcw, X } from "lucide-react";
import { api } from "@/lib/framework/api-client";
import { copyText } from "@/lib/framework/clipboard";
import type { DataSourceKind, DataViewField, PublicDataSource } from "@/lib/datasource/types";
import { dedupeSql, orderCandidateColumns } from "@/lib/ontology/dedupe-sql";
import { DEFAULT_MATERIALIZE_PAGE_SIZE, MAX_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";

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
  sourceRows: number;
  scanned: number;
  /** 源里被主键折叠掉的行数：读过的行 - 去重后的对象数。> 0 说明主键在源数据里不唯一。 */
  folded: number;
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
type Stats = {
  entries: number;
  byLabel: { label: string; count: number }[];
  byLabelOrigin: { label: string; origin: "SNAPSHOT" | "MATERIALIZED"; count: number }[];
  links: number;
  byRelationship: { label: string; count: number }[];
  updatedAt: string | null;
};

export type IndexTypeRow = {
  name: string;
  sourceLabel: string;
  indexPolicy: "AUTO" | "INDEXED" | "FEDERATED";
  /** 主来源的主键列：给「主键重复折叠」那条出路用（挑候选排序列 + 生成口径）。 */
  primaryKey?: string[];
  /** 主来源细节：口径要按它（数据资源 + 表）拿真实列清单。 */
  source?: { kind: string; dataSourceId: string; schema: string; view: string } | null;
};
/**
 * 关系类型（边）那一行。`readable` = 能排出取数计划（外键式只要两端键映射填了就算，不用另选数据资源）。
 * 读不出的那些**不进这张表**，只在表尾用一条提示说清有几条、为什么 —— 类型层声明本身合法，
 * 不该假装它们"配好了"，也不必占一整行。
 */
export type IndexLinkRow = { name: string; sourceLabel: string; readable: boolean; reason: string };

type Props = {
  targetId: string;
  /**
   * 面板按哪一版定义算「读得出 / 读不出」，物化就让服务端读哪一版 —— **有草稿就是草稿**。
   * 不传的话服务端会退回已发布版本：于是出现"面板说能读、点下去说读不了"（草稿里刚配好的键映射，
   * 已发布版本里还没有）。
   */
  versionId?: string | null;
  /** 这一版在界面上的叫法（如「v2 草稿」）；只用来显示，让"物化的是哪一版"看得见。 */
  versionLabel?: string | null;
  types: IndexTypeRow[];
  links: IndexLinkRow[];
  mayWrite: boolean;
  /** 点对象类型名时的配置入口；没有它时名称只作为文字显示。 */
  onConfigureType?: (type: IndexTypeRow) => void;
  onClose: () => void;
  notify: (message: string) => void;
  fail: (reason: unknown) => void;
};

const JOB_LABELS: Record<JobStatus, string> = {
  QUEUED: "排队中", RUNNING: "进行中", DONE: "已完成", CANCELLED: "已取消", FAILED: "失败", INTERRUPTED: "已中断",
};

/**
 * 行内的任务状态。
 *
 * **已完成的不在这里重复**：「索引（物化）」那一列已经写了"已整份物化 N 条"，同一个事实说两遍只是噪音。
 * （用户口径 2026-10-12：不要在类型表之外再单开一块任务列表，状态并进这张表，筛选也只作用于这张表。）
 */
function JobStateInline({ job, cancelling }: { job: MaterializeJob; cancelling: boolean }) {
  if (job.status === "DONE") return null;
  const runningLike = job.status === "QUEUED" || job.status === "RUNNING";
  const cancellingThis = job.cancelRequested || cancelling;
  return <span className="index-job-inline">
    <span className={`index-job-state ${job.status.toLowerCase()}${runningLike && cancellingThis ? " cancelling" : ""}`}>
      {runningLike && cancellingThis ? "取消中" : JOB_LABELS[job.status]}
    </span>
    {runningLike && <small className="index-job-progress">已读 {job.scanned} · {job.pages} 页 · 写入 {job.rows}</small>}
    {job.message && <small className="index-job-msg" title={job.message}>{job.message}</small>}
  </span>;
}

function formatTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function IndexStatusDialog({ targetId, versionId, versionLabel, types, links, mayWrite, onConfigureType, onClose, notify, fail }: Props) {
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
  /**
   * 类型表按**完成度**过滤。用户口径 2026-10-12：不要在类型表之外再单开一块任务列表 —— 已完成的行就留在这张表里，
   * 只是给这张表一个筛选。三档直接用界面上的话：**全部 / 未完成 / 已完成**（各带数量，一眼看出各有多少），
   * 默认「全部」——行不会莫名消失。
   */
  const [completionFilter, setCompletionFilter] = useState<"ALL" | "PENDING" | "DONE">("ALL");
  /** 已点取消、还在等服务端回执的任务 id（这一小段时间界面先显示「取消中…」）。 */
  const [cancelling, setCancelling] = useState<string[]>([]);
  /** 每页读多少行（源侧分页大小）。物化是"读一页写一页"，页越大往返越少、越快，但单次查询在业务库那侧越重。 */
  const [pageSize, setPageSize] = useState(DEFAULT_MATERIALIZE_PAGE_SIZE);

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
        // 带上我正在看的这一版：面板按它算的可读性，物化就必须按它取数，否则两边各说各话。
        body: JSON.stringify({ targetId, kind, entityType, pageSize, ...(versionId ? { versionId } : {}) }),
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
  const resume = async (job: { id: string; entityType: string; kind: "OBJECT_TYPE" | "RELATIONSHIP_TYPE" }) => {
    setQueuing(true);
    try {
      await api("/api/objects/materialize-type", {
        method: "POST",
        // `kind` 必须一起带上：不带的话服务端按对象类型重跑，关系类型的续跑会去定义里找一个不存在的对象类型。
        body: JSON.stringify({ targetId, kind: job.kind, entityType: job.entityType, resumeFromJobId: job.id, ...(versionId ? { versionId } : {}) }),
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

  const busy = queuing;

  const currentObjectCount = (name: string) => stats?.byLabel.find((item) => item.label === name)?.count ?? 0;
  const snapshotCount = (name: string) => stats?.byLabelOrigin.find((item) => item.label === name && item.origin === "SNAPSHOT")?.count ?? 0;
  const indexed = (name: string) => rows.find((item) => item.entityType === name);
  /** 这个类型最近一条任务（服务端已按 `kind|类型` 去重，一个类型最多一条）。 */
  const jobFor = (kind: "OBJECT_TYPE" | "RELATIONSHIP_TYPE", name: string) =>
    jobs.find((job) => job.kind === kind && job.entityType === name) ?? null;
  /**
   * 这一行"已经落地、不需要你管"了吗：**整份物化过、而且没有未完成的任务**。
   * 「只看未完成」就是把这些行藏起来 —— 它们的现状在「索引（物化）」那一列已经写得清清楚楚。
   */
  const isSettled = (kind: "OBJECT_TYPE" | "RELATIONSHIP_TYPE", name: string) => {
    const job = jobFor(kind, name);
    if (job && job.status !== "DONE") return false;
    const item = indexed(name);
    return Boolean(item) && !item?.truncated;
  };
  // FEDERATED 按策略就不进索引：不列进"可物化"，避免做出与策略相反的索引数据。
  const readableTypes = types.filter((type) => Boolean(type.sourceLabel) && type.indexPolicy !== "FEDERATED");
  const shownTypes = onlyReadable ? readableTypes : types;
  // 完成度先分好堆再按档位取，数量与行用的是同一份判断，不会出现"数字说有、表里没有"。
  const pendingTypes = shownTypes.filter((type) => !isSettled("OBJECT_TYPE", type.name));
  const doneTypes = shownTypes.filter((type) => isSettled("OBJECT_TYPE", type.name));
  // 读不出的关系类型单独拎出来：表格只列读得出的，读不出的收在表尾那条提示里催人去补键映射。
  const readableLinks = links.filter((link) => link.readable);
  const blockedLinks = links.filter((link) => !link.readable);
  const pendingLinks = readableLinks.filter((link) => !isSettled("RELATIONSHIP_TYPE", link.name));
  const doneLinks = readableLinks.filter((link) => isSettled("RELATIONSHIP_TYPE", link.name));
  const rowCount = {
    ALL: shownTypes.length + readableLinks.length,
    PENDING: pendingTypes.length + pendingLinks.length,
    DONE: doneTypes.length + doneLinks.length,
  };
  const visibleTypes = completionFilter === "PENDING" ? pendingTypes : completionFilter === "DONE" ? doneTypes : shownTypes;
  const visibleLinks = completionFilter === "PENDING" ? pendingLinks : completionFilter === "DONE" ? doneLinks : readableLinks;
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
        对象索引是可以重建的副本（权威仍在业务库）：这里按<b>对象类型</b>把业务库整份物化进来，供检索、过滤与聚合使用；
        <b>关系类型</b>的边单独物化（一条边一行，双向共用）。手工建的、动作写的、取进草稿的对象走另一条路，随版本快照发布。
      </p>

      <div className="index-summary">
        <span className={`index-badge${capabilities?.available ? " ok" : " bad"}`}><Database size={13} />ClickHouse</span>
        <span className="index-summary-item">能力<b>{capabilityLabels}</b></span>
        <span className="index-summary-item">索引条目<b>{stats?.entries ?? 0}</b></span>
        <span className="index-summary-item">最近更新<b>{formatTime(stats?.updatedAt ?? null)}</b></span>
        {versionLabel && <span className="index-summary-item">物化版本<b>{versionLabel}</b></span>}
        <button className="action compact" onClick={() => void reindex()} disabled={!mayWrite || reindexing} title="按当前发布版本的快照重建快照来源的索引；整份物化的对象不受影响">
          <RefreshCw size={13} />{reindexing ? "重建中…" : "重建快照索引"}
        </button>
        <button className="action compact" onClick={() => void rebuildAll()} disabled={!mayWrite || reindexing} title="清掉全部物化数据与清单，按发布快照重建，再把可物化的类型重新排队（会重读业务库）">
          <RotateCcw size={13} />整库重建
        </button>
      </div>
      {/*
       * 一排读法：**筛选在左、动作在右**（`排队物化选中` 用 margin-left:auto 顶到右边）。
       * 完成度用界面上直说的话（全部 / 未完成 / 已完成）并带数量 —— 用户找的就是"哪些完成了"这几个字。
       */}
      <div className="index-toolbar">
        <span className="index-filter-group">
          <span className="index-filter-caption">可读性</span>
          <div className="index-filter" role="group" aria-label="按可读性筛选">
            <button type="button" className={onlyReadable ? "selected" : ""} onClick={() => { setOnlyReadable(true); setSelected([]); }}>仅可读取（{readableTypes.length}）</button>
            <button type="button" className={onlyReadable ? "" : "selected"} onClick={() => { setOnlyReadable(false); setSelected([]); }}>全部（{types.length}）</button>
          </div>
        </span>
        <span className="index-filter-group">
          <span className="index-filter-caption">完成度</span>
          <div className="index-filter" role="group" aria-label="按完成度筛选">
            <button type="button" className={completionFilter === "ALL" ? "selected" : ""} onClick={() => setCompletionFilter("ALL")} title="不按完成度过滤">全部（{rowCount.ALL}）</button>
            <button type="button" className={completionFilter === "PENDING" ? "selected" : ""} onClick={() => setCompletionFilter("PENDING")} title="还没落地：没整份物化、或者还有没跑完 / 没跑成的任务">未完成（{rowCount.PENDING}）</button>
            <button type="button" className={completionFilter === "DONE" ? "selected" : ""} onClick={() => setCompletionFilter("DONE")} title="已整份物化，而且没有未完成的任务">已完成（{rowCount.DONE}）</button>
          </div>
        </span>
        <span className="index-selected">已选 {selected.length} 个类型</span>
        <label
          className="index-pagesize"
          title={
            `每次从业务库读多少行。物化是"读一页写一页"，页越大往返越少、跑得越快；` +
            `但单次查询在业务库那侧也更重（上限 ` + MAX_MATERIALIZE_PAGE_SIZE + ` 行）。大表用大页。`
          }
        >
          每页
          <select value={pageSize} disabled={busy} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={100}>100 行</option>
            <option value={500}>500 行</option>
            <option value={2000}>2000 行</option>
            <option value={5000}>5000 行（上限）</option>
          </select>
        </label>
        <button className="action compact primary" disabled={!mayWrite || busy || !selected.length} onClick={() => void enqueue(selected)}>
          排队物化选中（{selected.length}）
        </button>
        <button className="action compact" disabled={!mayWrite || busy || !readableTypes.length} onClick={() => void enqueue(readableTypes.map((type) => type.name))}>
          一键排队全部可读取（{readableTypes.length}）
        </button>
      </div>

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
        {!loading && !visibleTypes.length && (
          <div className="index-row">
            <span className="subtle">
              {!shownTypes.length
                ? "没有可读取的对象类型：这些类型还没绑定数据资源。"
                : completionFilter === "DONE"
                  ? "这个范围里还没有已完成的类型。"
                  : "这个范围里没有未完成的类型 —— 都整份物化过了（要一起看就切到「已完成」）。"}
            </span>
          </div>
        )}
        {!loading && visibleTypes.map((type) => {
          const item = indexed(type.name);
          const state = item ? (item.truncated ? "partial" : "full") : "none";
          const job = jobFor("OBJECT_TYPE", type.name);
          const jobBusy = job?.status === "QUEUED" || job?.status === "RUNNING";
          return <Fragment key={type.name}>
          <div className="index-row" role="row">
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
              <button type="button" className="index-type-button" disabled={!onConfigureType} title={onConfigureType ? "配置对象类型" : "当前视图没有对象类型配置入口"} onClick={() => onConfigureType?.(type)}>
                <b>{type.name}<em className={`index-policy ${type.indexPolicy.toLowerCase()}`}>{type.indexPolicy === "AUTO" ? "AUTO" : type.indexPolicy === "INDEXED" ? "只读索引" : "走业务库"}</em></b>
              </button>
              <small>{type.sourceLabel || "未绑定数据资源"}</small>
              <span className={type.primaryKey?.length ? "index-primary-key" : "index-primary-key is-empty"}>主键 {type.primaryKey?.length ? type.primaryKey.join(", ") : "未设置"}</span>
            </span>
            <span className={type.sourceLabel ? "index-cell" : "index-cell muted"}>{type.sourceLabel ? "可读取" : "不可读"}</span>
            <span className="index-cell index-materialization-cell">
              <em className={state === "none" ? "index-state none" : "index-state full"}>当前对象 {currentObjectCount(type.name)} 个</em>
              {state === "none" && <em className="index-state none">未物化</em>}
              {state !== "none" && <em className={state === "full" ? "index-state full" : "index-state partial"}>源表 {item?.sourceRows ?? item?.scanned ?? 0} 行</em>}
              {state === "full" && (item?.folded ?? 0) > 0 && (
                <em className="index-state partial" title="源里读到的行比对象多：主键在源数据里不唯一，重复的行被并进了同一个对象">
                  折叠 {item?.folded ?? 0} 行
                </em>
              )}
              {state === "partial" && <em className="index-state partial">只补过一批 · 扫描 {item?.scanned ?? 0} 行</em>}
              {job && <JobStateInline job={job} cancelling={cancelling.includes(job.id)} />}
            </span>
            <span className="index-cell">{snapshotCount(type.name)} 条</span>
            <span className="index-actions">
              {type.indexPolicy === "FEDERATED"
                ? <span className="index-cell muted" title="这个类型按策略走业务库，不进索引；要物化请先到对象类型编辑里把读法改成 AUTO 或 INDEXED">按策略走业务库</span>
                : <button
                    className="action compact"
                    disabled={!mayWrite || busy || !type.sourceLabel || jobBusy}
                    title={jobBusy ? "这个类型已经有任务在跑" : type.sourceLabel ? "把业务库里这个类型的对象整份写进索引" : "这个类型还没绑定数据资源"}
                    onClick={() => void materialize(type.name)}
                  >
                    整份物化
                  </button>}
              {type.indexPolicy !== "FEDERATED" && state !== "none" && (
                <button className={confirmClear === type.name ? "action compact danger" : "action compact"} disabled={!mayWrite || busy || jobBusy} title="只清这个类型的物化数据，快照对象保留" onClick={() => void clearMaterialized(type.name)}>
                  {confirmClear === type.name ? "确认清除？" : "清除物化"}
                </button>
              )}
              {job && jobBusy && (job.cancelRequested || cancelling.includes(job.id)
                ? <button className="quiet-button small" disabled title="正在读完当前这一页，读完就停">取消中…</button>
                : <button className="quiet-button small" disabled={!mayWrite} title="排队中会立刻取消；运行中会在当前这一页读完后停" onClick={() => void cancel(job.id)}>取消</button>)}
              {job && !jobBusy && job.status !== "DONE" && (
                <button className="quiet-button small" disabled={!mayWrite || queuing} title="从上次读到的地方接着跑，不从头来过；失败在开头时就是重试" onClick={() => void resume(job)}>{job.status === "FAILED" && job.scanned === 0 ? "重试物化" : "继续物化"}</button>
              )}
            </span>
          </div>
          {item && item.folded > 0 && <DedupeHint type={type} folded={item.folded} onCopied={notify} />}
          </Fragment>;
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
        {!loading && !readableLinks.length && <div className="index-row"><span className="subtle">还没有能读实例的关系类型：外键式把两端键映射填上就行，连接表式再选一张连接表。</span></div>}
        {!loading && readableLinks.length > 0 && !visibleLinks.length && <div className="index-row"><span className="subtle">{completionFilter === "DONE" ? "这个范围里还没有已完成的关系类型。" : "关系类型都没有未完成的 —— 都整份物化过了（要一起看就切到「已完成」）。"}</span></div>}
        {!loading && visibleLinks.map((link) => {
          const item = indexed(link.name);
          const state = item ? (item.truncated ? "partial" : "full") : "none";
          const job = jobFor("RELATIONSHIP_TYPE", link.name);
          const jobBusy = job?.status === "QUEUED" || job?.status === "RUNNING";
          const edgeCount = stats?.byRelationship?.find((row) => row.label === link.name)?.count ?? 0;
          return <div className="index-row" key={`rel:${link.name}`} role="row">
            <span className="index-check" />
            <span className="index-type"><b>{link.name}</b><small>{link.sourceLabel || "未配连接表"}</small></span>
            <span className={link.sourceLabel ? "index-cell" : "index-cell muted"}>{link.sourceLabel || "不可读"}</span>
            <span className="index-cell">
              {state === "none" && <em className="index-state none">未物化</em>}
              {state === "full" && <em className="index-state full">已整份物化 {item?.rows ?? 0} 条</em>}
              {state === "partial" && <em className="index-state partial">只补过一批 · {item?.rows ?? 0} 条</em>}
              {job && <JobStateInline job={job} cancelling={cancelling.includes(job.id)} />}
            </span>
            <span className="index-cell">{edgeCount} 条</span>
            <span className="index-actions">
              <button
                className="action compact"
                disabled={!mayWrite || busy || !link.sourceLabel || jobBusy}
                title={jobBusy ? "这个关系类型已经有任务在跑" : link.sourceLabel ? "把这张连接表里的边整份写进索引（两端对象类型也要物化，图上才画得出边）" : "这个关系类型还没配数据来源"}
                onClick={() => void materializeLink(link.name)}
              >
                整份物化
              </button>
              {state !== "none" && (
                <button className={linkConfirm === link.name ? "action compact danger" : "action compact"} disabled={!mayWrite || busy || jobBusy} title="只清这个关系类型的物化边；对象与快照都保留" onClick={() => void clearLink(link.name)}>
                  {linkConfirm === link.name ? "确认清除？" : "清除物化"}
                </button>
              )}
              {job && jobBusy && (job.cancelRequested || cancelling.includes(job.id)
                ? <button className="quiet-button small" disabled title="正在读完当前这一页，读完就停">取消中…</button>
                : <button className="quiet-button small" disabled={!mayWrite} title="排队中会立刻取消；运行中会在当前这一页读完后停" onClick={() => void cancel(job.id)}>取消</button>)}
              {job && !jobBusy && job.status !== "DONE" && (
                <button className="quiet-button small" disabled={!mayWrite || queuing} title="从上次读到的地方接着跑，不从头来过；失败在开头时就是重试" onClick={() => void resume(job)}>{job.status === "FAILED" && job.scanned === 0 ? "重试物化" : "继续物化"}</button>
              )}
            </span>
          </div>;
        })}
        {/*
         * 读不出实例的关系类型：**不占一行一行**，收成表尾一条提示。
         * 用户口径 2026-10-12：键映射是选填的，但不能让人以为"这面板没东西" —— 有几条、为什么、去哪儿补，都要写清。
         */}
        {!loading && blockedLinks.length > 0 && (
          <div className="index-row" role="row">
            <span className="index-warn" title={blockedLinks.slice(0, 8).map((link) => `${link.name}：${link.reason}`).join("\n")}>
              <AlertTriangle size={14} />
              <span>
                <b>还有 {blockedLinks.length} 条关系类型读不出实例</b>
                （本份本体共 {links.length} 条）：两端键映射还空着，或者连接表式还没选连接表 ——
                这些类型在读实例时看不到边，也不能整份物化（{blockedLinks.slice(0, 5).map((link) => link.name).join("、")}{blockedLinks.length > 5 ? " 等" : ""}）。
                到「本体建模」点开关系类型，在「两端的键映射」里补上就行：外键式两端各填一条，多对多再选一张连接表。
              </span>
            </span>
          </div>
        )}
      </div>
      {rows.some((item) => item.truncated) && <div className="notice error">
        <AlertCircle size={15} />
        <span>
          有类型只物化了一部分（撞到单次上限）：{rows.filter((item) => item.truncated).map((item) => `${item.entityType}（${item.rows} 条）`).join("、")}。
          这些类型在对象页会按索引结果展示，看不到的部分要么重新整份物化，要么把来源切到「业务库」。
        </span>
      </div>}
      {rows.some((item) => (item.folded ?? 0) > 0) && <div className="notice error">
        <AlertCircle size={15} />
        <span>
          有类型的主键在源数据里不唯一，重复的行被并进了同一个对象：{rows.filter((item) => (item.folded ?? 0) > 0).map((item) => `${item.entityType}（源里 ${item.scanned} 行 → ${item.rows} 个对象，折叠 ${item.folded} 行）`).join("、")}。
          正确做法是改主键（或换成组合键），或者在取数口径里先去重（例如按业务键取最新一行）—— 否则这些行会互相覆盖，看到的属性取自哪一行是不确定的。
        </span>
      </div>}
    </div>
  </div>;
}

/**
 * 「主键重复折叠」之后的**出路**（2026-10-13）。只报警不给路等于没说 —— 用户看到「折叠 591 行」
 * 之后该改哪一列、SQL 长什么样，不该让他自己猜。
 *
 * 就地在那一行下面给三样东西：
 * 1. 能当「取哪一行」依据的**候选列**（按参考表的真实列清单挑，日期/时间类）；
 * 2. 按这个类型已有的主键**生成好的口径 SQL**（一键复制，粘到对象类型编辑器就行）；
 * 3. 另一条路：换成一个真正唯一的键，那就不需要去重了。
 *
 * 候选列与 SQL 都调对象类型编辑器**同一套纯函数**（`orderCandidateColumns` / `dedupeSql`），
 * 两边不会各说各话。这里是**只读诊断**：不改任何定义，改动还是回编辑器里做。
 */
function DedupeHint({ type, folded, onCopied }: { type: IndexTypeRow; folded: number; onCopied: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<{ key: string; fields: DataViewField[]; kind: DataSourceKind } | null>(null);
  const [error, setError] = useState("");
  const source = type.source ?? null;
  const dataSourceId = source?.dataSourceId ?? "";
  const schema = source?.schema ?? "";
  const view = source?.view ?? "";
  useEffect(() => {
    if (!open || !dataSourceId || !view) return;
    const key = `${dataSourceId}|${schema}|${view}`;
    const query = schema ? `limit=1&schema=${encodeURIComponent(schema)}` : "limit=1";
    let cancelled = false;
    void Promise.all([
      api<{ fields: DataViewField[] }>(`/api/data-sources/${dataSourceId}/views/${encodeURIComponent(view)}?${query}`),
      api<PublicDataSource[]>("/api/data-sources"),
    ])
      .then(([fields, sources]) => {
        if (cancelled) return;
        setLoaded({ key, fields: fields.fields, kind: sources.find((item) => item.id === dataSourceId)?.kind ?? "POSTGRES" });
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "读取表结构失败。"); });
    return () => { cancelled = true; };
  }, [open, dataSourceId, schema, view]);

  if (!open) {
    return <div className="index-dedupe">
      <button type="button" className="action compact" onClick={() => setOpen(true)}><AlertTriangle size={12} />怎么去重？</button>
      <span>源里有 {folded} 行被折进了同一个对象 —— 看下一步该改什么、口径怎么写。</span>
    </div>;
  }

  const candidates = loaded && loaded.key === `${dataSourceId}|${schema}|${view}` ? orderCandidateColumns(loaded.fields) : [];
  const primaryKey = type.primaryKey ?? [];
  let sql = "";
  let sqlProblem = "";
  if (loaded && candidates.length) {
    try {
      sql = dedupeSql({ kind: loaded.kind, schema, view, rule: { keyColumns: primaryKey, orderColumn: candidates[0].name, direction: "DESC" } });
    } catch (reason) {
      sqlProblem = reason instanceof Error ? reason.message : "生成口径失败。";
    }
  }
  return <div className="index-dedupe">
    <div className="index-dedupe-head">
      <b><AlertTriangle size={12} />折叠 {folded} 行 —— 两条出路</b>
      <button type="button" className="action compact" onClick={() => setOpen(false)}>收起</button>
    </div>
    {!dataSourceId || !view ? (
      <p className="index-dedupe-note">这个类型没有可读的主来源（没绑数据资源或表），先到「本体建模 → 对象类型 → 编辑 → 数据来源」把它绑上。</p>
    ) : error ? (
      <p className="index-dedupe-note error">读表结构失败：{error}</p>
    ) : !loaded ? (
      <p className="index-dedupe-note">正在读表结构…</p>
    ) : (
      <ol className="index-dedupe-steps">
        <li>
          <b>换主键</b>：如果这张表的一行本来就该是一个对象（有行 uuid / 业务单号），把主键换成那个唯一键 —— 那就不需要去重了。
          现在的去重键是 <code>{primaryKey.length ? primaryKey.join(" + ") : "（还没配主键）"}</code>。
        </li>
        <li>
          <b>配一段去重口径</b>：这张表能当「取哪一行」依据的列有
          {candidates.length ? <> {candidates.map((field) => field.name).join("、")}</> : <b> —— 一个都没有</b>}。
          {candidates.length ? (
            sql ? <>
              <pre className="index-dedupe-sql">{sql}</pre>
              <button
                type="button"
                className="action compact"
                onClick={() => void copyText(sql).then((ok) => onCopied(ok
                  ? "口径 SQL 已复制 —— 到「本体建模 → 对象类型 → 编辑 → 数据来源」切到「取数口径」粘进去。"
                  : "复制失败：请手动选中上面那段 SQL 复制。"))}
              >
                复制这段 SQL
              </button>
            </> : <span className="index-dedupe-note error">{sqlProblem || "这个类型还没配主键列，先在对象类型里指定主键。"}</span>
          ) : (
            <span>没有日期/时间列就没法用「取最新一行」：要么按业务条件筛一行（条件得你自己写），要么按上面那条换主键。</span>
          )}
        </li>
      </ol>
    )}
  </div>;
}
