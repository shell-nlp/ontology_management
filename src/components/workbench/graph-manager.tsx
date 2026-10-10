"use client";

import { type User, type BusinessLink, type NodeKeyMap, type Target, type Version, graphNoun, type GraphSettings, useGraphSettings } from "@/components/workbench/shared";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Eraser, Search, Settings2, X } from "lucide-react";
import { GraphCanvas } from "@/components/graph-canvas";
import { api } from "@/lib/api-client";
import { DEFAULT_GRAPH_TARGET_KIND, graphTargetKindInfo, type GraphData, type GraphNode, type GraphRelationship, type GraphTargetKind, type RuntimeTypeSet } from "@/lib/graph/types";
import { propertyForColumn } from "@/lib/ontology-fields";




export type QueryResult = { keys: string[]; records: Record<string, unknown>[]; graph: GraphData; summary: string };


export type QueryTemplate = { defaultQuery: string; placeholder: string; visualizationHint: string };

export const JENA_QUERY_TEMPLATE: QueryTemplate = { defaultQuery: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", placeholder: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", visualizationHint: "以 ?s / ?p / ?o 为变量名返回三元组即可可视化；也可以用 CONSTRUCT 构造子图。" };

/** 两个后端都提供相同的只读 SPARQL 工作台模板。 */

export function queryTemplateFor(_kind: GraphTargetKind | undefined): QueryTemplate {
  return JENA_QUERY_TEMPLATE;
}

/** 只用于前端即时提示；真正的写保护在服务端按后端能力判断。 */

export function isWriteStatement(kind: GraphTargetKind | undefined, statement: string) {
  void kind;
  return /\b(insert|delete|load|clear|create|drop|add|move|copy)\b/i.test(statement);
}

/**
 * 只有 `target.read` 的角色拿不到图引擎连接清单，但本体列表里带着落点（id / 名称 / 类型 / 地址）。
 * 用它拼一个**只读**的 Target 兜底，让「本体建模」这类只看定义的页面照常能打开。
 * 连接细节（库名、账号、参数）这里没有，也不该有 —— 那些要 `target.read`。
 */


export function capResult(result: QueryResult, recordLimit: number): QueryResult {
  return { ...result, records: result.records.slice(0, recordLimit), graph: { nodes: result.graph.nodes.slice(0, recordLimit), relationships: result.graph.relationships.slice(0, recordLimit) } };
}


export function GraphSettingsDialog({ settings, onSave, onReset, onClose }: { settings: GraphSettings; onSave: (next: GraphSettings) => void; onReset: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  const field = (key: keyof GraphSettings, label: string, note: string, max: number) => (
    <label className="settings-field" key={key}>
      <span>{label}</span>
      <input type="number" min={1} max={max} value={draft[key]} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) })} />
      <small>{note}</small>
    </label>
  );
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="dialog graph-dialog" onSubmit={(event) => { event.preventDefault(); onSave(draft); onClose(); }}>
        <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
        <div className="dialog-icon"><Settings2 size={22} /></div>
        <span className="eyebrow">可视化配置</span>
        <h2>图谱渲染限制</h2>
        <p>默认不会一次性加载全部图数据，按下述上限控制每次取数规模。</p>
        <div className="settings-grid">
          {field("nodeLimit", "可视化节点上限", "首次加载与刷新时最多渲染的节点数。", 10000)}
          {field("maxNeighbors", "最大新增邻居数", "扩展一度邻居时最多加入的邻居数量。", 10000)}
          {field("recordLimit", "单次记录上限", "单条只读查询最多获取并展示的记录条数（SPARQL）。", 100000)}
        </div>
        <div className="dialog-actions">
          <button type="button" className="quiet-button" onClick={onReset}>恢复默认</button>
          <button type="button" className="quiet-button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit">保存配置</button>
        </div>
      </form>
    </div>
  );
}

/**
 * 左侧导航，按 Palantir 的说法分成两半：
 * 本体模型是「本体是什么」（对象类型、属性和关系类型）；
 * 动力模型是「本体能做什么」（动作，以及挂在动作上的规则 / 动态安全）。
 * 本体列表与当前本体状态合在「总览」；存储资源放进「设置」，数据资源仍在平台分组。
 * 面包屑复用同一份标签，避免导航写中文、面包屑还露着英文 id。
 */

export function ClearGraphDialog({ target, onClose, onCleared, fail }: { target: Target; onClose: () => void; onCleared: () => Promise<void>; fail: (reason: unknown) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<{ nodes: number; relationships: number } | null>(null);
  const [counting, setCounting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api<{ nodes: number; relationships: number }>(`/api/targets/${target.id}/clear`)
      .then((data) => { if (!cancelled) setCounts(data); })
      .catch(() => { if (!cancelled) setCounts(null); })
      .finally(() => { if (!cancelled) setCounting(false); });
    return () => { cancelled = true; };
  }, [target.id]);

  const matched = text.trim() === target.name;
  const run = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      await api(`/api/targets/${target.id}/clear`, { method: "POST", body: JSON.stringify({ confirm: text }) });
      await onCleared();
      onClose();
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog graph-dialog" onSubmit={run}>
      <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
      <div className="dialog-icon"><Eraser size={22} /></div>
      <span className="eyebrow">危险操作</span>
      <h2>清空「{target.name}」的图数据？</h2>
      <p>将删除这个图库里的全部节点与关系{counting ? "（正在统计…）" : counts ? `（当前 ${counts.nodes} 个对象、${counts.relationships} 条关系）` : ""}，无法撤销。平台的版本记录与快照不会被删除，重新发布一次即可写回。</p>
      <label>键入本体存储名称 <b>{target.name}</b> 以确认<input value={text} onChange={(event) => setText(event.target.value)} placeholder={target.name} autoFocus /></label>
      <div className="dialog-actions">
        <button type="button" className="quiet-button" onClick={onClose}>取消</button>
        <button className="primary-button" disabled={!matched || busy}>{busy ? "清空中…" : "确认清空"}</button>
      </div>
    </form>
  </div>;
}


export type CypherSuggestion = { text: string; kind: string };

export const CYPHER_KEYWORDS = ["MATCH", "OPTIONAL MATCH", "WHERE", "WITH", "RETURN", "UNWIND", "ORDER BY", "SKIP", "LIMIT", "UNION", "CREATE", "MERGE", "SET", "REMOVE", "DELETE", "DETACH DELETE", "CALL", "YIELD", "AS", "DISTINCT", "USING", "INDEX", "EXISTS", "EXPLAIN", "PROFILE", "FOREACH", "LOAD CSV", "START", "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "XOR", "IN", "IS NULL", "IS NOT NULL", "CONTAINS", "STARTS WITH", "ENDS WITH"];

export const CYPHER_FUNCTIONS = ["count", "sum", "avg", "min", "max", "collect", "count(*)", "coalesce", "exists", "size", "length", "keys", "properties", "labels", "type", "elementId", "id", "startNode", "endNode", "toString", "toInteger", "toFloat", "toBoolean", "toUpper", "toLower", "trim", "ltrim", "rtrim", "substring", "replace", "split", "left", "right", "reverse", "head", "last", "tail", "range", "reduce", "abs", "ceil", "floor", "round", "sign", "sqrt", "exp", "log", "log10", "rand", "pi", "date", "datetime", "time", "duration", "point", "distance", "randomUUID", "timestamp"];

export const DEFAULT_CYPHER_SUGGESTIONS: CypherSuggestion[] = ["MATCH", "OPTIONAL MATCH", "WHERE", "WITH", "RETURN", "UNWIND", "ORDER BY", "LIMIT", "SKIP", "CREATE", "MERGE", "SET", "REMOVE", "DELETE", "CALL", "YIELD", "DISTINCT", "CASE", "FOREACH"].map((text) => ({ text, kind: "关键字" }));

export const SPARQL_KEYWORDS = ["SELECT", "DISTINCT", "WHERE", "PREFIX", "BASE", "CONSTRUCT", "DESCRIBE", "ASK", "FROM", "NAMED", "OPTIONAL", "UNION", "MINUS", "FILTER", "BIND", "VALUES", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "ASC", "DESC", "AS", "GRAPH", "SERVICE", "EXISTS", "NOT EXISTS", "STR", "LANG", "DATATYPE", "BOUND", "IRI", "STRUUID", "REGEX", "REPLACE", "CONCAT", "SUBSTR", "STRLEN", "UCASE", "LCASE", "CONTAINS", "STRSTARTS", "STRENDS", "COUNT", "SUM", "AVG", "MIN", "MAX", "SAMPLE", "GROUP_CONCAT"];

export const DEFAULT_SPARQL_SUGGESTIONS: CypherSuggestion[] = ["SELECT", "WHERE", "PREFIX", "CONSTRUCT", "ASK", "OPTIONAL", "FILTER", "UNION", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "VALUES", "BIND", "GRAPH", "DISTINCT"].map((text) => ({ text, kind: "关键字" }));


export function cypherFilter(items: string[], partial: string, kind: string): CypherSuggestion[] {
  const p = partial.toLowerCase();
  return items.filter((item) => item.toLowerCase().includes(p)).map((item) => {
    const lower = item.toLowerCase();
    return { text: item, kind, score: (lower.startsWith(p) ? 0 : 1) + lower.indexOf(p) / 1000 };
  }).sort((a, b) => a.score - b.score).map(({ text, kind: k }) => ({ text, kind: k }));
}


export function CypherEditor({ value, onChange, language = "cypher", labels, relationshipTypes, propertyKeys, placeholder }: { value: string; onChange: (next: string) => void; language?: "cypher" | "sparql"; labels: string[]; relationshipTypes: string[]; propertyKeys: string[]; placeholder?: string }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [wordStart, setWordStart] = useState(0);
  const [suggestions, setSuggestions] = useState<CypherSuggestion[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const refresh = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    setCaret(cursor);
    const before = textarea.value.slice(0, cursor);
    const match = /[\p{L}\p{N}_]+$/u.exec(before);
    const word = match ? match[0] : "";
    const start = match ? cursor - word.length : cursor;
    const head = before.slice(0, start);
    const trimmed = head.trimEnd();
    const prev = trimmed[trimmed.length - 1] ?? "";
    let list: CypherSuggestion[];
    if (prev === ".") {
      list = cypherFilter(propertyKeys, word, "属性").slice(0, 12);
    } else if (prev === ":") {
      const inBrackets = (head.match(/\[/g) ?? []).length > (head.match(/\]/g) ?? []).length;
      list = cypherFilter(inBrackets ? relationshipTypes : labels, word, inBrackets ? "关系类型" : "标签").slice(0, 12);
    } else if (!word) {
      list = language === "sparql" ? DEFAULT_SPARQL_SUGGESTIONS : DEFAULT_CYPHER_SUGGESTIONS;
    } else if (language === "sparql") {
      list = cypherFilter(SPARQL_KEYWORDS, word, "关键字").slice(0, 12);
    } else {
      list = [...cypherFilter(CYPHER_KEYWORDS, word, "关键字"), ...cypherFilter(CYPHER_FUNCTIONS, word, "函数")].slice(0, 12);
    }
    setWordStart(start);
    setSuggestions(list);
    setHighlight(0);
  }, [labels, relationshipTypes, propertyKeys, language]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const marker = markerRef.current;
    if (!textarea || !marker || suggestions.length === 0) { setPos(null); return; }
    const rect = marker.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    setPos({ top: rect.top - textarea.scrollTop + lineHeight + 4, left: rect.left - textarea.scrollLeft });
  }, [caret, suggestions]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(event.target as Node)) setSuggestions([]); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const accept = (suggestion: CypherSuggestion) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const before = textarea.value.slice(0, wordStart);
    const after = textarea.value.slice(textarea.selectionStart);
    const insert = suggestion.text + (suggestion.kind === "关键字" ? " " : "");
    const next = before + insert + after;
    onChange(next);
    setSuggestions([]);
    window.requestAnimationFrame(() => {
      textarea.focus();
      const position = (before + insert).length;
      textarea.setSelectionRange(position, position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((h) => (h + 1) % Math.min(suggestions.length, 8)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => (h - 1 + Math.min(suggestions.length, 8)) % Math.min(suggestions.length, 8)); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); accept(suggestions[highlight] ?? suggestions[0]); }
    else if (event.key === "Escape") { setSuggestions([]); }
  };

  return <div className="cypher-editor" ref={containerRef}><div className="cypher-input cypher-mirror" aria-hidden="true">{value.slice(0, caret)}<span ref={markerRef}>&#8203;</span>{value.slice(caret)}</div><textarea ref={textareaRef} className="cypher-input" value={value} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => onChange(event.target.value)} onSelect={refresh} onKeyUp={refresh} onClick={refresh} onKeyDown={onKeyDown} />{suggestions.length > 0 && pos && <div className="cypher-suggest" style={{ top: pos.top, left: pos.left }} onMouseDown={(event) => event.preventDefault()}>{suggestions.slice(0, 8).map((suggestion, index) => <button key={`${suggestion.kind}-${suggestion.text}`} className={index === highlight ? "active" : ""} onClick={() => accept(suggestion)}><span className="cypher-suggest-kind">{suggestion.kind}</span>{suggestion.text}</button>)}</div>}</div>;
}


export function GraphManager({ target, user, version, draft, runtimeTypes, onSnapshotChange, notify, fail }: { target: Target | null; user: User; version: Version | null; draft: Version | null; runtimeTypes: RuntimeTypeSet | null; onSnapshotChange: () => Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [graph, setGraph] = useState<GraphData>({ nodes: [], relationships: [] });
  const [label, setLabel] = useState("");
  const [search, setSearch] = useState("");
  const [typeFilters, setTypeFilters] = useState({ labels: [] as string[], relationshipTypes: [] as string[] });
  const [loading, setLoading] = useState(false);
  const { settings, update, reset } = useGraphSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [queryDraft, setQueryDraft] = useState<{ kind: GraphTargetKind | undefined; text: string } | null>(null);
  const [cypherOpen, setCypherOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const queryTemplate = queryTemplateFor(target?.kind);
  // 用户改过的语句保留；切换图数据库后端时自动回落到该后端的默认语句。
  const cypher = queryDraft && queryDraft.kind === target?.kind ? queryDraft.text : queryTemplate.defaultQuery;
  const setCypher = (next: string) => setQueryDraft({ kind: target?.kind, text: next });
  const cypherIsWrite = isWriteStatement(target?.kind, cypher);
  const [cypherMeta, setCypherMeta] = useState<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>({ labels: [], relationshipTypes: [], propertyKeys: [] });
  /** 「从数据源加载」：按对象类型从业务库实时取一批对象作为节点（本体里不落副本）。 */
  const [sourceType, setSourceType] = useState("");
  const [sourceLimit, setSourceLimit] = useState(50);
  const [sourceLoading, setSourceLoading] = useState(false);
  /** 从业务库读来的节点：记下它的 (对象类型, 主键)，点它展开时才能继续走 D2 的关系数据来源。 */
  const [keysByNodeId, setKeysByNodeId] = useState<NodeKeyMap>({});

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<{ labels: string[]; relationshipTypes: string[]; propertyKeys: string[] }>(`/api/instances/meta?targetId=${encodeURIComponent(target.id)}${versionParam}`).then(setCypherMeta).catch(() => {});
    // Schema metadata is re-fetched only when the selected target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id]);

  const cypherLabels = useMemo(() => [...new Set([...cypherMeta.labels, ...(version?.definition.entityTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.labels, version]);
  const cypherRelationshipTypes = useMemo(() => [...new Set([...cypherMeta.relationshipTypes, ...(version?.definition.relationshipTypes.map((item) => item.name) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.relationshipTypes, version]);
  const cypherPropertyKeys = useMemo(() => [...new Set([...cypherMeta.propertyKeys, ...(version?.definition.entityTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? []), ...(version?.definition.relationshipTypes.flatMap((item) => item.properties.map((prop) => prop.name)) ?? [])])].sort((a, b) => a.localeCompare(b)), [cypherMeta.propertyKeys, version]);

  const load = useCallback(async (nextLabel: string, nextSearch: string, nodeLimit: number, filters = typeFilters) => {
    if (!target) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ targetId: target.id });
      if (version) params.set("versionId", version.id);
      if (nextLabel) params.set("label", nextLabel);
      if (nextSearch) params.set("search", nextSearch);
      for (const type of filters.labels) params.append("graphLabel", type);
      for (const type of filters.relationshipTypes) params.append("relationshipType", type);
      params.set("nodeLimit", String(nodeLimit));
      setGraph(await api<GraphData>(`/api/instances/graph?${params.toString()}`));
    } catch (reason) { fail(reason); } finally { setLoading(false); }
  }, [target, version, fail, typeFilters]);

  useEffect(() => {
    if (!target) return;
    const versionParam = version ? `&versionId=${version.id}` : "";
    void api<GraphData>(`/api/instances/graph?targetId=${encodeURIComponent(target.id)}${versionParam}&nodeLimit=${settings.nodeLimit}`).then(setGraph).catch(fail);
    // Graph is re-fetched when the selected target or the node limit changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, version?.id, settings.nodeLimit]);

  /** 节点的业务主键 → `/api/links` 认得的 `列=值&列=值`。 */
  const keyParamOf = (primaryKey: Record<string, string>) => Object.entries(primaryKey).map(([column, value]) => `${column}=${value}`).join("&");

  /** 把节点与边并进当前图（按 id 去重）：几个加载入口共用，别各写一遍。 */
  const mergeIntoGraph = (nodes: GraphNode[], relationships: GraphRelationship[]) => {
    setGraph((current) => ({
      nodes: [...new Map([...current.nodes, ...nodes].map((node) => [node.id, node])).values()],
      relationships: [...new Map([...current.relationships, ...relationships].map((link) => [link.id, link])).values()],
    }));
  };

  /**
   * 把边的另一端也取成节点。
   * **按对象类型分组 + IN 过滤，一个类型一个请求** —— 一条边一个请求会把业务库打爆（Oracle 一次往返 ~500ms）。
   * 复合主键的端点先不铺开（很少见，铺开要按每个对象各取一次）。
   * 顺带把这些节点登记进 `keysByNodeId`，下次点它们也能接着展开。
   */
  const loadLinkNeighbors = async (links: BusinessLink[], known: Set<string>) => {
    if (!target) return { nodes: [] as GraphNode[], keys: {} as NodeKeyMap };
    const buckets = new Map<string, { property: string; values: Set<string> }>();
    for (const link of links) {
      for (const side of [link.source, link.target]) {
        if (known.has(side.objectId)) continue;
        const columns = Object.keys(side.primaryKey);
        if (columns.length !== 1) continue;
        const entityType = (version?.definition.entityTypes ?? []).find((item) => item.name === side.entityType);
        const property = entityType ? propertyForColumn(entityType, columns[0]) : "";
        if (!property) continue;
        const bucket = buckets.get(side.entityType) ?? { property, values: new Set<string>() };
        bucket.values.add(side.primaryKey[columns[0]]);
        buckets.set(side.entityType, bucket);
      }
    }
    type NeighborRow = { objectId: string; entityType: string; properties: Record<string, unknown>; primaryKey: Record<string, string> };
    const nodes: GraphNode[] = [];
    const keys: NodeKeyMap = {};
    for (const [entityType, bucket] of buckets) {
      const query = new URLSearchParams({ targetId: target.id, entityType, origin: "source", limit: String(settings.nodeLimit) });
      if (version?.id) query.set("versionId", version.id);
      query.append("filter", `${bucket.property}:IN:${[...bucket.values].join(",")}`);
      const data = await api<{ rows: NeighborRow[] }>(`/api/objects?${query.toString()}`).catch(() => ({ rows: [] as NeighborRow[] }));
      for (const row of data.rows) {
        nodes.push({ id: row.objectId, labels: [row.entityType], properties: row.properties });
        keys[row.objectId] = { entityType: row.entityType, primaryKey: row.primaryKey ?? {} };
      }
    }
    return { nodes, keys };
  };

  /**
   * 以一批**同类型**对象为起点读 D2 的业务边：过滤下推到业务库（等值 / IN），
   * 再把另一端的对象也取成节点 —— 否则边没有落脚点，图上画不出来。
   *
   * 图谱的两个入口共用它：「从数据源加载」（一批种子）与点节点「扩展一度邻居」（一个种子）。
   * 各写一份的话，会出现"从数据源加载能看到边、点节点展开却还是孤立点"这种前后不一致。
   */
  const readBusinessLinks = async (entityType: string, primaryKeys: Record<string, string>[], known: Set<string>) => {
    const empty = { nodes: [] as GraphNode[], relationships: [] as GraphRelationship[], keys: {} as NodeKeyMap, warnings: [] as string[] };
    if (!target) return empty;
    const params = new URLSearchParams({ targetId: target.id });
    if (version?.id) params.set("versionId", version.id);
    params.set("entityType", entityType);
    for (const primaryKey of primaryKeys) {
      const key = keyParamOf(primaryKey);
      if (key) params.append("key", key);
    }
    // 没有可用的主键就别问了（`/api/links` 会当成参数错误）。
    if (!params.getAll("key").length) return empty;
    /*
     * 关系类型还没配数据来源时，`/api/links` 返回的是空边 —— 那是**正常的建模中间状态**，不是错误。
     * 所以这里兜住异常：界面照常显示"还是孤立点"，而不是弹一片红。
     */
    const linked = await api<{ links: BusinessLink[]; warnings: string[] }>(`/api/links?${params.toString()}`).catch(() => ({ links: [] as BusinessLink[], warnings: [] as string[] }));
    const relationships: GraphRelationship[] = linked.links.map((link) => ({ id: link.linkRef, type: link.relationshipType, source: link.source.objectId, target: link.target.objectId, properties: link.properties }));
    const { nodes, keys } = await loadLinkNeighbors(linked.links, known);
    return { nodes, relationships, keys, warnings: linked.warnings };
  };

  /**
   * 扩展一度邻居。**两条来源合起来才是完整的一度**：
   * 图库那条（已发布 / 草稿快照里的边）走 `/api/instances/neighbors`；
   * 业务库那条（D2 的关系类型数据来源）由 `/api/links` 按主键取 —— 只有从业务库读来的节点才有后一条。
   */
  const expand = async (nodeId: string) => {
    if (!target) return;
    const expanded = await api<GraphData>(`/api/instances/neighbors?targetId=${encodeURIComponent(target.id)}&nodeId=${encodeURIComponent(nodeId)}&limit=${Math.max(1, settings.maxNeighbors)}`);
    const nodes = [...expanded.nodes];
    const relationships = [...expanded.relationships];
    const seed = keysByNodeId[nodeId];
    if (seed && Object.keys(seed.primaryKey).length) {
      const linked = await readBusinessLinks(seed.entityType, [seed.primaryKey], new Set([nodeId, ...nodes.map((node) => node.id)]));
      nodes.push(...linked.nodes);
      relationships.push(...linked.relationships);
      if (linked.relationships.length) notify(`又从业务库取到 ${linked.relationships.length} 条关系、${linked.nodes.length} 个相邻对象。`);
      if (linked.warnings.length) notify(linked.warnings[0]);
    }
    mergeIntoGraph(nodes, relationships);
  };

  /**
   * 从数据源加载一批业务对象作为节点。
   *
   * 这些节点是**实时读业务库**拿到的：本体里没有副本。配好数据来源的关系类型（D2）会一起取回来，
   * 边和另一端的对象都画上；没配的就在提示里说清楚，别让人以为"关系丢了"。
   */
  const loadBusinessObjects = async () => {
    if (!target || !sourceType) return;
    setSourceLoading(true);
    try {
      const params = new URLSearchParams({ targetId: target.id, entityType: sourceType, origin: "source", limit: String(sourceLimit) });
      // 和对象页同一个口径：带上正在看的那一版，草稿里刚补的来源绑定要当场生效。
      if (version?.id) params.set("versionId", version.id);
      const data = await api<{ rows: { objectId: string; entityType: string; properties: Record<string, unknown>; primaryKey: Record<string, string> }[]; total: number | null; warnings: string[] }>(`/api/objects?${params.toString()}`);
      const seedNodes: GraphNode[] = data.rows.map((row) => ({ id: row.objectId, labels: [row.entityType], properties: row.properties }));
      if (!seedNodes.length) { notify(`数据源里没有「${sourceType}」的对象。`); return; }
      const seedKeys: NodeKeyMap = Object.fromEntries(data.rows.map((row) => [row.objectId, { entityType: row.entityType, primaryKey: row.primaryKey }]));

      // 一跳：以这一批节点为起点把边取回来（D2），过滤下推到业务库，而不是把整张连接表拉回来再筛。
      const linked = await readBusinessLinks(sourceType, data.rows.map((row) => row.primaryKey), new Set(seedNodes.map((node) => node.id)));
      mergeIntoGraph([...seedNodes, ...linked.nodes], linked.relationships);
      setKeysByNodeId((current) => ({ ...current, ...seedKeys, ...linked.keys }));
      const message = linked.relationships.length
        ? `已从数据源加载 ${seedNodes.length} 个「${sourceType}」对象、${linked.nodes.length} 个相邻对象，以及它们之间的 ${linked.relationships.length} 条关系。`
        : `已从数据源加载 ${seedNodes.length} 个「${sourceType}」对象${data.total !== null ? `（表里共 ${data.total} 条）` : ""}。这些对象之间没有配好数据来源的关系类型，所以还是孤立点 —— 到「关系类型」里给关系配上数据来源就能连起来。`;
      notify(message);
      if (linked.warnings.length) notify(linked.warnings[0]);
    } catch (reason) { fail(reason); } finally { setSourceLoading(false); }
  };
  const runCypher = useCallback(async () => {
    if (!target) return;
    try {
      if (cypherIsWrite) throw new Error(`版本管理启用后禁止通过 ${graphTargetKindInfo(target.kind).queryLanguageLabel} 工作台直接写入 ${graphTargetKindInfo(target.kind).label}；请在草稿的对象、关系或图谱页面修改数据后发布。`);
      setRunning(true);
      const result = await api<QueryResult>("/api/query", { method: "POST", body: JSON.stringify({ targetId: target.id, query: cypher, confirmWrite: cypherIsWrite }) });
      setGraph(capResult(result, settings.recordLimit).graph);
    } catch (reason) { fail(reason); } finally { setRunning(false); }
  }, [target, cypher, cypherIsWrite, settings.recordLimit, fail]);

  return <section className="stack">
      <div className="panel functional-panel graph-head-panel"><div className="title-row"><div><span className="eyebrow">{draft ? `草稿 v${draft.version_number}` : "已发布图谱"}</span><h2>{draft ? "编辑版本快照" : "浏览当前发布数据"}</h2></div><div className="functional-actions"><label className="graph-head-filter">标签筛选<select value={label} onChange={(event) => { const filters = { labels: [], relationshipTypes: [] }; setLabel(event.target.value); setTypeFilters(filters); void load(event.target.value, search, settings.nodeLimit, filters); }}><option value="">全部</option>{(runtimeTypes?.labels ?? []).map((item) => <option key={item.name} value={item.name}>{item.name}（{item.count}）</option>)}</select></label><button className="action" disabled={loading} onClick={() => void load(label, search, settings.nodeLimit)}><Search size={15} />{loading ? "加载中…" : "刷新"}</button><label className="graph-head-filter">业务对象<select value={sourceType} onChange={(event) => setSourceType(event.target.value)}><option value="">选择对象类型</option>{(version?.definition.entityTypes ?? []).map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label><input className="ted-input" style={{ maxWidth: 90 }} type="number" min={1} max={200} value={sourceLimit} onChange={(event) => setSourceLimit(Math.max(1, Math.min(200, Number(event.target.value) || 1)))} /><button className="action" disabled={!target || !sourceType || sourceLoading} onClick={() => void loadBusinessObjects()}>{sourceLoading ? "取数中…" : "从数据源加载"}</button><button className="action" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />可视化配置</button></div></div><p className="subtle">{draft ? `节点、关系、属性与位置修改只保存到草稿快照文件，发布前不会影响 ${graphNoun(target)}。` : "当前为只读发布版本；创建草稿后才可编辑图数据。"}</p></div>
      {!draft && <section className="panel cypher-bar"><button type="button" className="cypher-bar-trigger" aria-expanded={cypherOpen} onClick={() => setCypherOpen((current) => !current)}><span><span className="eyebrow">{graphTargetKindInfo(target?.kind ?? DEFAULT_GRAPH_TARGET_KIND).queryLanguageLabel} 只读查询</span><b>查询当前 {graphNoun(target)} 并可视化</b></span><span className="cypher-bar-toggle">{cypherOpen ? "收起查询" : "展开查询"}<ChevronDown size={15} className={cypherOpen ? "is-open" : ""} /></span></button>{cypherOpen && <div className="cypher-bar-content"><CypherEditor value={cypher} onChange={setCypher} language="sparql" labels={cypherLabels} relationshipTypes={cypherRelationshipTypes} propertyKeys={cypherPropertyKeys} placeholder={queryTemplate.placeholder} /><p className="cypher-hint">{queryTemplate.visualizationHint}</p><div className="cypher-controls"><span className={cypherIsWrite ? "write-warning" : "read-state"}>{cypherIsWrite ? "版本模式禁止直接写入" : "只读语句"}</span><button className="action primary" disabled={running || !target || cypherIsWrite} onClick={() => void runCypher()}><PlayIcon />{running ? "执行中" : "运行并可视化"}</button></div></div>}</section>}
      <GraphCanvas graph={graph} targetId={target?.id} versionId={draft?.id} user={user} editable={Boolean(draft)} definition={version?.definition ?? null} runtimeTypes={runtimeTypes ?? undefined} onExpand={draft ? undefined : expand} onRefresh={async () => { await load(label, search, settings.nodeLimit); await onSnapshotChange(); }} onTypeFilterChange={(filters) => { setTypeFilters(filters); void load(label, search, settings.nodeLimit, filters); }} notify={notify} fail={fail} />
      {settingsOpen && <GraphSettingsDialog settings={settings} onSave={update} onReset={reset} onClose={() => setSettingsOpen(false)} />}
  </section>;
}

/**
 * 对象详情里的动作入口：列出定义在这个对象所属对象类型上的动作。
 * 被「隐藏」规则挡掉的动作根本不出现 —— 可见性由服务端对同一份快照判定。
 * 点一下带着当前对象跳到「动作」页，主对象已经预填好。
 */


export function PlayIcon() { return <span className="arrow">▶</span>; }
