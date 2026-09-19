"use client";

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Definition } from "@/lib/ontology-draft";

export type EntitySearchResult = {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
  matched: string[];
  rank: number;
  /**
   * 对象引用（`对象类型/主键串`）。数据源来的对象本体里没有副本，
   * 后续"取进草稿 / 当动作主对象"靠它按主键把人找回来。
   */
  objectRef?: string;
  /** 这条来自哪里：索引（本体里已有）还是数据源（实时读业务库）。 */
  origin?: "index" | "source";
};

/** 对象在界面上的显示名：优先类型配置的显示属性，其次常见命名键，最后退回 id。 */
export function entityDisplayName(node: EntitySearchResult, definition: Definition | null): string {
  const entityType = definition?.entityTypes.find((item) => node.labels.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && node.properties[primary] != null) return String(node.properties[primary]);
  for (const key of ["name", "名称", "title", "label"]) if (node.properties[key] != null) return String(node.properties[key]);
  return node.id;
}

/**
 * 按名称搜索对象，选中后把整条记录回给调用方。
 *
 * 只选了一个对象类型时走**对象服务**（索引优先、没有就回源业务库），
 * 所以这里能选到业务表里的真实对象；选中项带着 `objectRef`，
 * 后续"取进草稿 / 当动作主对象"靠它按主键把人找回来。
 */
export function EntitySearchPicker({ targetId, versionId, labels, definition, placeholder, value, onChange }: { targetId: string; versionId: string; labels: string[]; definition: Definition | null; placeholder: string; value: EntitySearchResult | null; onChange: (node: EntitySearchResult | null) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EntitySearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelKey = labels.join("|");
  const runSearch = useCallback(async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) { setResults([]); setLoading(false); setError(null); return; }
    setLoading(true); setError(null);
    try {
      /*
       * 只选了一个对象类型时走**对象服务**：索引里有就从索引拿，没有就按主键回源业务库，
       * 于是这里能选到业务表里的真实对象（旧接口只看得见快照里的样本对象）。
       * 多个类型 / 不限类型时对象服务用不了（它按类型取数），退回原来的快照检索。
       */
      const single = labelKey.split("|").filter(Boolean);
      if (single.length === 1) {
        const params = new URLSearchParams({ targetId, entityType: single[0], text: trimmed, limit: "12", origin: "auto" });
        const data = await api<{ rows: { objectId: string; entityType: string; properties: Record<string, unknown>; objectRef: string; origin: "index" | "source" }[] }>(`/api/objects?${params.toString()}`);
        setResults(data.rows.map((row, index) => ({
          id: row.objectId,
          labels: [row.entityType],
          properties: row.properties,
          matched: [],
          rank: index,
          objectRef: row.objectRef,
          origin: row.origin,
        })));
        setHighlight(0);
        return;
      }
      const params = new URLSearchParams({ targetId, versionId, q: trimmed, limit: "12" });
      if (labelKey) params.set("labels", JSON.stringify(labelKey.split("|")));
      const data = await api<{ results: EntitySearchResult[] }>(`/api/instances/search?${params.toString()}`);
      setResults(data.results); setHighlight(0);
    } catch (reason) {
      setResults([]); setError(reason instanceof Error ? reason.message : "搜索失败。");
    } finally { setLoading(false); }
  }, [targetId, versionId, labelKey]);
  useEffect(() => { const handle = window.setTimeout(() => { void runSearch(query); }, 250); return () => window.clearTimeout(handle); }, [query, runSearch]);
  useEffect(() => {
    const onDown = (event: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const select = (node: EntitySearchResult) => { onChange(node); setQuery(""); setResults([]); setOpen(false); };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); if (results.length) { setOpen(true); setHighlight((h) => Math.min(h + 1, results.length - 1)); } }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const candidate = results[highlight] ?? results[0]; if (candidate) select(candidate); }
    else if (event.key === "Escape") { setOpen(false); }
  };
  const menuOpen = open && !value && query.trim().length > 0;
  return <div className="entity-picker" ref={boxRef}>{value ? <div className="entity-picker-selected"><span className="entity-chip"><span className="entity-chip-label">{value.labels[0] ?? "?"}</span><b>{entityDisplayName(value, definition)}</b></span><span className="entity-chip-id">{value.id}</span><button type="button" className="entity-chip-clear" title="移除" onClick={() => onChange(null)}><X size={13} /></button></div> : <div className="entity-picker-input"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={onKeyDown} onFocus={() => { if (query.trim() && results.length) setOpen(true); }} placeholder={placeholder} autoComplete="off" spellCheck={false} />{loading && <Loader2 size={14} className="entity-spinner" />}</div>}{menuOpen && <div className="entity-picker-menu">{loading && !results.length && !error ? <div className="entity-picker-empty"><Loader2 size={14} className="entity-spinner" />正在搜索…</div> : error ? <div className="entity-picker-empty">{error}</div> : results.length ? results.map((node, index) => <button type="button" className={index === highlight ? "entity-result selected" : "entity-result"} key={node.id} onMouseEnter={() => setHighlight(index)} onClick={() => select(node)}><span className="entity-result-label">{node.labels.slice(0, 2).join(" · ") || "?"}</span><span className="entity-result-name">{entityDisplayName(node, definition)}</span><span className="entity-result-id">{node.origin === "source" ? "数据源" : node.id.slice(0, 12)}</span></button>) : <div className="entity-picker-empty"><Search size={14} />没有匹配的对象</div>}</div>}</div>;
}
