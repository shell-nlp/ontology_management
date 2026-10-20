export function clamp(value: number | undefined, min: number, max: number, fallback: number) {
  const parsed = Number.isFinite(value) ? Math.floor(value as number) : fallback;
  return Math.min(max, Math.max(min, parsed));
}
