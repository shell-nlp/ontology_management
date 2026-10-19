/**
 * 给人看的数字：**单位随量级变**，不固定一个单位。
 *
 * 用户口径（2026-10-10）：「这里的时间，单位要会变化，毫秒，分钟，小时 这样的不能只是一个单位」。
 * 界面上出现过 `4911ms`、`111.5s`、`833905 tokens` 这种"一个单位硬撑"的写法 ——
 * 一眼看不出量级，还得自己数位。这两个函数是那几处的唯一出口（纯函数，有单测）。
 */

/**
 * 耗时：`812ms` / `4.9s` / `1分52秒` / `1小时05分` / `2天03小时`。
 *
 * - 不足 1 秒按毫秒（工具调用大多是这种量级）；
 * - 不足 1 分钟按秒，10 秒以内留一位小数（跑动的时候看着在走）；
 * - 再往上按 分秒 / 小时分 / 天小时，**低位补零**（`1分05秒` 比 `1分5秒` 好读）。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const restSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}分${String(restSeconds).padStart(2, "0")}秒`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return `${hours}小时${String(restMinutes).padStart(2, "0")}分`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `${days}天${String(restHours).padStart(2, "0")}小时`;
}

/** 数量级数字（token 之类）：`950` / `5.7k` / `96.3k` / `833.9k` / `1.2M`。 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}
