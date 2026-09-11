/**
 * 画布摆放位置的本机存储。
 *
 * 位置只是作者自己的阅读顺序，不是图数据也不是草稿定义，所以不进数据库、不进快照：
 * 统一放在 localStorage + 一层内存缓存里，同一会话内读到的都是最新值。
 */
export type NodePositions = Record<string, { x: number; y: number }>;

const positionCache = new Map<string, NodePositions>();

export function readStoredPositions(key: string) {
  const cached = positionCache.get(key);
  if (cached) return cached;
  const positions: NodePositions = {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (parsed && typeof parsed === "object") {
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        const point = value as { x?: unknown; y?: unknown } | null;
        if (point && typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) positions[name] = { x: point.x, y: point.y };
      }
    }
  } catch { /* 本机存储不可用时忽略历史摆放 */ }
  positionCache.set(key, positions);
  return positions;
}

export function writeStoredPositions(key: string, positions: NodePositions) {
  if (Object.keys(positions).length) {
    positionCache.set(key, positions);
    try { window.localStorage.setItem(key, JSON.stringify(positions)); } catch { /* 本机存储不可用时只影响摆放记忆 */ }
    return;
  }
  positionCache.delete(key);
  try { window.localStorage.removeItem(key); } catch { /* 同上 */ }
}
