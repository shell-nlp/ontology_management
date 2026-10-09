import { describe, expect, it } from "vitest";
import { dateOnlyText, wallClockText } from "@/lib/datetime";

/**
 * 日期渲染统一口径（2026-10-10 用户报）：
 * Oracle DATE 的 2026-09-13 00:00 在东八区走到 toISOString 会变成 2026-09-12T16:00:00.000Z，
 * 照它写 WHERE 就差一天。column_profile 与 run_sql / 数据预览必须用同一份本地墙钟渲染。
 */
describe("墙钟日期渲染", () => {
  it("输出本地时间分量，不带时区偏移", () => {
    expect(wallClockText(new Date(2026, 8, 13, 0, 0, 0))).toBe("2026-09-13 00:00:00");
    expect(wallClockText(new Date(2026, 8, 13, 14, 5, 9))).toBe("2026-09-13 14:05:09");
  });

  it("只要日期时截到 YYYY-MM-DD", () => {
    expect(dateOnlyText(new Date(2026, 8, 13, 23, 59, 59))).toBe("2026-09-13");
  });
});
