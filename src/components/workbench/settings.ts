"use client";

import { useCallback, useState } from "react";

export type GraphSettings = { nodeLimit: number; maxNeighbors: number; recordLimit: number };

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = { nodeLimit: 300, maxNeighbors: 200, recordLimit: 5000 };

export const GRAPH_SETTINGS_KEY = "atlas.graph-settings";


export function clampLimit(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}


export function loadGraphSettings(): GraphSettings {
  if (typeof window === "undefined") return DEFAULT_GRAPH_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRAPH_SETTINGS_KEY) ?? "{}") as Partial<GraphSettings>;
    return {
      nodeLimit: clampLimit(parsed.nodeLimit, DEFAULT_GRAPH_SETTINGS.nodeLimit, 1, 10000),
      maxNeighbors: clampLimit(parsed.maxNeighbors, DEFAULT_GRAPH_SETTINGS.maxNeighbors, 1, 10000),
      recordLimit: clampLimit(parsed.recordLimit, DEFAULT_GRAPH_SETTINGS.recordLimit, 1, 100000),
    };
  } catch { return DEFAULT_GRAPH_SETTINGS; }
}


export function useGraphSettings() {
  const [settings, setSettings] = useState<GraphSettings>(loadGraphSettings);
  const update = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((current) => {
      const next: GraphSettings = {
        nodeLimit: clampLimit(patch.nodeLimit, current.nodeLimit, 1, 10000),
        maxNeighbors: clampLimit(patch.maxNeighbors, current.maxNeighbors, 1, 10000),
        recordLimit: clampLimit(patch.recordLimit, current.recordLimit, 1, 100000),
      };
      try { window.localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(GRAPH_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_GRAPH_SETTINGS); }, []);
  return { settings, update, reset };
}


export type DisplaySettings = { entityLimit: number; relationshipLimit: number };

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { entityLimit: 200, relationshipLimit: 200 };

export const DISPLAY_SETTINGS_KEY = "atlas.display-settings";


export function loadDisplaySettings(): DisplaySettings {
  if (typeof window === "undefined") return DEFAULT_DISPLAY_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISPLAY_SETTINGS_KEY) ?? "{}") as Partial<DisplaySettings>;
    return {
      entityLimit: clampLimit(parsed.entityLimit, DEFAULT_DISPLAY_SETTINGS.entityLimit, 1, 10000),
      relationshipLimit: clampLimit(parsed.relationshipLimit, DEFAULT_DISPLAY_SETTINGS.relationshipLimit, 1, 10000),
    };
  } catch { return DEFAULT_DISPLAY_SETTINGS; }
}


export function useDisplaySettings() {
  const [settings, setSettings] = useState<DisplaySettings>(loadDisplaySettings);
  const update = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((current) => {
      const next: DisplaySettings = {
        entityLimit: clampLimit(patch.entityLimit, current.entityLimit, 1, 10000),
        relationshipLimit: clampLimit(patch.relationshipLimit, current.relationshipLimit, 1, 10000),
      };
      try { window.localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(DISPLAY_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_DISPLAY_SETTINGS); }, []);
  return { settings, update, reset };
}


