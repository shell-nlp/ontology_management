"use client";

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { api } from "@/lib/api-client";
import type { Definition } from "@/lib/ontology-draft";

export type EntitySearchResult = { id: string; labels: string[]; properties: Record<string, unknown>; matched: string[]; rank: number };

/** 对象在界面上的显示名：优先类型配置的显示属性，其次常见命名键，最后退回 id。 */
export function entityDisplayName(node: EntitySearchResult, definition: Definition | null): string {
  const entityType = definition?.entityTypes.find((item) => node.labels.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && node.properties[primary] != null) return String(node.properties[primary]);
  for (const key of ["name", "名称", "title", "label"]) if (node.properties[key] != null) return String(node.properties[key]);
  return node.id;
}

/** 按名称搜索草稿快照里的对象，选中后把整条记录回给调用方。 */
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
  return <div className="entity-picker" ref={boxRef}>{value ? <div className="entity-picker-selected"><span className="entity-chip"><span className="entity-chip-label">{value.labels[0] ?? "?"}</span><b>{entityDisplayName(value, definition)}</b></span><span className="entity-chip-id">{value.id}</span><button type="button" className="entity-chip-clear" title="移除" onClick={() => onChange(null)}><X size={13} /></button></div> : <div className="entity-picker-input"><Search size={14} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onKeyDown={onKeyDown} onFocus={() => { if (query.trim() && results.length) setOpen(true); }} placeholder={placeholder} autoComplete="off" spellCheck={false} />{loading && <Loader2 size={14} className="entity-spinner" />}</div>}{menuOpen && <div className="entity-picker-menu">{loading && !results.length && !error ? <div className="entity-picker-empty"><Loader2 size={14} className="entity-spinner" />正在搜索…</div> : error ? <div className="entity-picker-empty">{error}</div> : results.length ? results.map((node, index) => <button type="button" className={index === highlight ? "entity-result selected" : "entity-result"} key={node.id} onMouseEnter={() => setHighlight(index)} onClick={() => select(node)}><span className="entity-result-label">{node.labels.slice(0, 2).join(" · ") || "?"}</span><span className="entity-result-name">{entityDisplayName(node, definition)}</span><span className="entity-result-id">{node.id.slice(0, 12)}</span></button>) : <div className="entity-picker-empty"><Search size={14} />没有匹配的对象</div>}</div>}</div>;
}
