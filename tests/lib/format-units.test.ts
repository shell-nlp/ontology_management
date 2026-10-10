import { describe, expect, it } from "vitest";
import { formatCount, formatDuration } from "@/lib/format-units";

/**
 * 单位要随量级变（2026-10-10 用户口径：「毫秒，分钟，小时 这样的不能只是一个单位」）。
 *
 * 现场是两处：求证轨迹每一步写 `4911ms`、整轮写 `111.5s` —— 一眼看不出量级，还得自己数位。
 * 这里是那两个函数的唯一出口，边界写死在用例里。
 */
describe("formatDuration", () => {
  it("不足 1 秒按毫秒", () => {
    expect(formatDuration(13)).toBe("13ms");
    expect(formatDuration(172)).toBe("172ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(0)).toBe("0ms");
  });

  it("不足 1 分钟按秒：10 秒以内留一位小数（跑动时看着在走），再往上取整", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(4911)).toBe("4.9s");
    expect(formatDuration(33_800)).toBe("34s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("超过 1 分钟按分秒，低位补零", () => {
    expect(formatDuration(60_000)).toBe("1分00秒");
    expect(formatDuration(111_500)).toBe("1分52秒");
    expect(formatDuration(605_000)).toBe("10分05秒");
  });

  it("超过 1 小时按小时分，再往上按天小时", () => {
    expect(formatDuration(3_600_000)).toBe("1小时00分");
    expect(formatDuration(3_930_000)).toBe("1小时05分");
    expect(formatDuration(90_000_000)).toBe("1天01小时");
  });

  it("脏数据不给 NaN：非有限值 / 负数当 0", () => {
    expect(formatDuration(Number.NaN)).toBe("0ms");
    expect(formatDuration(-5)).toBe("0ms");
  });
});

describe("formatCount", () => {
  it("token 这类数量按 k / M 缩写", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(5748)).toBe("5.7k");
    expect(formatCount(96_282)).toBe("96.3k");
    expect(formatCount(833_905)).toBe("833.9k");
    expect(formatCount(1_250_000)).toBe("1.3M");
  });
});
