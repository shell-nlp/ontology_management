"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, LayoutGrid } from "lucide-react";
import { LAYOUT_MODES, type LayoutMode } from "@/lib/concept-groups";
import "./layout-switcher.css";

/**
 * 画布布局切换器：默认布局 / 圆形布局 / 按逻辑分组。
 *
 * 本体草稿的可视化画布和「查看本体」共用这一个切换器，两个页面说同一套话；
 * 「按逻辑分组」是唯一会画分组框的布局（见 concept-groups.ts）。
 */
export function LayoutSwitcher({ value, onChange }: { value: LayoutMode; onChange: (mode: LayoutMode) => void }) {
  const [open, setOpen] = useState(false);
  const current = LAYOUT_MODES.find((mode) => mode.key === value) ?? LAYOUT_MODES[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      // 菜单里的点击自己处理；点到别处（含画布）就收起来
      if ((event.target as HTMLElement | null)?.closest?.(".layout-switcher")) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);

  return (
    <div className="layout-switcher">
      <button type="button" className="layout-switcher-trigger" aria-haspopup="menu" aria-expanded={open} title={current.hint} onClick={() => setOpen((previous) => !previous)}>
        <LayoutGrid size={14} />{current.label}<ChevronDown size={13} className={open ? "is-open" : ""} />
      </button>
      {open && (
        <div className="layout-switcher-menu" role="menu">
          {LAYOUT_MODES.map((mode) => (
            <button key={mode.key} type="button" role="menuitemradio" aria-checked={mode.key === value} className={mode.key === value ? "active" : ""} onClick={() => { onChange(mode.key); setOpen(false); }}>
              <b>{mode.label}</b>
              <em>{mode.hint}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 本机记住的布局偏好；没存过、存坏了、或者服务端渲染时都返回 null。 */
function readStoredLayout(storageKey: string | null): LayoutMode | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    return stored && LAYOUT_MODES.some((item) => item.key === stored) ? (stored as LayoutMode) : null;
  } catch { return null; }
}

/**
 * 记住每个本体上次选的布局：换布局是"我怎么看这张图"，属于本机偏好，不进草稿定义。
 *
 * 和本文件其它设置一样，直接同步读 localStorage（不进 effect，避免多一次渲染）；
 * 换本体时 storageKey 变，就在渲染期把状态对齐到新本体的偏好。
 */
export function useLayoutMode(storageKey: string | null, fallback: LayoutMode = "default") {
  const [state, setState] = useState<{ key: string | null; mode: LayoutMode }>(() => ({ key: storageKey, mode: readStoredLayout(storageKey) ?? fallback }));
  if (state.key !== storageKey) setState({ key: storageKey, mode: readStoredLayout(storageKey) ?? fallback });
  const update = useCallback((next: LayoutMode) => {
    try { if (storageKey) window.localStorage.setItem(storageKey, next); } catch { /* 布局只是偏好，存不下也不影响使用 */ }
    setState({ key: storageKey, mode: next });
  }, [storageKey]);
  return [state.mode, update] as const;
}
