"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Boxes, Clock3, Database, Download, FileJson, Layers, Plus, Search, Tag, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { api, describeApiError } from "@/lib/api-client";
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
  const [dialog, setDialog] = useState<null | "create" | "import">(null);

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

  /**
   * 导出本体包：一个 JSON 文件带走这份本体的结构。
   * 用 fetch 而不是 api()，因为要拿的是文件本体与 Content-Disposition 里的文件名。
   */
  const exportBundle = async (ontology: OntologySummary) => {
    try {
      const response = await fetch(`/api/ontologies/${ontology.id}/export`);
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(describeApiError(response.status, data.error));
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = encoded ? decodeURIComponent(encoded) : `${ontology.identifier}.ontology.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify(`已导出「${ontology.name}」的结构包。`);
    } catch (reason) {
      fail(reason);
    }
  };

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
            <button className="action" disabled={!canEdit} onClick={() => setDialog("import")}><Upload size={15} />导入本体包</button>
            <button className="action primary" disabled={!canEdit} onClick={() => setDialog("create")}><Plus size={16} />新建本体</button>
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
                <button className="graph-action" onClick={() => void exportBundle(ontology)}><Download size={13} />导出</button>
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

      {dialog && (
        <CreateOntologyDialog
          mode={dialog}
          targets={targets}
          ontologies={ontologies}
          onClose={() => setDialog(null)}
          // 导入成功就先把列表刷新出来：即使后面还停在提醒页，用户关掉也能看到新本体。
          onImported={async () => { await refresh(); }}
          onFinished={async (ontologyId, name, options) => {
            await refresh();
            setDialog(null);
            const rows = await api<OntologySummary[]>("/api/ontologies").catch(() => []);
            const summary = rows.find((item) => item.id === ontologyId);
            if (summary) onOpen(summary);
            notify(options?.imported ? `本体「${name}」已从本体包导入到草稿，核对后即可发布。` : `本体「${name}」已创建。`);
          }}
          fail={fail}
        />
      )}
    </section>
  );
}

function CreateOntologyDialog({ mode, targets, ontologies, onClose, onImported, onFinished, fail }: {
  mode: "create" | "import";
  targets: StorageOption[];
  ontologies: OntologySummary[];
  onClose: () => void;
  /** 导入已经落库、但还要留在弹窗里给人看提醒时，先把列表刷新掉。 */
  onImported: () => Promise<void>;
  /** 收尾：关弹窗、打开新本体、给提示。 */
  onFinished: (ontologyId: string, name: string, options?: { imported?: boolean }) => Promise<void>;
  fail: (reason: unknown) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tagText, setTagText] = useState("");
  const [storageTargetId, setStorageTargetId] = useState("");
  const [busy, setBusy] = useState(false);

  // 导入模式专用：原文件内容 + 客户端解析出的预览（真正的校验在服务端）。
  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<{ name: string; identifier: string; description: string; tags: string[]; counts: string } | null>(null);
  const [fileError, setFileError] = useState("");
  const [warnings, setWarnings] = useState<string[] | null>(null);
  /** 导入已经落库，等着走收尾（关弹窗 + 打开）。有提醒时中间会停一下。 */
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);

  // 受管记录（本体自己开的隔离空间）不该出现在「存储资源」里让用户再选一次。
  const managedIds = useMemo(() => new Set(ontologies.filter((item) => item.storage?.managed).map((item) => item.storage!.id)), [ontologies]);
  // 可选存储：受管记录（本体自己开的命名图）不再让用户选第二次。
  const choices = targets.filter((target) => !managedIds.has(target.id) && isFrontendGraphTargetKind(target.kind as GraphTargetKind));

  const readFile = async (file: File | null) => {
    setFileError("");
    setPreview(null);
    setFileText("");
    setFileName("");
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { format?: unknown; formatVersion?: unknown; ontology?: { name?: unknown; identifier?: unknown; description?: unknown; tags?: unknown }; statistics?: Record<string, unknown> };
      if (parsed?.format !== "ontology.bundle") throw new Error("这不是本体包（缺少 format: ontology.bundle）。");
      const source = parsed.ontology ?? {};
      if (typeof source.name !== "string" || !source.name.trim()) throw new Error("本体包里没有本体名称。");
      const stats = parsed.statistics ?? {};
      const counts = [
        `对象类型 ${Number(stats.objectTypes ?? 0)}`,
        `关系类型 ${Number(stats.relationTypes ?? 0)}`,
        `动作 ${Number(stats.actionTypes ?? 0)}`,
        `规则 ${Number(stats.rules ?? 0)}`,
      ].join(" · ");
      setFileText(text);
      setFileName(file.name);
      setPreview({
        name: source.name,
        identifier: typeof source.identifier === "string" ? source.identifier : "",
        description: typeof source.description === "string" ? source.description : "",
        tags: Array.isArray(source.tags) ? source.tags.filter((tag): tag is string => typeof tag === "string") : [],
        counts,
      });
      if (!name.trim()) setName(source.name);
    } catch (reason) {
      setFileError(reason instanceof Error ? reason.message : "这个文件读不出来。");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!storageTargetId) return;
    setBusy(true);
    try {
      if (mode === "import") {
        const result = await api<{ ontology: { id: string; name: string }; warnings: string[] }>("/api/ontologies/import", {
          method: "POST",
          body: JSON.stringify({ bundle: fileText, storageTargetId, name: name.trim() || undefined }),
        });
        setPending({ id: result.ontology.id, name: result.ontology.name });
        setBusy(false);
        await onImported();
        // 有提醒就停在这里让人读完，等「完成」再收尾；没有就直接收尾。
        if (result.warnings.length) { setWarnings(result.warnings); return; }
        await finish(result.ontology.id, result.ontology.name);
        return;
      }
      if (!name.trim()) return;
      const created = await api<{ id: string }>("/api/ontologies", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          tags: tagText.split(/[,，\s]+/).map((tag) => tag.trim()).filter(Boolean),
          storageTargetId,
        }),
      });
      await finish(created.id, name.trim());
    } catch (reason) {
      fail(reason);
      setBusy(false);
    }
  };

  const finish = async (ontologyId: string, name: string) => {
    await onFinished(ontologyId, name, { imported: mode === "import" });
  };

  const importing = mode === "import";
  const ready = Boolean(storageTargetId) && (importing ? Boolean(fileText) : Boolean(name.trim()));

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="dialog os-dialog" onSubmit={submit}>
        <button type="button" className="close-button" onClick={pending ? () => void finish(pending.id, pending.name) : onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon">{importing ? <Upload size={22} /> : <Boxes size={22} />}</div>
        <span className="eyebrow">{importing ? "导入" : "新建"}</span>
        <h2>{importing ? "导入本体包" : "新建本体"}</h2>
        <p>
          {importing
            ? "选一个 .ontology.json 文件，它的结构会作为新本体的草稿导入。导入不会立刻改图库——确认无误后再发布。"
            : "本体是一份互相隔离的图数据。落点由存储资源决定：Jena 会自动分配一份命名图，同一个 Fuseki 里可以放多个本体。"}
        </p>

        {importing && (
          <label className="os-file">
            本体包文件
            <span>
              <input type="file" accept=".json,application/json" onChange={(event) => void readFile(event.target.files?.[0] ?? null)} />
              <button type="button" className="graph-action" onClick={(event) => { const input = event.currentTarget.parentElement?.querySelector("input[type=file]"); if (input instanceof HTMLInputElement) input.click(); }}>
                <FileJson size={14} />选择文件
              </button>
              <b>{fileName || "未选择"}</b>
            </span>
          </label>
        )}
        {fileError && <p className="os-file-error"><TriangleAlert size={13} />{fileError}</p>}
        {preview && (
          <div className="os-import-preview">
            <b>{preview.name}</b>
            {preview.identifier && <code>{preview.identifier}</code>}
            <small>{preview.counts}</small>
            {preview.description && <span>{preview.description}</span>}
            {preview.tags.length > 0 && <div className="os-tags">{preview.tags.map((tag) => <em key={tag}><Tag size={10} />{tag}</em>)}</div>}
          </div>
        )}
        {warnings && warnings.length > 0 && (
          <div className="os-warnings">
            <b><TriangleAlert size={14} />已导入，但有 {warnings.length} 处需要你核对</b>
            <ul>{warnings.map((text) => <li key={text}>{text}</li>)}</ul>
          </div>
        )}

        <label>{importing ? "本体名称（可改）" : "名称"}<input autoFocus={!importing} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：专线业务本体" required={!importing} /></label>
        {!importing && <label>描述<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个本体描述什么" /></label>}
        {!importing && <label>标签<input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用逗号或空格分隔，可留空" /></label>}
        <label>存储资源
          <select value={storageTargetId} onChange={(event) => setStorageTargetId(event.target.value)} required>
            <option value="">选择一个存储资源</option>
            {choices.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.kindLabel}</option>)}
          </select>
        </label>

        <div className="dialog-actions">
          {warnings
            ? <button type="button" className="primary-button" onClick={() => pending && void finish(pending.id, pending.name)}>完成</button>
            : <>
                <button type="button" className="quiet-button" onClick={onClose}>取消</button>
                <button className="primary-button" disabled={busy || !ready}>{busy ? (importing ? "导入中…" : "创建中…") : importing ? "导入为草稿" : "创建本体"}</button>
              </>}
        </div>
      </form>
    </div>
  );
}