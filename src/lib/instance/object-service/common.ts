import type { ObjectIndexEntry } from "@/lib/infrastructure/object-index/types";

export type MaterializeTypeResult = {
  entityType: string;
  rows: number;
  scanned: number;
  folded: number;
  truncated: boolean;
  pages: number;
  total: number | null;
  tookMs: number;
  warnings: string[];
};

export function clamp(value: number | undefined, min: number, max: number, fallback: number) {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const PAGE_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;

export function averageEntryBytes(entries: readonly ObjectIndexEntry[]): number {
  if (!entries.length) return 0;
  let chars = 0;
  for (const entry of entries) {
    chars += (entry.searchText?.length ?? 0) + (entry.title?.length ?? 0) + (entry.properties ? JSON.stringify(entry.properties).length : 0);
  }
  return Math.ceil((chars / entries.length) * 1.5);
}

export function rawColumn(row: Record<string, unknown>, column: string): unknown {
  const target = column.trim().toLowerCase();
  for (const [key, value] of Object.entries(row)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}
