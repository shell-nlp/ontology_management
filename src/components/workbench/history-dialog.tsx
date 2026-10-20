"use client";
import { useCallback, useEffect, useState } from "react";
import { DialogShell } from "@/components/dialog-shell";
import { api } from "@/lib/shared/client/api-client";
import type { Definition } from "@/lib/ontology/draft";
import "@/components/type-edit-dialog.css";
import "@/components/graph-canvas.css";

type History = { id: string; status: string; rows: number; pages: number; message: string | null; createdAt: string; finishedAt: string | null; entityTypes: string[] };
type Row = { objectId: string; entityType: string; title: string; properties: Record<string, unknown> };
const STATUS: Record<string, string> = { QUEUED: "排队中", RUNNING: "采集中", CANCELLING: "取消中", DONE: "已完成", FAILED: "失败", CANCELLED: "已取消", INTERRUPTED: "已中断" };
export function HistoryDialog({ targetId, versionId, definition, canWrite, onClose, fail, notify }: { targetId: string; versionId?: string; definition: Definition; canWrite: boolean; onClose: () => void; fail: (error: unknown) => void; notify: (message: string) => void }) {
  const [snapshots, setSnapshots] = useState<History[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const readable = definition.entityTypes.filter((type) => type.sources?.[0]?.dataSourceId && type.sources[0].primaryKey.length);
  const load = useCallback(async () => { const data = await api<{ snapshots: History[] }>(`/api/objects/history?targetId=${encodeURIComponent(targetId)}`); setSnapshots(data.snapshots); }, [targetId]);
  useEffect(() => { void Promise.resolve().then(load).catch(fail); }, [load, fail]);
  const running = snapshots.some((item) => item.status === "RUNNING" || item.status === "QUEUED" || item.status === "CANCELLING");
  useEffect(() => { if (!running) return; const timer = setInterval(() => { void load().catch(fail); }, 2000); return () => clearInterval(timer); }, [running, load, fail]);
  const read = async (id: string, start = 0, warm = false) => {
    setBusy(true);
    try {
      const data = await api<{ rows: Row[]; total: number }>(`/api/objects/history?targetId=${encodeURIComponent(targetId)}&snapshotId=${encodeURIComponent(id)}&offset=${start}&limit=20${warm ? "&warm=1" : ""}`);
      setSelected(id); setRows(data.rows); setTotal(data.total); setOffset(start);
      if (warm) notify("已预热当前页；缓存有容量上限，历史原文保留在数据库。");
    } catch (error) { fail(error); } finally { setBusy(false); }
  };
  const capture = async () => {
    setBusy(true);
    try { await api("/api/objects/history", { method: "POST", body: JSON.stringify({ targetId, versionId, entityTypes: types }) }); await load(); notify("历史采集已在后台启动。"); }
    catch (error) { fail(error); } finally { setBusy(false); }
  };
  const remove = async (item: History) => {
    if (item.status === "DONE" && !confirm("删除这份历史快照及所有压缩数据页？源数据不会被改动。")) return;
    try { await api(`/api/objects/history?targetId=${encodeURIComponent(targetId)}&snapshotId=${encodeURIComponent(item.id)}`, { method: "DELETE" }); await load(); if (selected === item.id) { setSelected(""); setRows([]); } }
    catch (error) { fail(error); }
  };
  return <DialogShell label="历史数据快照" onClose={onClose} className="dialog graph-dialog history-dialog" >
    <h2>历史数据快照</h2>
    <p className="subtle">显式采集后，历史查询使用冻结的定义和数据。采集记录的是开始至结束的区间，跨表不保证同一事务时点；人工编辑另由版本编辑层保存。</p>
    {canWrite && <fieldset style={{ border: "1px solid var(--line)", padding: 12, marginBottom: 12 }}><legend>选择采集范围</legend><div className="ted-source-picker">{readable.map((type) => <label key={type.id} className={types.includes(type.name) ? "ted-chip active" : "ted-chip"}><input type="checkbox" checked={types.includes(type.name)} onChange={() => setTypes((current) => current.includes(type.name) ? current.filter((name) => name !== type.name) : [...current, type.name])} />{type.name}</label>)}</div><button className="action primary" disabled={busy || !types.length} onClick={() => void capture()}>采集所选类型</button></fieldset>}
    <div style={{ maxHeight: 240, overflow: "auto" }}>
      <table>
        <thead><tr><th>采集区间</th><th>范围与状态</th><th>对象数</th><th>操作</th></tr></thead>
        <tbody>{snapshots.map((item) => <tr key={item.id}>
          <td>{new Date(item.createdAt).toLocaleString("zh-CN")}<small style={{ display: "block" }}>{item.finishedAt ? new Date(item.finishedAt).toLocaleString("zh-CN") : "采集中"}</small></td>
          <td>{item.entityTypes.join("、")}<small style={{ display: "block" }} title={item.message ?? ""}>{STATUS[item.status] ?? item.status}{item.status === "FAILED" ? `：${item.message}` : ""}</small></td>
          <td>{item.rows.toLocaleString()}</td>
          <td>{item.status === "DONE" && <>
            <button className="action compact" disabled={busy} onClick={() => void read(item.id)}>查看</button>
            <button className="action compact" disabled={busy} onClick={() => void read(item.id, 0, true)}>预热</button>
          </>}{canWrite && <button className="action compact danger" disabled={item.status === "CANCELLING"} onClick={() => void remove(item)}>{item.status === "CANCELLING" ? "取消中" : item.status === "RUNNING" || item.status === "QUEUED" ? "取消" : "删除"}</button>}</td>
        </tr>)}</tbody>
      </table>
      {!snapshots.length && <p className="empty">还没有历史快照。选择类型并采集后即可回看。</p>}
    </div>
    {selected && <section style={{ maxHeight: 260, overflow: "auto", marginTop: 12 }}><h3>冻结数据 · {total.toLocaleString()} 个对象</h3>{rows.map((row) => <details key={row.objectId}><summary>{row.entityType} / {row.title}</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(row.properties, null, 2)}</pre></details>)}<div className="functional-actions"><button className="action compact" disabled={busy || offset === 0} onClick={() => void read(selected, Math.max(0, offset - 20))}>上一页</button><span>{offset + 1}–{Math.min(total, offset + rows.length)}</span><button className="action compact" disabled={busy || offset + rows.length >= total} onClick={() => void read(selected, offset + 20)}>下一页</button></div></section>}
    <div className="dialog-actions"><button className="action" onClick={onClose}>关闭</button></div>
  </DialogShell>;
}
