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

type Capabilities = { available: boolean; fullText: boolean; trigram: boolean; vector: boolean; embeddingDim: number | null; reason?: string };
type Stats = { entries: number; byLabel: { label: string; count: number }[]; updatedAt: string | null };

export type IndexTypeRow = { name: string; sourceLabel: string };

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
  const [batch, setBatch] = useState<{ done: number; total: number; current: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ materializations: Materialization[]; capabilities: Capabilities; stats: Stats }>(
        `/api/objects/materialize-type?targetId=${encodeURIComponent(targetId)}`,
      );
      setRows(data.materializations);
      setCapabilities(data.capabilities);
      setStats(data.stats);
    } catch (reason) {
      fail(reason);
    } finally {
      setLoading(false);
    }
  }, [targetId, fail]);

  useEffect(() => { void load(); }, [load]);

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
   * 依次物化一批类型（不并发）：并发会同时压业务库，而且进度与失败归因都会乱。
   * 结果按"成功 / 截断 / 失败"三类汇总，一次说清楚。
   */
  const materializeMany = async (names: string[]) => {
    const queue = names.filter((name) => types.find((type) => type.name === name)?.sourceLabel);
    if (!queue.length) return;
    let rowsWritten = 0;
    const truncated: string[] = [];
    const failed: string[] = [];
    for (const [index, name] of queue.entries()) {
      setBatch({ done: index, total: queue.length, current: name });
      setBusyType(name);
      try {
        const result = await api<{ rows: number; truncated: boolean }>("/api/objects/materialize-type", {
          method: "POST",
          body: JSON.stringify({ targetId, entityType: name }),
        });
        rowsWritten += result.rows;
        if (result.truncated) truncated.push(name);
      } catch {
        failed.push(name);
      }
    }
    setBatch(null);
    setBusyType(null);
    setSelected([]);
    await load();
    const parts = [`已物化 ${queue.length - failed.length} 个类型、共 ${rowsWritten} 条`];
    if (truncated.length) parts.push(`${truncated.length} 个撞到上限（${truncated.join("、")}）`);
    if (failed.length) parts.push(`${failed.length} 个失败（${failed.join("、")}）`);
    notify(`${parts.join("；")}。`);
  };

  const busy = batch !== null || busyType !== null;

  const snapshotCount = (name: string) => stats?.byLabel.find((item) => item.label === name)?.count ?? 0;
  const indexed = (name: string) => rows.find((item) => item.entityType === name);
  const readableTypes = types.filter((type) => Boolean(type.sourceLabel));
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
        <button className="action compact primary" disabled={!mayWrite || busy || !selected.length} onClick={() => void materializeMany(selected)}>
          {busy && batch ? "物化中…" : `物化选中（${selected.length}）`}
        </button>
        <button className="action compact" disabled={!mayWrite || busy || !readableTypes.length} onClick={() => void materializeMany(readableTypes.map((type) => type.name))}>
          一键物化全部可读取（{readableTypes.length}）
        </button>
      </div>
      {batch && <p className="subtle index-progress">正在整份物化 {batch.done + 1}/{batch.total}：{batch.current}…（逐个进行，避免同时压业务库）</p>}
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
              <b>{type.name}</b>
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
              <button
                className="action compact"
                disabled={!mayWrite || busyType === type.name || !type.sourceLabel}
                title={type.sourceLabel ? "把业务库里这个类型的对象整份写进索引" : "这个类型还没绑定数据资源"}
                onClick={() => void materialize(type.name)}
              >
                {busyType === type.name ? "物化中…" : "整份物化"}
              </button>
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
