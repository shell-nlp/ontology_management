import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/lib/instance/object-service/materialize-jobs";
import type { MaterializeCursor } from "@/lib/instance/object-service/types";

/**
 * 断点游标的落库编解码（2026-10-14）。
 *
 * 为什么要有单测：**它错了的表现是"续跑时翻页翻错"** —— 页面不报错、条数也像那么回事，
 * 现场极难看出来。两个必须守住的行为：
 * 1. `Date` 不能原样进 JSON（会被拍成字符串，绑回 Oracle 的 DATE 列就变味了），要包起来还原；
 * 2. 形状不对一律当"没有游标" —— 宁可退回 OFFSET 重读一遍，也不能拿半截游标去翻页。
 */
describe("游标编解码", () => {
  it("Date 编码成 {__date}，解码还原成 Date", () => {
    const when = new Date("2026-08-19T00:00:00.000Z");
    const encoded = encodeCursor({ columns: ["USER_ID", "STATIS_DATE"], values: ["U1", when] });
    expect(encoded).toEqual({ columns: ["USER_ID", "STATIS_DATE"], values: ["U1", { __date: "2026-08-19T00:00:00.000Z" }] });
    const decoded = decodeCursor(encoded);
    expect(decoded?.values[0]).toBe("U1");
    expect(decoded?.values[1]).toBeInstanceOf(Date);
    expect((decoded?.values[1] as Date).toISOString()).toBe("2026-08-19T00:00:00.000Z");
  });

  it("数字 / 字符串 / null 原样往返", () => {
    const cursor: MaterializeCursor = { columns: ["A", "B", "C"], values: [42, "x", null] };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded).toEqual(cursor);
  });

  it("空游标 / 列与值不等长 → 不落库", () => {
    expect(encodeCursor(null)).toBeNull();
    expect(encodeCursor({ columns: [], values: [] })).toBeNull();
    expect(encodeCursor({ columns: ["A", "B"], values: ["x"] })).toBeNull();
  });

  it("库里形状不对 → 当没有游标（安全方向：退回 OFFSET）", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("x")).toBeNull();
    expect(decodeCursor(["A"])).toBeNull();
    expect(decodeCursor({ columns: ["A", "B"], values: ["x"] })).toBeNull();
    expect(decodeCursor({ columns: ["A", ""], values: ["x", "y"] })).toBeNull();
  });

  it("解不开的日期串按原值留着（不把 undefined 塞进游标）", () => {
    const decoded = decodeCursor({ columns: ["D"], values: [{ __date: "不是日期" }] });
    expect(decoded?.values[0]).toEqual({ __date: "不是日期" });
  });
});
