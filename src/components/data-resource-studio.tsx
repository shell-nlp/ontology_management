"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import {
  Check,
  ChevronRight,
  Columns3,
  Eye,
  KeyRound,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCcw,
  Search,
  Table2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import {
  DATA_SOURCE_KINDS,
  PLANNED_DATA_SOURCES,
  dataSourceKindInfo,
  type DataSourceFieldKey,
  type DataSourceHealth,
  type DataSourceKind,
  type DataSourceMark,
  type DataViewField,
  type DataViewPreview,
  type DataViewSummary,
  type PublicDataSource,
} from "@/lib/data-source/types";
import "./data-resource-studio.css";

/**
 * 数据资源工作台。
 *
 * 这一页只回答三个问题：连了哪些库、库里面有什么、某个表长什么样。
 * 它不管本体 —— 图数据库是本体存储（见「本体存储」页），这里是外部数据来源。
 */

/** 数据来源标记。每个图形都画这种库自己的数据落法，而不是通用的数据库圆柱。 */
export function DataSourceMark({ mark, accent, size = 24, className }: { mark: DataSourceMark; accent: string; size?: number; className?: string }) {
  const stroke = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: accent, strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, className, "aria-hidden": true };
  // PostgreSQL：一行一行堆起来的表数据。
  if (mark === "rows") {
    return <svg {...stroke}><rect x="3.6" y="4.3" width="16.8" height="4.7" rx="1.5" /><rect x="3.6" y="10.6" width="16.8" height="4.7" rx="1.5" /><path d="M6.8 19.4h10.4" /></svg>;
  }
  // MySQL：库里的表网格。
  if (mark === "grid") {
    return <svg {...stroke}><rect x="3.4" y="4" width="17.2" height="16" rx="1.6" /><path d="M3.4 9.3h17.2M3.4 14.6h17.2M9.1 4v16M15 4v16" /></svg>;
  }
  // Oracle：带主键点的行。
  return <svg {...stroke}><rect x="4.2" y="3.7" width="15.6" height="16.6" rx="1.6" /><path d="M4.2 8.5h15.6" /><circle cx="7.5" cy="12.4" r="1.15" fill={accent} stroke="none" /><path d="M10.8 12.4h6.2M7.5 16.6h1.5M10.8 16.6h6.2" /></svg>;
}

/** 分组抬头用的类型徽标，和本体存储页的写法保持一致。 */
function DataSourceKindBadge({ kind }: { kind: DataSourceKind }) {
  const info = dataSourceKindInfo(kind);
  return <span className="target-kind-badge" style={{ color: info.accent, borderColor: `${info.accent}33`, background: `${info.accent}0f` }}>
    <DataSourceMark mark={info.mark} accent={info.accent} size={13} />
    {info.label}
    <em>{info.modelLabel} · {info.driverPackage}</em>
  </span>;
}

/** 卡片的第二行：用什么模型存、用什么驱动连。 */
function capabilityLine(info: { modelLabel: string; driverPackage: string }) {
  return `${info.modelLabel} · ${info.driverPackage}`;
}

/**
 * 类型选择：左侧分类 + 右侧来源卡片，直接复用本体存储页那套选择器样式。
 * 只负责选类型，提交动作交给外层 —— 这样新建向导和编辑弹窗能共用一份。
 */
export function DataSourceKindChoice({ value, onChange }: { value: DataSourceKind; onChange: (kind: DataSourceKind) => void }) {
  const [category, setCategory] = useState<"supported" | "planned">("supported");
  const [filter, setFilter] = useState("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const needle = filter.trim().toLowerCase();
  const supported = useMemo(() => DATA_SOURCE_KINDS.filter((item) => !needle || `${item.label} ${item.description} ${item.driverPackage}`.toLowerCase().includes(needle)), [needle]);
  const planned = useMemo(() => PLANNED_DATA_SOURCES.filter((item) => !needle || `${item.label} ${item.description}`.toLowerCase().includes(needle)), [needle]);
  const searchable = DATA_SOURCE_KINDS.length + PLANNED_DATA_SOURCES.length > 6;

  return <div ref={bodyRef}>
    {searchable && <label className="kind-search"><Search size={14} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索数据来源类型" /></label>}
    <div className="kind-picker-body">
      <nav className="kind-picker-rail" aria-label="来源分类">
        <button type="button" className={category === "supported" ? "active" : ""} onClick={() => setCategory("supported")}>已支持<span>{DATA_SOURCE_KINDS.length}</span></button>
        <button type="button" className={category === "planned" ? "active" : ""} onClick={() => setCategory("planned")}>规划中<span>{PLANNED_DATA_SOURCES.length}</span></button>
      </nav>
      <div className="kind-picker-grid" role="radiogroup" aria-label="数据来源类型">
        {category === "supported"
          ? supported.map((item) => <button type="button" key={item.kind} data-kind-card aria-pressed={value === item.kind} className={`kind-card${value === item.kind ? " selected" : ""}`} style={{ "--kind-accent": item.accent } as CSSProperties} onClick={() => onChange(item.kind)}>
              <span className="kind-card-mark"><DataSourceMark mark={item.mark} accent={item.accent} size={26} /></span>
              <b>{item.label}</b>
              <code>{capabilityLine(item)}</code>
              <small>{item.description}</small>
              {value === item.kind && <i className="kind-card-check"><Check size={12} /></i>}
            </button>)
          : planned.map((item) => <button type="button" key={item.key} disabled aria-disabled className="kind-card planned" style={{ "--kind-accent": item.accent } as CSSProperties} title={`${item.label} ${item.note}，暂不支持连接`}>
              <span className="kind-card-mark"><DataSourceMark mark={item.mark} accent={item.accent} size={26} /></span>
              <b>{item.label}</b>
              <code>{item.capability}</code>
              <small>{item.description}</small>
              <i className="kind-card-flag">{item.note}</i>
            </button>)}
        {!supported.length && !planned.length && <p className="kind-picker-empty">没有匹配的来源类型。</p>}
      </div>
    </div>
  </div>;
}

type ResourceForm = Record<DataSourceFieldKey, string> & { name: string };

function emptyForm(kind: DataSourceKind): ResourceForm {
  const info = dataSourceKindInfo(kind);
  const form = { name: "", host: "", port: "", databaseName: "", schemaName: "", username: "", password: "" } as ResourceForm;
  form.port = String(info.defaultPort);
  return form;
}

function formFromSource(source: PublicDataSource): ResourceForm {
  return { name: source.name, host: source.host, port: String(source.port), databaseName: source.databaseName, schemaName: source.schemaName, username: source.username, password: "" };
}

/** 数据来源表单：字段顺序、标签、占位符全部来自类型元数据，加一种库不用改这里。 */
function DataSourceFields({ kind, form, setForm, editing }: { kind: DataSourceKind; form: ResourceForm; setForm: (next: ResourceForm) => void; editing?: boolean }) {
  const info = dataSourceKindInfo(kind);
  return <div className="drs-form-grid">
    <label className="drs-field wide">名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={`例如：生产 ${info.shortLabel} 只读`} required /></label>
    {/* 只有名称独占一行，其余按元数据顺序两两成排：主机/端口、库或服务名/模式、账号/密码。 */}
    {info.fields.map((field) => <label className="drs-field" key={field.key}>
      {field.label}
      <input
        type={field.input}
        value={form[field.key]}
        onChange={(event) => setForm({ ...form, [field.key]: event.target.value })}
        placeholder={field.key === "password" && editing ? "留空保持不变" : field.placeholder}
        required={field.required && !(editing && field.key === "password")}
      />
    </label>)}
    {!info.containerRequired && <p className="drs-form-note">「{info.containerLabel}」可以留空：留空就按连接用户的默认容器读结构。</p>}
  </div>;
}

function errorText(reason: unknown) {
  return typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "操作失败。";
}

/**
 * 会话内的读取缓存。
 *
 * 左侧切走再切回来，组件会重新挂载；没有这层缓存的话每次都要把资源清单、
 * 结构清单（上千个对象的目录）和第一张表的预览重拉一遍。
 * 这里只负责"秒开"：命中就先渲染，随后仍然后台取一份最新的换上去；
 * 需要立刻回库重读时用「刷新结构」，它会带 refresh=1 穿透服务端的 TTL 缓存。
 */
const sessionCache = {
  sources: null as PublicDataSource[] | null,
  activeId: "",
  catalogs: new Map<string, DataViewSummary[]>(),
  details: new Map<string, { fields: DataViewField[]; preview: DataViewPreview }>(),
  selected: new Map<string, string>(),
};
const CATALOG_CACHE_MAX = 12;
const DETAIL_CACHE_MAX = 60;

/** 连接信息改过之后，之前缓存的结构可能已经不是同一个库了，整条丢掉。 */
function forgetSource(sourceId: string) {
  for (const key of [...sessionCache.catalogs.keys()]) if (key.startsWith(`${sourceId}|`)) sessionCache.catalogs.delete(key);
  for (const key of [...sessionCache.details.keys()]) if (key.startsWith(`${sourceId}|`)) sessionCache.details.delete(key);
  sessionCache.selected.delete(sourceId);
}

/** 缓存只用于秒开，读的时候顺手裁到上限，免得连着翻几十张表把内存撑大。 */
function rememberCatalog(key: string, views: DataViewSummary[]) {
  sessionCache.catalogs.set(key, views);
  while (sessionCache.catalogs.size > CATALOG_CACHE_MAX) {
    const oldest = sessionCache.catalogs.keys().next().value;
    if (oldest === undefined) break;
    sessionCache.catalogs.delete(oldest);
  }
}

function rememberDetail(key: string, value: { fields: DataViewField[]; preview: DataViewPreview }) {
  sessionCache.details.set(key, value);
  while (sessionCache.details.size > DETAIL_CACHE_MAX) {
    const oldest = sessionCache.details.keys().next().value;
    if (oldest === undefined) break;
    sessionCache.details.delete(oldest);
  }
}

/** 字段按类型族上色：文本、数值、时间各一色，其它保持中性。 */
function typeFamily(dataType: string) {
  const value = dataType.toUpperCase();
  if (/CHAR|TEXT|STRING|CLOB|JSON|UUID|XML/.test(value)) return "text";
  if (/INT|NUMBER|NUMERIC|DECIMAL|FLOAT|DOUBLE|REAL|MONEY/.test(value)) return "number";
  if (/DATE|TIME|INTERVAL/.test(value)) return "time";
  return "other";
}

/** 试连结果上带个时间，重复点也能看出刚才是哪一次。 */
function probeClock(at: Date) {
  return at.toLocaleTimeString("zh-CN", { hour12: false });
}

function cellText(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function DataResourceStudio({ canEdit, notify, fail }: { canEdit: boolean; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [sources, setSources] = useState<PublicDataSource[]>(() => sessionCache.sources ?? []);
  const [loading, setLoading] = useState(() => !sessionCache.sources);
  const [activeId, setActiveId] = useState(() => sessionCache.activeId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<PublicDataSource | null>(null);
  // 上层的提示函数每次渲染都是新引用，放进 ref，避免把加载回调拖成无限循环。
  const notifyRef = useRef(notify);
  const failRef = useRef(fail);
  useEffect(() => { notifyRef.current = notify; failRef.current = fail; }, [notify, fail]);

  const load = useCallback(async (focusId?: string) => {
    try {
      const rows = await api<PublicDataSource[]>("/api/data-sources");
      sessionCache.sources = rows;
      setSources(rows);
      setActiveId((current) => {
        const wanted = focusId ?? current ?? sessionCache.activeId;
        const next = rows.some((item) => item.id === wanted) ? wanted : rows[0]?.id ?? "";
        sessionCache.activeId = next;
        return next;
      });
    } catch (reason) {
      failRef.current(reason);
    } finally {
      setLoading(false);
    }
  }, []);

  // 挂载后再取一次：直接写在 effect 里会同步 setState，触发级联渲染。
  useEffect(() => {
    const handle = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const active = sources.find((item) => item.id === activeId) ?? sources[0] ?? null;
  const groups = DATA_SOURCE_KINDS.map((info) => ({ info, items: sources.filter((item) => item.kind === info.kind) })).filter((group) => group.items.length);
  const census = groups.map((group) => `${group.info.label} ${group.items.length}`).join(" · ");

  return <section className="stack">
    <div className="panel functional-panel target-action-bar">
      <div>
        <span className="eyebrow">数据资源</span>
        <b>{loading ? "正在读取…" : `${sources.length} 个已登记数据资源`}</b>
        <p className="subtle">{census ? `按数据库类型分组：${census}。` : "还没有登记任何外部数据来源。"}连接凭据加密保存在平台库；本体存储不在这里，它是本体自己的落库位置。</p>
      </div>
      {canEdit && <button className="action primary" onClick={() => setCreating(true)}><Plus size={15} />新建数据资源</button>}
    </div>

    {sources.length ? <div className="drs-shell">
      <aside className="panel functional-panel drs-rail">
        {groups.map(({ info, items }) => <div className="drs-rail-group" key={info.kind}>
          <div className="drs-rail-head"><DataSourceKindBadge kind={info.kind} /></div>
          {items.map((item) => <button
            type="button"
            key={item.id}
            className={item.id === active?.id ? "drs-rail-row active" : "drs-rail-row"}
            style={{ "--drs-accent": info.accent } as CSSProperties}
            onClick={() => setActiveId(item.id)}
          >
            <span className="drs-rail-dot" />
            <span className="drs-rail-text"><b>{item.name}</b><small>{item.databaseName}{item.schemaName ? ` / ${item.schemaName}` : ""}</small></span>
            {!item.enabled && <i className="drs-rail-off">停用</i>}
          </button>)}
        </div>)}
      </aside>

      {active && <DataResourceBrowser
        key={`${active.id}|${active.host}|${active.port}|${active.databaseName}|${active.schemaName}`}
        source={active}
        canEdit={canEdit}
        notify={notify}
        fail={fail}
        onEdit={() => setEditing(active)}
        onChanged={() => load(active.id)}
        onDeleted={async () => { forgetSource(active.id); notifyRef.current("数据资源已删除。"); await load(""); }}
      />}
    </div> : <div className="panel functional-panel drs-empty">
      <span className="drs-empty-marks">{DATA_SOURCE_KINDS.map((info) => <DataSourceMark key={info.kind} mark={info.mark} accent={info.accent} size={22} />)}</span>
      <b>还没有数据资源</b>
      <span>数据资源是外部数据库的只读连接：先把库连上，再看里面有哪些表，最后把类的属性映射到表字段。点右上角「新建数据资源」开始。</span>
    </div>}

    {creating && <DataSourceDialog onClose={() => setCreating(false)} onSaved={async (saved) => { setCreating(false); notify("数据资源已登记，凭据已加密保存。"); await load(saved.id); }} fail={fail} />}
    {editing && <DataSourceDialog source={editing} onClose={() => setEditing(null)} onSaved={async () => { forgetSource(editing.id); setEditing(null); notify("数据资源已更新。"); await load(editing.id); }} fail={fail} />}
  </section>;
}

type ScopeFilter = "all" | "table" | "view";

/** 一个数据资源的结构浏览：左边是表与视图清单，右边是字段和数据预览。 */
function DataResourceBrowser({ source, canEdit, notify, fail, onEdit, onChanged, onDeleted }: {
  source: PublicDataSource;
  canEdit: boolean;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
  onEdit: () => void;
  onChanged: () => Promise<void> | void;
  onDeleted: () => Promise<void> | void;
}) {
  const info = dataSourceKindInfo(source.kind);
  const [scope, setScope] = useState<"container" | "all">("container");
  const catalogKey = `${source.id}|${scope}`;
  const [views, setViews] = useState<DataViewSummary[]>(() => sessionCache.catalogs.get(`${source.id}|container`) ?? []);
  const [viewsBusy, setViewsBusy] = useState(() => source.enabled && !sessionCache.catalogs.has(`${source.id}|container`));
  const [viewsError, setViewsError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [selectedName, setSelectedName] = useState(() => sessionCache.selected.get(source.id) ?? "");
  const [fields, setFields] = useState<DataViewField[]>([]);
  const [preview, setPreview] = useState<DataViewPreview | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [rows, setRows] = useState(20);
  // 再点一次同一张表不会触发请求，所以给「重新取数」留一个显式的触发位。
  const [detailToken, setDetailToken] = useState(0);
  const [health, setHealth] = useState<DataSourceHealth | null>(null);
  const [probedAt, setProbedAt] = useState<Date | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState("");
  // 范围切换时前一次请求可能后回来，用序号丢弃过期结果。
  const catalogRun = useRef(0);

  const loadViews = useCallback(async (options: { refresh?: boolean } = {}) => {
    const run = ++catalogRun.current;
    const key = catalogKey;
    const cached = options.refresh ? undefined : sessionCache.catalogs.get(key);
    setViewsError("");
    // 停用的资源不读结构：清掉上一次的清单，免得停用后还显示着过期内容。
    if (!source.enabled) {
      setViews([]);
      setSelectedName("");
      setFields([]);
      setPreview(null);
      setViewsBusy(false);
      return;
    }
    // 有缓存先渲染出来，人不用等；刷新时保留旧清单，只在上面提示正在重读。
    if (cached) setViews(cached);
    setViewsBusy(true);
    try {
      const query = new URLSearchParams({ limit: "5000" });
      if (scope === "all") query.set("schema", "*");
      if (options.refresh) query.set("refresh", "1");
      const data = await api<{ views: DataViewSummary[] }>(`/api/data-sources/${source.id}/views?${query.toString()}`);
      if (run !== catalogRun.current) return;
      rememberCatalog(key, data.views);
      setViews(data.views);
      setSelectedName((current) => {
        const next = data.views.some((item) => item.name === current) ? current : data.views[0]?.name ?? "";
        sessionCache.selected.set(source.id, next);
        return next;
      });
    } catch (reason) {
      if (run !== catalogRun.current) return;
      if (!cached) {
        setViews([]);
        setSelectedName("");
      }
      setViewsError(errorText(reason));
    } finally {
      if (run === catalogRun.current) setViewsBusy(false);
    }
  }, [catalogKey, source.id, source.enabled, scope]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void loadViews(); }, 0);
    return () => window.clearTimeout(handle);
  }, [loadViews]);

  useEffect(() => {
    let cancelled = false;
    const key = `${source.id}|${scope}|${selectedName}|${rows}`;
    const handle = window.setTimeout(() => {
      if (!selectedName) { setFields([]); setPreview(null); setDetailError(""); return; }
      const cached = sessionCache.details.get(key);
      // 先拿缓存铺满：换回来时不该先看到一片空白，再等一秒才出表。
      if (cached) { setFields(cached.fields); setPreview(cached.preview); setDetailBusy(false); setDetailError(""); }
      else { setDetailBusy(true); }
      setDetailError("");
      // 表里的数据会变，缓存只负责秒开：后台再取一份最新的换上去。
      void api<{ fields: DataViewField[]; preview: DataViewPreview }>(`/api/data-sources/${source.id}/views/${encodeURIComponent(selectedName)}?limit=${rows}`)
        .then((data) => { if (cancelled) return; rememberDetail(key, data); setFields(data.fields); setPreview(data.preview); })
        .catch((reason) => { if (cancelled) return; if (!cached) { setFields([]); setPreview(null); } setDetailError(errorText(reason)); })
        .finally(() => { if (!cancelled) setDetailBusy(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [source.id, scope, selectedName, rows, detailToken]);

  const needle = search.trim().toLowerCase();
  const matching = views.filter((item) => (filter === "all" || item.kind === filter) && (!needle || item.name.toLowerCase().includes(needle) || item.comment.toLowerCase().includes(needle)));
  const tableCount = views.filter((item) => item.kind === "table").length;
  const viewCount = views.length - tableCount;
  const selected = views.find((item) => item.name === selectedName) ?? null;
  const scoped = Boolean(source.schemaName);
  // 只有 PG 这种「一个连接能看到多个模式」的库，看全库才有意义；Oracle 的模式就是连接本身。
  const canWiden = scoped && source.kind !== "ORACLE";
  // 同一个 databaseName 字段在 Oracle 叫服务名、在 PG 叫库名，标签直接取元数据，避免写死。
  const databaseLabel = info.fields.find((field) => field.key === "databaseName")?.label.replace(/（.*/, "") ?? "库";
  const containerLabel = info.containerLabel.replace(/（.*/, "");

  // 试连要和本体存储页一样给出明确反馈：结果条 + 顶部提示，重复点也能看出「刚才那次是什么时候」。
  const probe = async () => {
    try {
      setProbing(true);
      const result = await api<DataSourceHealth>(`/api/data-sources/${source.id}/test`, { method: "POST" });
      setHealth(result);
      setProbedAt(new Date());
      notify(`连接成功：${result.agent}，读取范围 ${result.container}。`);
    } catch (reason) {
      setHealth(null);
      setProbedAt(null);
      fail(reason);
    } finally {
      setProbing(false);
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await api(`/api/data-sources/${source.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      notify(enabled ? "数据资源已启用。" : "数据资源已停用。");
      await onChanged();
    } catch (reason) {
      fail(reason);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除数据资源“${source.name}”？引用它的类绑定会失去来源，但库里的数据不会被动。`)) return;
    try {
      setBusy("delete");
      await api(`/api/data-sources/${source.id}`, { method: "DELETE" });
      await onDeleted();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy("");
    }
  };

  return <div className="panel functional-panel drs-browser">
    <header className="drs-head">
      <div className="drs-identity">
        <span className="drs-mark" style={{ color: info.accent, background: `${info.accent}12`, borderColor: `${info.accent}33` }}><DataSourceMark mark={info.mark} accent={info.accent} size={26} /></span>
        <div>
          <span className="eyebrow">{info.label} · {info.modelLabel}</span>
          <h2>{source.name}{!source.enabled && <i className="drs-tag">已停用</i>}</h2>
          <code className="drs-address">{source.address}</code>
        </div>
      </div>
      <div className="drs-head-actions">
        {canEdit && <label className="drs-switch" title={source.enabled ? "停用后不再读取这个资源" : "启用后可以读取结构"}>
          <input type="checkbox" checked={source.enabled} onChange={(event) => void toggleEnabled(event.target.checked)} />
          <span />
        </label>}
        <button className="action compact" disabled={viewsBusy} onClick={() => void loadViews({ refresh: true })} title="回库重读结构清单，跳过 60 秒缓存">{viewsBusy ? <Loader2 size={13} className="drs-spin" /> : <RefreshCcw size={13} />}{viewsBusy ? "读取中" : "刷新结构"}</button>
        <button className="action compact" disabled={probing} onClick={() => void probe()}>{probing ? <Loader2 size={13} className="drs-spin" /> : <PlugZap size={13} />}{probing ? "连接中" : "测试连接"}</button>
        {canEdit && <button className="action compact" onClick={onEdit}><Pencil size={13} />编辑连接</button>}
        {canEdit && <button className="action compact danger" disabled={busy === "delete"} onClick={() => void remove()}><Trash2 size={13} />{busy === "delete" ? "删除中" : "删除"}</button>}
      </div>
    </header>

    <div className="drs-facts">
      <span><b>{viewsBusy && !views.length ? "…" : views.length}</b>表 / 视图</span>
      <span><b>{selected ? selected.columnCount : "—"}</b>字段</span>
      <span><b>{source.databaseName}</b>{databaseLabel}</span>
      <span><b>{source.schemaName || "按连接用户"}</b>{containerLabel}</span>
      <span><b>{source.username || "—"}</b>连接账号</span>
      {probing && <span className="drs-fact-pending" role="status"><Loader2 size={13} className="drs-spin" />正在测试连接…</span>}
      {!probing && health && <span className="drs-fact-ok" role="status"><Check size={13} />连接正常 · {health.agent} · 读取范围 {health.container}{probedAt ? ` · ${probeClock(probedAt)}` : ""}</span>}
    </div>

    <div className="drs-split">
      <div className="drs-catalog">
        <div className="drs-catalog-tools">
          <label className="drs-search">
            <Search size={14} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={`搜索 ${views.length} 个表 / 视图`} />
            {search && <button type="button" onClick={() => setSearch("")} title="清空"><X size={13} /></button>}
          </label>
          <div className="segmented drs-filter">
            {([["all", "全部", views.length], ["table", "表", tableCount], ["view", "视图", viewCount]] as const).map(([key, label, count]) => <button type="button" key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}<b>{count}</b></button>)}
          </div>
          <div className="drs-catalog-foot">
            {canWiden && <button type="button" className="drs-scope" onClick={() => setScope(scope === "all" ? "container" : "all")} title={scope === "all" ? "只看这个模式" : "看这个库里的全部模式"}>
              {scope === "all" ? "全部模式" : `模式 ${source.schemaName}`}
            </button>}

          </div>
        </div>
        <div className="drs-list" role="listbox" aria-label="表与视图">
          {!source.enabled && <div className="drs-list-state">这个数据资源已停用。启用后就能继续读结构。</div>}
          {source.enabled && viewsBusy && <div className="drs-list-state"><Loader2 size={15} className="drs-spin" />正在读取结构清单…</div>}
          {viewsError && <div className="drs-list-state error"><TriangleAlert size={15} />{viewsError}<button type="button" className="action compact" onClick={() => void loadViews()}>重试</button></div>}
          {source.enabled && !viewsBusy && !viewsError && !matching.length && <div className="drs-list-state">{views.length ? "没有匹配的表或视图。" : "这个资源里没有表或视图。"}</div>}
          {matching.map((item) => <button
            type="button"
            role="option"
            aria-selected={item.name === selectedName}
            key={`${item.schema}.${item.name}`}
            className={item.name === selectedName ? "drs-list-row active" : "drs-list-row"}
            onClick={() => { setSelectedName(item.name); sessionCache.selected.set(source.id, item.name); }}
          >
            <span className="drs-list-mark">{item.kind === "view" ? <Eye size={14} /> : <Table2 size={14} />}</span>
            <span className="drs-list-text"><b>{item.name}</b><small>{item.comment || `${item.columnCount} 个字段`}</small></span>
            <ChevronRight size={13} className="drs-list-arrow" />
          </button>)}
          {matching.length >= 5000 && <div className="drs-list-state">结果已到上限，用搜索缩小范围。</div>}
        </div>
      </div>

      <div className="drs-view">
        {!source.enabled && <div className="drs-placeholder">
          <PlugZap size={22} />
          <b>数据资源已停用</b>
          <span>停用期间不读结构也不取数据。用右上角的开关启用后，清单和预览会重新加载。</span>
        </div>}
        {source.enabled && !selected && !detailBusy && <div className="drs-placeholder">
          <Columns3 size={22} />
          <b>选一个表或视图</b>
          <span>左边清单里点一个对象，这里显示它的字段清单和几行真实数据。读取全程只读，不会改动来源库。</span>
        </div>}
        {source.enabled && selected && <>
          <div className="drs-view-head">
            <div>
              <span className="eyebrow">{selected.kind === "view" ? "视图" : "表"} · {selected.schema}</span>
              <h3>{selected.name}</h3>
            </div>
            <div className="drs-view-head-actions">
              <span className="drs-view-meta">{detailBusy ? "读取中…" : detailError ? "读取失败" : `${fields.length} 字段 · ${preview?.rows.length ?? 0} 行样本`}</span>
              <button type="button" className="action compact" disabled={detailBusy} onClick={() => setDetailToken((current) => current + 1)} title="重新读这一张表的字段和数据">{detailBusy ? <Loader2 size={13} className="drs-spin" /> : <RefreshCcw size={13} />}重新取数</button>
            </div>
          </div>
          {detailError && <div className="drs-view-error"><TriangleAlert size={15} />{detailError}</div>}
          {!detailError && fields.length > 0 && <div className="drs-field-table">
            <div className="drs-field-head"><span>字段</span><span>类型</span><span>约束</span><span>注释</span></div>
            {fields.map((field) => <div className="drs-field-row" key={field.name}>
              <span className="drs-field-name" title={field.name}>{field.name}</span>
              <span><code className={`drs-type ${typeFamily(field.dataType)}`}>{field.dataType}</code></span>
              <span className="drs-field-flags">{field.primaryKey && <i className="drs-pk"><KeyRound size={11} />主键</i>}{field.nullable ? <i>可空</i> : <i className="strong">必填</i>}</span>
              <span className="drs-field-comment" title={field.comment}>{field.comment || "—"}</span>
            </div>)}
          </div>}
          <div className="drs-preview">
            <div className="drs-preview-head">
              <span className="eyebrow">数据预览</span>
              <div className="drs-preview-actions">
                <span className="drs-preview-note">只读 · 前 {rows} 行{preview?.truncated ? "（可能还有更多）" : ""}</span>

                <div className="segmented drs-rows">{[20, 50, 100].map((value) => <button type="button" key={value} className={rows === value ? "active" : ""} onClick={() => setRows(value)}>{value}</button>)}</div>
              </div>
            </div>
            <div className="drs-preview-scroll">
              {detailBusy && !preview && <div className="drs-list-state"><Loader2 size={15} className="drs-spin" />正在取数据…</div>}
              {preview && !preview.rows.length && <div className="drs-list-state">这张表里还没有数据。</div>}
              {preview && preview.rows.length > 0 && <table>
                <thead><tr>{preview.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
                <tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.columns.map((column) => {
                  const text = cellText(row[column]);
                  return <td key={column} title={text ?? "NULL"}>{text === null ? <i className="drs-null">NULL</i> : text}</td>;
                })}</tr>)}</tbody>
              </table>}
            </div>
          </div>
        </>}
      </div>
    </div>
  </div>;
}

/** 新建 / 编辑数据资源：先选来源类型，再填连接信息，存之前可以先测一次。 */
function DataSourceDialog({ source, onClose, onSaved, fail }: {
  source?: PublicDataSource;
  onClose: () => void;
  onSaved: (saved: PublicDataSource) => void | Promise<void>;
  fail: (reason: unknown) => void;
}) {
  const editing = Boolean(source);
  const [step, setStep] = useState<1 | 2>(editing ? 2 : 1);
  const initialKind = source?.kind ?? "POSTGRES";
  const [kind, setKind] = useState<DataSourceKind>(initialKind);
  const [form, setForm] = useState<ResourceForm>(() => (source ? formFromSource(source) : emptyForm(initialKind)));
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const info = dataSourceKindInfo(kind);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pickKind = (next: DataSourceKind) => {
    setKind(next);
    setProbe(null);
    setForm((current) => ({ ...current, port: String(dataSourceKindInfo(next).defaultPort) }));
  };

  const payload = () => ({
    name: form.name.trim(),
    kind,
    host: form.host.trim(),
    port: form.port ? Number(form.port) : undefined,
    databaseName: form.databaseName.trim(),
    schemaName: form.schemaName.trim(),
    username: form.username.trim(),
    password: form.password,
  });

  const testConnection = async () => {
    try {
      setProbing(true);
      setProbe(null);
      const health = await api<DataSourceHealth>("/api/data-sources/test", { method: "POST", body: JSON.stringify({ ...payload(), name: form.name.trim() || "连接测试" }) });
      setProbe({ ok: true, text: `连上了：${health.agent}，读取范围 ${health.container}。` });
    } catch (reason) {
      setProbe({ ok: false, text: errorText(reason) });
    } finally {
      setProbing(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step === 1) { setStep(2); return; }
    try {
      setBusy(true);
      const saved = source
        ? await api<PublicDataSource>(`/api/data-sources/${source.id}`, { method: "PATCH", body: JSON.stringify(payload()) })
        : await api<PublicDataSource>("/api/data-sources", { method: "POST", body: JSON.stringify(payload()) });
      await onSaved(saved);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog graph-dialog drs-dialog" onSubmit={submit}>
      <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
      <div className="dialog-icon"><DataSourceMark mark={info.mark} accent={info.accent} size={22} /></div>
      <span className="eyebrow">{editing ? "编辑数据资源" : `新建数据资源 · 步骤 ${step} / 2`}</span>
      <h2>{editing ? source?.name : step === 1 ? "选择数据来源类型" : `连接 ${info.label}`}</h2>
      <p>{editing ? "改连接信息；密码留空表示保持原密码不变。" : step === 1 ? "类型决定用什么驱动连、表挂在哪个容器下面。" : info.description}</p>

      {step === 1
        ? <DataSourceKindChoice value={kind} onChange={pickKind} />
        : <>
            {editing && <DataSourceKindChoice value={kind} onChange={pickKind} />}
            <DataSourceFields kind={kind} form={form} setForm={setForm} editing={editing} />
            {probe && <p className={probe.ok ? "drs-probe ok" : "drs-probe error"}>{probe.ok ? <Check size={14} /> : <TriangleAlert size={14} />}{probe.text}</p>}
          </>}

      <div className="dialog-actions drs-dialog-actions">
        {step === 2 && <button type="button" className="quiet-button" disabled={probing} onClick={() => void testConnection()}>{probing ? <Loader2 size={14} className="drs-spin" /> : <PlugZap size={14} />}{probing ? "连接中…" : "测试连接"}</button>}
        <span className="drs-dialog-spacer" />
        {step === 2 && !editing && <button type="button" className="quiet-button" onClick={() => setStep(1)}>上一步</button>}
        <button type="button" className="quiet-button" onClick={onClose}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "保存中…" : editing ? "保存修改" : step === 1 ? "下一步" : "保存数据资源"}</button>
      </div>
    </form>
  </div>;
}
