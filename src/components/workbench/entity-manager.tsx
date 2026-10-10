"use client";

import { type User, may, type BusinessLink, type Target, type Version, type EntityRow, graphNoun, effectivePropertiesFor, entityTitle, propertySummary, ResizableManagerGrid } from "@/components/workbench/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CircleDot, Link2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { BindSourcesDialog } from "@/components/bind-sources-dialog";
import { PropertyEditor } from "@/components/property-editor";
import { api } from "@/lib/api-client";
import { type RuntimeTypeSet } from "@/lib/graph/types";
import { type Definition } from "@/lib/ontology-draft";
import { brokenSourcesOf } from "@/lib/source-binding";
import { primaryKeyFromProperties } from "@/lib/ontology-fields";




export function ScopedActions({ definition, versionId, subjectId, labels, disabled, onRun }: { definition: Definition | null; versionId?: string; subjectId: string; labels: string[]; disabled: boolean; onRun: (actionId: string) => void }) {
  const labelKey = labels.join("|");
  const candidates = useMemo(() => (definition?.actionTypes ?? []).filter((action) => {
    const scope = definition?.entityTypes.find((item) => item.id === action.scopeEntityTypeId);
    return Boolean(scope && labelKey.split("|").includes(scope.name));
  }), [definition, labelKey]);
  // 记录"这份结果是哪个对象问出来的"，对象一换就作废，不会把上一个对象的结论显示到这个对象上。
  const [hidden, setHidden] = useState<{ key: string; ids: string[] }>({ key: "", ids: [] });
  const requestKey = versionId ? `${versionId}:${subjectId}` : "";
  // 还没建草稿/发布过时没有版本可判，先按对象类型展示全部动作，不假装知道可见性。
  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    api<{ actions: { actionId: string; visible: boolean }[] }>(`/api/ontology/${versionId}/actions?subjectEntityId=${encodeURIComponent(subjectId)}`)
      .then((data) => { if (!cancelled) setHidden({ key: requestKey, ids: data.actions.filter((item) => !item.visible).map((item) => item.actionId) }); })
      .catch(() => { if (!cancelled) setHidden({ key: requestKey, ids: [] }); });
    return () => { cancelled = true; };
  }, [requestKey, definition, subjectId, versionId]);
  const hiddenIds = hidden.key === requestKey ? hidden.ids : [];
  const actions = candidates.filter((action) => !hiddenIds.includes(action.id));
  if (!candidates.length) return null;
  return (
    <div className="ob-actions">
      <b>可以执行的动作</b>
      {actions.length ? actions.map((action) => (
        <button key={action.id} disabled={disabled} onClick={() => onRun(action.id)} title={disabled ? "只有管理员可以执行动作" : "带着这个对象去「动作」页执行"}>
          <span>{action.name || action.code}</span>
          <em>{action.code}</em>
        </button>
      )) : <p className="subtle">这个对象上暂时没有可执行的动作。</p>}
      {hiddenIds.length > 0 && <p className="subtle">{hiddenIds.length} 个动作按「隐藏」规则不出现在这个对象上。</p>}
    </div>
  );
}


/** 对象详情里的一跳关系（D2）：一条边 + "另一端是谁"。 */

export type ObjectLinkView = {
  linkRef: string;
  relationshipType: string;
  /** `out` = 这个对象是起点，`in` = 它是终点。关系类型本身是双向的，这里只说明读到的方向。 */
  direction: "out" | "in";
  otherType: string;
  otherId: string;
  otherRef: string;
  otherTitle: string;
};

/**
 * 对象详情里的「一跳关系」。
 *
 * 为什么详情要单独读一次：关系实例（边）存在**业务库**里（D2 的 `linkSource`），
 * 而详情面板里的对象可能刚从业务库读出来、本体里连副本都没有 —— 不查这一下，
 * 用户看到的就是一个有属性、却和谁都没关系的对象。
 *
 * 点一条关系跳到另一端：那端已经在本页列表里就直接选中，否则先换到它的对象类型再选中。
 */

export function ObjectLinkList({ links, loading, hint, onOpen }: { links: ObjectLinkView[]; loading: boolean; hint: string; onOpen: (link: ObjectLinkView) => void }) {
  return <div className="detail-links">
    <div className="detail-links-head"><Link2 size={14} /><b>一跳关系</b><span>{loading ? "读取中…" : `${links.length} 条`}</span></div>
    {links.map((link) => <button key={link.linkRef} className="detail-link" onClick={() => onOpen(link)} title={`${link.otherType} · ${link.otherRef}`}>
      <span className="detail-link-arrow">{link.direction === "out" ? "→" : "←"}</span>
      <b>{link.relationshipType}</b>
      <span className="detail-link-other">{link.otherTitle || link.otherRef}</span>
      <span className="detail-link-type">{link.otherType}</span>
    </button>)}
    {!links.length && !loading ? <p className="subtle">{hint}</p> : null}
  </div>;
}

export function EntityManager({ ontologyId, target, user, version, draft, runtimeTypes, ensureDraft, onSnapshotChange, notify, onRunAction, fail, entityLimit, focusEntityId, onFocusHandled }: { ontologyId: string; target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; ensureDraft: () => Promise<Version>; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; onRunAction: (actionId: string, subject: { id: string; labels: string[]; properties: Record<string, unknown>; objectRef?: string }) => void; fail: (reason: unknown) => void; entityLimit: number; focusEntityId?: string | null; onFocusHandled?: () => void }) {
  const [rows, setRows] = useState<EntityRow[]>([]);
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  /**
   * 对象从哪来：`index` = 本体里已物化的对象（＝原来的快照节点），
   * `source` = 按对象类型绑定的数据资源实时读业务库，`auto` = 索引里有这个类型就用索引，否则回源。
   * 只在**已发布视图**下可选；草稿视图读的是正在编辑的那一版快照，没有回源这回事。
   */
  const [origin, setOrigin] = useState<"auto" | "index" | "source">("auto");
  const [total, setTotal] = useState<number | null>(null);
  const [keyById, setKeyById] = useState<Record<string, Record<string, string>>>({});
  const [originById, setOriginById] = useState<Record<string, "index" | "source">>({});
  /*
   * 对象服务的读路径和"有没有草稿"无关：回业务库取数是只读的，草稿只决定能不能**编辑**行。
   * 以前这里写 `!draft`，结果是"补齐数据资源绑定"（要建草稿）一做完，对象页就再也读不出业务数据，
   * 得先发布才看得到 —— 顺序全反了。
   */
  const objectServiceView = Boolean(target);
  // 推理页点证据跳过来时，直接把光标落在那个对象上（组件是切视图时重新挂载的，初值就够）。
  const [selectedId, setSelectedId] = useState<string | null>(focusEntityId ?? null);
  const [draftProps, setDraftProps] = useState<Record<string, unknown>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * 还差数据资源绑定的来源（没绑的 + 指向已删资源的）。
   * 不补的表现是"对象页一条都读不出来"，所以这里要主动提示，并给一个能改的入口。
   *
   * **初值必须是 `null`（还没读到），不能是 `[]`**：`brokenSourcesOf` 判的是"这个 dataSourceId
   * 在不在已知清单里"，先给空数组等于告诉它"本机一个数据资源都没有"，
   * 于是 42 个已经绑好的来源在首帧全被判成"没绑" —— 刚点进「对象」就闪一条红色告警，
   * 等 `/api/data-sources` 回来又自己消失（2026-10-09 用户报的"立马出来弹出一个红色的东西然后很快消失"）。
   */
  const [sourceIds, setSourceIds] = useState<string[] | null>(null);
  const [bindOpen, setBindOpen] = useState(false);

  useEffect(() => {
    // 读不到就保持"还不知道"：宁可少提示一次，也不要报一条"全都绑飞了"的假警。
    void api<{ id: string }[]>("/api/data-sources").then((sources) => setSourceIds(sources.map((source) => source.id))).catch(() => setSourceIds(null));
  }, [version?.id]);

  /**
   * 选中对象的一跳关系（D2）。关系实例在**业务库**里，快照里没有，
   * 所以详情面板要单独问一次 `/api/links`；读出来的边只有配上 `linkSource` 的关系类型才有。
   */
  const [links, setLinks] = useState<ObjectLinkView[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);

  /** 这一行的业务主键：对象服务给过就用它，否则按定义从属性里推（纯函数，客户端也能跑）。 */
  const primaryKeyOf = (row: EntityRow) => {
    const known = keyById[row.id];
    if (known && Object.keys(known).length) return known;
    const entityType = version?.definition.entityTypes.find((item) => item.name === row.labels[0]);
    if (!entityType) return {};
    return primaryKeyFromProperties(entityType, row.properties).primaryKey;
  };

  /** 读某个对象的一跳关系；另一端在本页列表里的时候顺手把它的标题取出来显示。 */
  const loadLinks = useCallback(async (row: EntityRow, page: EntityRow[]) => {
    if (!target) { setLinks([]); return; }
    const entityType = row.labels[0] ?? "";
    const primaryKey = primaryKeyOf(row);
    const key = Object.entries(primaryKey).map(([column, value]) => `${column}=${value}`).join("&");
    if (!entityType || !key) { setLinks([]); return; }
    setLinksLoading(true);
    try {
      const params = new URLSearchParams({ targetId: target.id, entityType });
      if (version?.id) params.set("versionId", version.id);
      params.append("key", key);
      // 关系类型还没配数据来源时这里读回空边，那是正常的建模中间状态，不是错误。
      const data = await api<{ links: BusinessLink[] }>(`/api/links?${params.toString()}`).catch(() => ({ links: [] as BusinessLink[] }));
      const titleOf = new Map(page.map((item) => [item.id, entityTitle(item, version?.definition ?? null)]));
      setLinks(data.links.map((link) => {
        const outgoing = link.source.objectId === row.id;
        const other = outgoing ? link.target : link.source;
        return {
          linkRef: link.linkRef,
          relationshipType: link.relationshipType,
          direction: outgoing ? "out" : "in",
          otherType: other.entityType,
          otherId: other.objectId,
          otherRef: other.objectRef,
          otherTitle: titleOf.get(other.objectId) ?? "",
        } as ObjectLinkView;
      }));
    } catch (reason) { fail(reason); } finally { setLinksLoading(false); }
    // primaryKeyOf / entityTitle 都是纯函数，跟着下面这几项变就够了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, keyById, fail]);

  useEffect(() => {
    const row = rows.find((item) => item.id === selectedId);
    // 选中项不在当前列表里时不用清空：详情面板本来就是空的，而换到"没有主键的对象"时
    // `loadLinks` 自己会把列表清掉。
    if (!row) return;
    // 放进微任务里再读：effect 里同步 setState（loading 标记）会触发级联渲染。
    void Promise.resolve().then(() => loadLinks(row, rows));
    // 选中项或这一页的对象变了都要重问（keyById 由 load 填，跟着 rows 一起变）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, rows, version?.id, target?.id]);

  /** 点一条关系跳到另一端：已经在本页列表里就选中，否则先换到它的对象类型再选中。 */
  const revealRelated = async (link: ObjectLinkView) => {
    const pick = (row: EntityRow) => { setSelectedId(row.id); setDraftProps(Object.fromEntries(Object.entries(row.properties).filter(([key]) => key !== "fx" && key !== "fy"))); };
    const current = rows.find((item) => item.id === link.otherId);
    if (current) { pick(current); return; }
    try {
      const next = await load(link.otherType, "");
      const target2 = next.find((item) => item.id === link.otherId);
      if (target2) pick(target2);
      else notify(`「${link.otherType}」的列表里没找到这个对象（可能不在前 ${entityLimit} 条里）。`);
    } catch (reason) { fail(reason); }
  };

  /** 一跳关系为空的两种原因，说法不一样：没配来源 vs 真的没有边。 */
  const linkHint = (version?.definition.relationshipTypes ?? []).some((item) => item.linkSource?.dataSourceId)
    ? "这个对象在业务库里没有一跳关系。"
    : "关系类型还没配数据来源，业务库里读不出关系 —— 到「关系类型」里给关系配上数据来源，这里就能看到它连接的对象。";
  // 数据资源清单还没回来就先不判 —— 名单不全时候的"断链"判断没有意义。
  const brokenSources = version && sourceIds ? brokenSourcesOf(version.definition, sourceIds) : [];

  const load = useCallback(async (nextLabel: string, nextSearch: string, versionId = version?.id): Promise<EntityRow[]> => {
    if (!target) return [];
    try {
      // 已发布视图 + 选了具体对象类型：走对象服务（索引/回源），于是业务数据也能出现在对象页。
      if (objectServiceView && nextLabel) {
        const params = new URLSearchParams({ targetId: target.id, entityType: nextLabel, limit: String(entityLimit), origin });
        if (nextSearch) params.set("text", nextSearch);
        // 带上正在看的那一版：草稿里刚补好的来源绑定要当场生效，不用发布才认。
        if (versionId) params.set("versionId", versionId);
        const data = await api<{ rows: { objectId: string; entityType: string; properties: Record<string, unknown>; primaryKey: Record<string, string>; origin: "index" | "source" }[]; total: number | null; warnings: string[] }>(`/api/objects?${params.toString()}`);
        const mapped: EntityRow[] = data.rows.map((row) => ({ id: row.objectId, labels: [row.entityType], properties: row.properties }));
        setRows(mapped);
        setTotal(data.total);
        setKeyById(Object.fromEntries(data.rows.map((row) => [row.objectId, row.primaryKey])));
        /*
         * `origin` 说的是"这一行**从哪读的**"，不是"本体里有没有副本"。
         * 用户按「业务库」看时，刚取进草稿的那条**仍然读自业务库**，于是详情里还挂着「取进草稿」按钮 ——
         * 明明副本已经在草稿里、该让他编辑了。所以再对一次草稿快照：这一版里有这个对象才算"已物化"。
         */
        const localIds = new Set<string>();
        if (versionId) {
          const query = new URLSearchParams({ targetId: target.id, versionId, label: nextLabel, limit: String(entityLimit) });
          const local = await api<{ rows: EntityRow[] }>(`/api/instances/entities?${query.toString()}`).catch(() => ({ rows: [] as EntityRow[] }));
          for (const row of local.rows) localIds.add(row.id);
        }
        setOriginById(Object.fromEntries(data.rows.map((row) => [row.objectId, localIds.has(row.objectId) ? "index" : row.origin])));
        if (data.warnings?.length) notify(data.warnings[0]);
        return mapped;
      }
      const params = new URLSearchParams({ targetId: target.id });
      if (versionId) params.set("versionId", versionId);
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      params.set("limit", String(entityLimit));
      const rows = await api<{ rows: EntityRow[] }>(`/api/instances/entities?${params.toString()}`).then((data) => data.rows);
      setRows(rows);
      setTotal(null);
      setKeyById({});
      setOriginById({});
      return rows;
    } catch (reason) { fail(reason); return []; }
  }, [target, version?.id, fail, entityLimit, objectServiceView, origin, notify]);

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<{ rows: EntityRow[] }>(`/api/instances/entities?targetId=${encodeURIComponent(target.id)}${versionParam}&limit=${entityLimit}`).then((data) => {
      setRows(data.rows);
      // 带着目标对象进来时，把编辑缓冲也初始化成它的业务属性，否则点"保存"会用空值覆盖。
      if (focusEntityId) {
        const hit = data.rows.find((row) => row.id === focusEntityId);
        if (hit) setDraftProps(Object.fromEntries(Object.entries(hit.properties).filter(([key]) => key !== "fx" && key !== "fy")));
        onFocusHandled?.();
      }
    }).catch(fail);
    // Entity list is re-fetched when the selected target, version or display limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, entityLimit]);

  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const definitions = selected ? effectivePropertiesFor(version?.definition ?? null, selected.labels) : null;
  const managed = Boolean(definitions);

  const save = async () => {
    if (!target || !selected) return;
    try { setBusy(true); const current = await ensureDraft(); const updated = await api<EntityRow>(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "PATCH", body: JSON.stringify({ properties: draftProps }) }); setRows((rows) => rows.map((row) => row.id === updated.id ? updated : row)); await onSnapshotChange(); notify(`对象属性已保存到草稿快照，发布前不会影响 ${graphNoun(target)}。`); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!target || !selected) return;
    if (!window.confirm("删除该节点及其所有关系？")) return;
    try { setBusy(true); const current = await ensureDraft(); await api(`/api/instances/entities/${encodeURIComponent(selected.id)}?targetId=${target.id}&versionId=${current.id}`, { method: "DELETE" }); setSelectedId(null); await onSnapshotChange(); notify("对象及其关联关系已从草稿快照删除。"); await load(label, search, current.id); } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  /**
   * 把数据资源里的对象取进草稿快照。
   * 动作与属性编辑都作用在草稿快照上，而数据源里的对象本体里没有副本 —— 先按主键取进来
   * （身份是确定性的，重复取不会造出第二份），之后就能像普通对象一样编辑 / 跑动作。
   */
  const materialize = async (row: EntityRow) => {
    if (!target) return;
    try {
      setBusy(true);
      const current = await ensureDraft();
      const key = Object.entries(keyById[row.id] ?? {}).map(([column, value]) => `${column}=${value}`).join("&");
      if (!key) throw new Error("这条对象没有主键，没法按主键取进草稿；请先给它配主键。");
      // 返回的是对象服务里的 `ObjectRecord`（主键叫 `objectId`），不是图库行 —— 类型写错过一次，
      // 取进草稿之后选中项被 `undefined` 顶掉，详情直接回到"选择一条对象"。
      const result = await api<{ record: { objectId: string; properties: Record<string, unknown> }; created: boolean }>("/api/objects/materialize", {
        method: "POST",
        body: JSON.stringify({ targetId: target.id, versionId: current.id, entityType: row.labels[0], key }),
      });
      notify(result.created ? "对象已取进草稿快照，现在可以编辑或对它执行动作。" : "这个对象已经在草稿快照里了。");
      setSelectedId(result.record.objectId);
      setDraftProps(Object.fromEntries(Object.entries(result.record.properties).filter(([key2]) => key2 !== "fx" && key2 !== "fy")));
      await onSnapshotChange();
      await load(label, search, current.id);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <ResizableManagerGrid storageKey="ontology.manager-split.entities">
    <div className="panel functional-panel result-list">
      <span className="eyebrow">对象</span>
      <h2>{rows.length} 条{total !== null && total !== rows.length ? ` · 共 ${total} 条` : ""}</h2>
      <p className="subtle">{objectServiceView ? "选中一个对象类型后可以切换数据来源：已物化的对象（本体里有的）或业务库实时取数（表里有多少就能看多少）。" : "草稿视图读的是正在编辑的那一版快照；数据源里的对象要先「取进草稿」才能编辑。"}</p>
      {brokenSources.length > 0 && <div className="notice error">
        <AlertCircle size={15} />
        <span>{brokenSources.length} 个来源还没绑到数据资源（{brokenSources.slice(0, 2).map((item) => `${item.entityTypeName} · ${item.label}`).join("、")}{brokenSources.length > 2 ? " 等" : ""}），这些对象类型读不出数据。</span>
        {may(user, "ontology.write") && <button className="action compact" style={{ marginLeft: "auto" }} onClick={() => { void ensureDraft().then(() => setBindOpen(true)).catch(fail); }}>补齐数据资源绑定</button>}
      </div>}
      <div className="manager-toolbar">
        <select value={label} onChange={(event) => { setLabel(event.target.value); void load(event.target.value, search); }}><option value="">全部标签</option>{[...new Set([...(version?.definition.entityTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.labels.map((item) => item.name) ?? [])])].map((name) => <option key={name} value={name}>{name}</option>)}</select>
        {objectServiceView && label ? <select value={origin} onChange={(event) => { const next = event.target.value as "auto" | "index" | "source"; setOrigin(next); void load(label, search); }} title="对象从哪来"><option value="auto">来源：自动</option><option value="index">来源：已物化</option><option value="source">来源：业务库</option></select> : null}
        <input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(label, search); }} placeholder="按显示名称搜索…" />
        <button className="action compact" onClick={() => void load(label, search)}><Search size={14} /></button>
        <button className="action compact" onClick={() => setCreateOpen(true)}><Plus size={14} />新建</button>
      </div>
      <div className="manager-rows">{rows.map((row) => <button key={row.id} className={selectedId === row.id ? "manager-row selected" : "manager-row"} onClick={() => { setSelectedId(row.id); setDraftProps(Object.fromEntries(Object.entries(row.properties).filter(([key]) => key !== "fx" && key !== "fy"))); }}><CircleDot size={15} /><span><b>{entityTitle(row, version?.definition ?? null)}</b><small>{row.labels.join(", ")} · {propertySummary(row.properties)}</small></span></button>)}{!rows.length && <p className="empty">没有匹配的对象。</p>}</div>
    </div>
    <div className="panel functional-panel detail-panel">
      {selected ? <><span className="eyebrow">选中对象</span><h2>{entityTitle(selected, version?.definition ?? null)}</h2><div className="detail-meta"><span>{selected.labels.join(", ") || "无标签"}</span><code>{selected.id}</code></div><ScopedActions definition={version?.definition ?? null} versionId={version?.id} subjectId={selected.id} labels={selected.labels} disabled={!may(user, "instance.write")} onRun={(actionId) => onRunAction(actionId, { ...selected, objectRef: originById[selected.id] === "source" ? `${selected.labels[0]}/${Object.entries(keyById[selected.id] ?? {}).map(([column, value]) => `${column}=${value}`).join("&")}` : undefined })} />{originById[selected.id] === "source" ? <p className="subtle">这条对象来自业务库（实时读取，本体里还没有副本）：要编辑或对它执行动作，先「取进草稿」。</p> : null}{may(user, "instance.write") && originById[selected.id] === "source" ? <div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void materialize(selected)}><Plus size={15} />取进草稿</button></div> : null}{may(user, "instance.write") && originById[selected.id] !== "source" ? <><PropertyEditor key={selected.id} definitions={definitions ?? []} values={selected.properties} mode={managed ? "managed" : "raw"} onChange={setDraftProps} /><div className="functional-actions"><button className="action primary" disabled={busy} onClick={() => void save()}><Pencil size={15} />保存到草稿</button><button className="action danger" disabled={busy} onClick={() => void remove()}><Trash2 size={15} />从草稿删除</button></div><p className="subtle">{draft ? "修改当前草稿快照。" : may(user, "ontology.write") ? "首次修改会基于当前发布版本自动创建草稿。" : "当前还没有草稿：创建草稿要「编辑草稿」权限，先让有该权限的账号建一次草稿，或者给当前角色补上这个权限。"}</p></> : <><div className="graph-properties">{Object.entries(selected.properties).filter(([key]) => key !== "fx" && key !== "fy").map(([key, value]) => <div key={key}><span>{key}</span><b>{typeof value === "object" ? JSON.stringify(value) : String(value)}</b></div>)}</div><p className="subtle">查看者只能浏览属性。</p></>}<ObjectLinkList links={links} loading={linksLoading} hint={linkHint} onOpen={(link) => void revealRelated(link)} /></> : <div className="graph-inspector-empty"><CircleDot size={20} /><b>选择一条对象</b><span>点击左侧列表中的对象查看与编辑属性。</span></div>}
    </div>
    {may(user, "instance.write") && createOpen && <EntityCreateDialog published={version} runtimeTypes={runtimeTypes} onClose={() => setCreateOpen(false)} onCreate={async (label, properties) => { try { if (!target) throw new Error("请先选择本体存储。"); const current = await ensureDraft(); await api("/api/instances/entities", { method: "POST", body: JSON.stringify({ targetId: target.id, versionId: current.id, entityType: label, properties }) }); notify("对象已加入草稿快照。"); setCreateOpen(false); await load(label, search, current.id); await onSnapshotChange(); } catch (reason) { fail(reason); } }} />}
    {bindOpen && <BindSourcesDialog ontologyId={ontologyId} onClose={() => setBindOpen(false)} onSaved={async (count) => { setBindOpen(false); notify(`已补齐 ${count} 个数据来源绑定。`); await onSnapshotChange(); await load(label, search); }} fail={fail} />}
  </ResizableManagerGrid>;
}


export function EntityCreateDialog({ published, runtimeTypes, onClose, onCreate }: { published: Version | null; runtimeTypes: RuntimeTypeSet | null; onClose: () => void; onCreate: (label: string, properties: Record<string, unknown>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [properties, setProperties] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const definitions = effectivePropertiesFor(published?.definition ?? null, [label]);
  const options = useMemo(() => [...new Set([...(published?.definition.entityTypes.map((item) => item.name) ?? []), ...(runtimeTypes?.labels.map((item) => item.name) ?? [])])], [published, runtimeTypes]);
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); if (!label.trim()) return; setBusy(true); void onCreate(label.trim(), properties).finally(() => setBusy(false)); }}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><CircleDot size={22} /></div><span className="eyebrow">新建对象</span><h2>选择节点标签</h2><label>标签<select value={label} onChange={(event) => setLabel(event.target.value)} required><option value="">选择标签</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><PropertyEditor definitions={definitions ?? []} values={properties} mode="managed" onChange={setProperties} /><div className="dialog-actions"><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!label.trim() || busy}>{busy ? "创建中…" : "创建对象"}</button></div></form></div>;
}
