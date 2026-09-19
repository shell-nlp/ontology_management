"use client";

import { useEffect, useState } from "react";
import { Database, TriangleAlert, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { bindingKey, type PendingSource } from "@/lib/source-binding";
import "./ontology-studio.css";

type BindableSource = { id: string; name: string; kind: string };
type Response = { versionId: string; versionStatus: string; pendingSources: PendingSource[]; dataSources: BindableSource[] };

/**
 * 补齐数据资源绑定。
 *
 * 导入时表名没唯一命中的来源会被留空（换过平台库、资源被删也一样会悬空），
 * 而**留着不补**的表现是：对象页一条都读不出来、动作页说"绑定的数据资源不存在"，
 * 却没有任何地方能改。这个弹窗就是那个唯一入口 —— 候选按"表名命中 / 只是模式相同"排好，
 * 选择写进草稿，不碰已发布版本。
 */
export function BindSourcesDialog({ ontologyId, onClose, onSaved, fail }: { ontologyId: string; onClose: () => void; onSaved: (count: number) => void; fail: (reason: unknown) => void }) {
  const [data, setData] = useState<Response | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void api<Response>(`/api/ontologies/${ontologyId}/bind-sources`)
      .then((result) => {
        setData(result);
        // 默认选中唯一候选：能自动判定的已经在服务端绑掉了，剩下的多选一默认"表名命中"的那条。
        // 默认选中：首选按表名命中的那条；候选算不出来时，本机只有一个资源就直接用它（只有一个选择谈不上猜）。
        setChoices(Object.fromEntries(result.pendingSources.map((item) => [bindingKey(item), item.candidates[0]?.id ?? (result.dataSources.length === 1 ? result.dataSources[0].id : "")])));
      })
      .catch((reason) => { setError(reason instanceof Error ? reason.message : "读取待补绑定失败。"); fail(reason); });
  }, [ontologyId, fail]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const save = async () => {
    if (!data) return;
    const chosen = Object.fromEntries(Object.entries(choices).filter(([, dataSourceId]) => dataSourceId));
    if (!Object.keys(chosen).length) { setError("至少要给一条来源选数据资源。"); return; }
    try {
      setBusy(true);
      await api(`/api/ontologies/${ontologyId}/bind-sources`, { method: "POST", body: JSON.stringify({ versionId: data.versionId, bindings: chosen }) });
      onSaved(Object.keys(chosen).length);
    } catch (reason) { fail(reason); setBusy(false); }
  };

  const pending = data?.pendingSources ?? [];
  const all = data?.dataSources ?? [];

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="补齐数据资源绑定" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-head"><div><span className="eyebrow">数据资源</span><h2><Database size={16} />补齐数据资源绑定</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button></header>
        {!data && <p className="subtle">{error || "正在读取…"}</p>}
        {data && pending.length === 0 && <p className="subtle">这个版本的对象类型来源都已经绑好了，不需要补。</p>}
        {data && pending.length > 0 && <>
          <p className="subtle">有 {pending.length} 个来源没有对应的数据资源，没绑上之前对象页在这些对象类型上读不出数据。（表名能对上的已经默认选好，只是还没写进草稿。）选择写进草稿，不碰已发布版本。</p>
          <ul className="bind-source-list">
            {pending.map((item) => (
              <li key={bindingKey(item)}>
                <span>{item.entityTypeName} · <code>{item.label}</code></span>
                <select value={choices[bindingKey(item)] ?? ""} onChange={(event) => setChoices((current) => ({ ...current, [bindingKey(item)]: event.target.value }))}>
                  <option value="">先不绑</option>
                  {(item.candidates.length
                    ? item.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.exact ? "（表名命中）" : ""}</option>)
                    : all.map((source) => <option key={source.id} value={source.id}>{source.name}</option>))}
                </select>
              </li>
            ))}
          </ul>
          {!all.length && <p className="subtle"><TriangleAlert size={13} /> 本机还没有启用的数据资源，先去「数据资源」登记一个再回来补。</p>}
        </>}
        {error && <div className="os-warnings"><b><TriangleAlert size={14} />{error}</b></div>}
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button type="button" className="primary-button" disabled={busy || !data || pending.length === 0} onClick={() => void save()}>{busy ? "保存中…" : "保存绑定"}</button>
        </div>
      </div>
    </div>
  );
}
