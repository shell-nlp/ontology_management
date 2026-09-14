"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/**
 * 两栏布局的拖拽分隔条：对象页与本体草稿的「概念分组」共用这一份逻辑。
 *
 * 左栏宽度按 storageKey 记在本机 —— 它属于"我怎么看这一屏"，不进草稿、也不跟本体走。
 * 除了鼠标拖动，分隔条本身可聚焦：左右箭头微调、Home 或双击恢复默认。
 */
export const SPLIT_HANDLE_WIDTH = 12;

export type SplitPaneOptions = {
  storageKey: string;
  defaultWidth: number;
  /** 左栏最小宽度：容器不够宽时宁可真挤右栏，也不把左栏压没。 */
  minLeft: number;
  /** 右栏保留的最小宽度，用来反推左栏的实际上限。 */
  minDetail: number;
  maxLeft: number;
  /** 分隔条的读屏说明与悬停提示；两栏装的东西不同就给不同的说法。 */
  label?: string;
};

export type SplitPaneHandleProps = {
  "aria-label": string;
  "aria-orientation": "vertical";
  "aria-valuemax": number;
  "aria-valuemin": number;
  "aria-valuenow": number;
  className: string;
  onDoubleClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  role: "separator";
  tabIndex: number;
  title: string;
};

function readStoredWidth(storageKey: string, fallback: number) {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : fallback;
  } catch {
    return fallback;
  }
}

export function useSplitPane({ storageKey, defaultWidth, minLeft, minDetail, maxLeft, label = "拖动调整左栏宽度，双击恢复默认" }: SplitPaneOptions): {
  containerRef: RefObject<HTMLElement | null>;
  containerStyle: CSSProperties;
  handleProps: SplitPaneHandleProps;
} {
  const containerRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, defaultWidth));
  const widthRef = useRef(width);

  const clampWidth = useCallback((value: number) => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const maxByContainer = containerWidth > 0 ? containerWidth - minDetail - SPLIT_HANDLE_WIDTH : maxLeft;
    const max = Math.max(minLeft, Math.min(maxLeft, maxByContainer));
    return Math.round(Math.min(Math.max(value, minLeft), max));
  }, [maxLeft, minDetail, minLeft]);

  const applyWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    widthRef.current = clamped;
    setWidth(clamped);
  }, [clampWidth]);

  const persistWidth = useCallback(() => {
    try { window.localStorage.setItem(storageKey, String(widthRef.current)); } catch { /* 隐私模式下写不了就算了 */ }
  }, [storageKey]);

  useEffect(() => {
    applyWidth(widthRef.current);
    const onWindowResize = () => applyWidth(widthRef.current);
    window.addEventListener("resize", onWindowResize);
    return () => window.removeEventListener("resize", onWindowResize);
  }, [applyWidth]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    const onMove = (moveEvent: PointerEvent) => applyWidth(startWidth + moveEvent.clientX - startX);
    const onEnd = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.body.classList.remove("resizing-manager-split");
      persistWidth();
    };
    document.body.classList.add("resizing-manager-split");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
  }, [applyWidth, persistWidth]);

  const resetWidth = useCallback(() => { applyWidth(defaultWidth); persistWidth(); }, [applyWidth, defaultWidth, persistWidth]);

  const nudgeWidth = useCallback((delta: number) => { applyWidth(widthRef.current + delta); persistWidth(); }, [applyWidth, persistWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      nudgeWidth(event.key === "ArrowLeft" ? -24 : 24);
      return;
    }
    if (event.key === "Home") { event.preventDefault(); resetWidth(); }
  }, [nudgeWidth, resetWidth]);

  return {
    containerRef,
    containerStyle: { "--manager-split-left": `${width}px` } as CSSProperties,
    handleProps: {
      "aria-label": label,
      "aria-orientation": "vertical",
      "aria-valuemax": maxLeft,
      "aria-valuemin": minLeft,
      "aria-valuenow": Math.round(width),
      className: "manager-split-handle",
      onDoubleClick: resetWidth,
      onKeyDown: handleKeyDown,
      onPointerDown: beginResize,
      role: "separator",
      tabIndex: 0,
      title: label,
    },
  };
}
