/**
 * 日期渲染的统一口径。
 *
 * 为什么要有它（2026-10-10 用户报的「最危险的一条」）：驱动（Oracle DATE）按**本地时间分量**构造 JS Date，
 * 一旦走 JSON.stringify / toISOString 就会带上时区偏移 —— 东八区 2026-09-13 00:00 变成
 * 2026-09-12T16:00:00.000Z，模型照它写 WHERE 就差一天。
 *
 * 所以一律用**本地时间分量**还原墙钟值：不写死时区，进程跑在 UTC 还是 +08 都不再二次偏移。
 * column_profile（列画像）与 run_sql / 数据预览三条路共用这一份。
 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Date → `YYYY-MM-DD HH:mm:ss`（本地墙钟）。 */
export function wallClockText(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

/** Date → `YYYY-MM-DD`（本地墙钟）。 */
export function dateOnlyText(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}
