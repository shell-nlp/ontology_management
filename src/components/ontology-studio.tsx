"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Boxes, Clock3, Database, Layers, Plus, Search, Tag, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { graphColor } from "@/lib/graph-palette";
import { isFrontendGraphTargetKind, type GraphTargetKind } from "@/lib/graph/types";
/** 存储资源选项：只用到这几项，调用方传完整的 Target 也能满足。 */
type StorageOption = { id: string; name: string; kind: string; kindLabel: string };
import "./ontology-studio.css";

/** 列表里的一条本体：本体本身 + 落点 + 版本状态 + 数量统计。 */
export type OntologySummary = {
  id: string;
  identifier: string;
  name: string;
  description: string;
  color: string;
  tags: string[];
  /** 这份本体实际写入的存储记录 id。 */
  target_id: string;
  namespace: string | null;
  created_by: string | null;
  updated_at: string;
  storage: { id: string; name: string; kind: string; kindLabel: string; uri: string; managed: boolean } | null;
  versions: { draft: number | null; published: number | null };
  statistics: { objectTypes: number; relationTypes: number; objects: number; relationships: number };
};

type Props = {
  ontologies: OntologySummary[];
  targets: StorageOption[];
  selectedId: string;
  canEdit: boolean;
  refresh: () => Promise<void>;
  onOpen: (ontology: OntologySummary) => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

const PAGE_SIZE = 12;

/**
 * 本体列表：平台的隔离单位在这里被建立和管理。
 *
 * 用户只需要填名字、挑一个「存储资源」，剩下的落点分配由后端完成
 * （Jena 会自动开一份命名图，所以同一个 Fuseki 里能放多个本体）。
 */
export function OntologyStudio({ ontologies, targets, selectedId, canEdit, refresh, onOpen, notify, fail }: Props) {
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return ontologies;
    return ontologies.filter((item) =>
      [item.name, item.identifier, item.description, ...item.tags].some((text) => text?.toLowerCase().includes(needle)),
    );
  }, [ontologies, keyword]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const remove = async (ontology: OntologySummary) => {
    if (!window.confirm(`删除本体「${ontology.name}」？它的草稿、版本记录与图数据都会一并删除，无法撤销。`)) return;
    try {
      await api(`/api/ontologies/${ontology.id}`, { method: "DELETE" });
      await refresh();
      notify(`本体「${ontology.name}」已删除。`);
    } catch (reason) {
      fail(reason);
    }
  };

  return (
    <section className="stack">
      <div className="panel functional-panel">
        <div className="title-row">
          <div>
            <span className="eyebrow">本体</span>
            <h2>{ontologies.length ? `${ontologies.length} 个本体` : "还没有本体"}</h2>
          </div>
          <div className="functional-actions">
            <label className="os-search">
              <Search size={15} />
              <input value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }} placeholder="搜索名称 / 标识 / 标签" />
            </label>
            <button className="action primary" disabled={!canEdit} onClick={() => setCreating(true)}><Plus size={16} />新建本体</button>
          </div>
        </div>
        <p className="subtle">每个本体是一份互相隔离的图数据。新建时只需要挑一个存储资源——Jena 会自动分配一份命名图，所以同一个 Fuseki 里能放多个本体。</p>
      </div>

      {rows.length === 0 ? (
        <div className="panel functional-panel os-empty">
          <Boxes size={30} />
          <b>{keyword ? "没有匹配的本体" : "还没有本体"}</b>
          <span>{keyword ? "换一个关键词试试。" : "点右上角「新建本体」，挑一个存储资源就能开始建模。"}</span>
        </div>
      ) : (
        <div className="os-grid">
          {rows.map((ontology) => (
            <article key={ontology.id} className={ontology.id === selectedId ? "os-card selected" : "os-card"}>
              <div className="os-card-head">
                <span className="os-card-mark" style={{ background: ontology.color || graphColor(ontology.name) }}>
                  <Layers size={17} />
                </span>
                <div className="os-card-title">
                  <b>{ontology.name}</b>
                  <code>{ontology.identifier}</code>
                </div>
              </div>
              <p className="os-card-desc">{ontology.description || "暂无描述。"}</p>
              {ontology.tags.length > 0 && (
                <div className="os-tags">
                  {ontology.tags.map((tag) => <span key={tag}><Tag size={10} />{tag}</span>)}
                </div>
              )}
              <div className="os-stats">
                <span>对象类型 <b>{ontology.statistics.objectTypes}</b></span>
                <span>关系类型 <b>{ontology.statistics.relationTypes}</b></span>
                <span>对象 <b>{ontology.statistics.objects}</b></span>
                <span>关系 <b>{ontology.statistics.relationships}</b></span>
              </div>
              <div className="os-card-foot">
                <span className="os-storage" title={ontology.storage?.uri ?? ""}>
                  <Database size={12} />
                  {ontology.storage ? `${ontology.storage.name}` : "存储缺失"}
                  {ontology.namespace && <em>{ontology.namespace.replace(/^urn:ontology:/, "图 ")}</em>}
                </span>
                <span className="os-version">
                  {ontology.versions.draft ? `草稿 v${ontology.versions.draft}` : ontology.versions.published ? `已发布 v${ontology.versions.published}` : "未发布"}
                </span>
              </div>
              <div className="os-card-actions">
                <button className="graph-action primary" onClick={() => onOpen(ontology)}>打开</button>
                <button className="graph-action danger" disabled={!canEdit} onClick={() => void remove(ontology)}><Trash2 size={13} />删除</button>
                <span className="os-time"><Clock3 size={11} />{new Date(ontology.updated_at).toLocaleDateString("zh-CN")}</span>
              </div>
            </article>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="os-pager">
          <button className="graph-action" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</button>
          <span>{current} / {pageCount}</span>
          <button className="graph-action" disabled={current >= pageCount} onClick={() => setPage(current + 1)}>下一页</button>
        </div>
      )}

      {creating && (
        <CreateOntologyDialog
          targets={targets}
          ontologies={ontologies}
          onClose={() => setCreating(false)}
          onCreated={async (ontology) => { await refresh(); setCreating(false); notify(`本体「${ontology.name}」已创建。`); onOpen(ontology); }}
          fail={fail}
        />
      )}
    </section>
  );
}

function CreateOntologyDialog({ targets, ontologies, onClose, onCreated, fail }: {
  targets: StorageOption[];
  ontologies: OntologySummary[];
  onClose: () => void;
  onCreated: (ontology: OntologySummary) => Promise<void>;
  fail: (reason: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagText, setTagText] = useState("");
  const [storageTargetId, setStorageTargetId] = useState("");
  const [busy, setBusy] = useState(false);

  // 受管记录（本体自己开的隔离空间）不该出现在「存储资源」里让用户再选一次。
  const managedIds = useMemo(() => new Set(ontologies.filter((item) => item.storage?.managed).map((item) => item.storage!.id)), [ontologies]);
  // 下线的引擎（Neo4j）不再出现在新建本体的选项里；已有本体照常打开。
  const choices = targets.filter((target) => !managedIds.has(target.id) && isFrontendGraphTargetKind(target.kind as GraphTargetKind));
  // 已经被本体占用的 Neo4j 资源标出来：一个库只能装一个本体。
  const occupied = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of ontologies) if (item.storage && !item.storage.managed) map.set(item.storage.id, item.name);
    return map;
  }, [ontologies]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim() || !storageTargetId) return;
    setBusy(true);
    try {
      const created = await api<{ id: string }>("/api/ontologies", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          tags: tagText.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
          storageTargetId,
        }),
      });
      const rows = await api<OntologySummary[]>("/api/ontologies");
      const summary = rows.find((item) => item.id === created.id);
      if (summary) await onCreated(summary);
      else { await onCreated({ ...(created as unknown as OntologySummary) }); }
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="dialog os-dialog" onSubmit={submit}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><Boxes size={22} /></div>
        <span className="eyebrow">新建</span>
        <h2>新建本体</h2>
        <p>本体是一份互相隔离的图数据。落点由存储资源决定：Jena 会自动分配一份命名图，同一个 Fuseki 里可以放多个本体。</p>
        <label>名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：专线业务本体" required /></label>
        <label>描述<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个本体描述什么" /></label>
        <label>标签<input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用逗号或空格分隔，可留空" /></label>
        <label>存储资源
          <select value={storageTargetId} onChange={(event) => setStorageTargetId(event.target.value)} required>
            <option value="">选择一个存储资源</option>
            {choices.map((target) => {
              const holder = occupied.get(target.id);
              const blocked = target.kind !== "JENA" && Boolean(holder);
              return <option key={target.id} value={target.id} disabled={blocked}>{target.name} · {target.kindLabel}{blocked ? `（已被「${holder}」占用）` : ""}</option>;
            })}
          </select>
        </label>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy || !name.trim() || !storageTargetId}>{busy ? "创建中…" : "创建本体"}</button>
        </div>
      </form>
    </div>
  );
}
