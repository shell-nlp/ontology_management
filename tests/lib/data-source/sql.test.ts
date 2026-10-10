import { describe, expect, it } from "vitest";
import { toPreviewValue } from "@/lib/datasource/sql";

/**
 * 预览值要能直接进 JSON。日期**不能**走 ISO：run_sql 的结果行与「数据预览」都走这里，
 * Oracle DATE 的 2026-09-13 00:00 在东八区会显示成 2026-09-12T16:00:00.000Z —— 与 column_profile 同源的问题。
 */
describe("toPreviewValue（run_sql / 数据预览的取值渲染）", () => {
  it("日期输出本地墙钟，不带时区偏移", () => {
    expect(toPreviewValue(new Date(2026, 8, 13, 0, 0, 0))).toBe("2026-09-13 00:00:00");
  });

  it("其它类型照旧：null / 大整数 / 二进制 / 嵌套数组", () => {
    expect(toPreviewValue(null)).toBeNull();
    expect(toPreviewValue(undefined)).toBeNull();
    expect(toPreviewValue(10n)).toBe("10");
    expect(toPreviewValue(Buffer.from([1, 2, 3]))).toBe("<3 bytes>");
    expect(toPreviewValue([new Date(2026, 8, 13)])).toEqual(["2026-09-13 00:00:00"]);
  });
});
