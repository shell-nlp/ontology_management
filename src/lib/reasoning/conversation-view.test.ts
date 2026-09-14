import { describe, expect, it } from "vitest";
import { conversationDay, conversationTimeLabel, conversationTitle, groupConversationsByDay } from "@/lib/reasoning/conversation-view";

// 固定"现在"，否则这些用例会在跨零点、跨年的时候自己变红。
const now = new Date(2026, 8, 14, 15, 30);
const at = (year: number, month: number, day: number, hour = 10, minute = 0) => new Date(year, month, day, hour, minute).toISOString();

describe("conversationTitle", () => {
  it("短问题原样用，空白折成一个空格", () => {
    expect(conversationTitle("  专线产品用户\n 绑了哪个表？ ")).toBe("专线产品用户 绑了哪个表？");
  });

  it("长问题截到 60 字并收一个省略号", () => {
    const title = conversationTitle("问".repeat(200));
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("conversationDay", () => {
  it("分成今天 / 昨天 / 更早三档", () => {
    expect(conversationDay(at(2026, 8, 14, 9, 5), now)).toBe("今天");
    expect(conversationDay(at(2026, 8, 13, 23, 59), now)).toBe("昨天");
    expect(conversationDay(at(2026, 8, 3), now)).toBe("更早");
    // 跨年也算更早，不因为"去年同月"串档
    expect(conversationDay(at(2025, 8, 14), now)).toBe("更早");
  });
});

describe("conversationTimeLabel", () => {
  it("今天昨天给时刻，更早给日期", () => {
    expect(conversationTimeLabel(at(2026, 8, 14, 9, 5), now)).toBe("09:05");
    expect(conversationTimeLabel(at(2026, 8, 13, 20, 0), now)).toBe("20:00");
    expect(conversationTimeLabel(at(2026, 7, 3), now)).toBe("8月3日");
    // 跨年了就把年份补上，否则"1月2日"会让人以为是今年
    expect(conversationTimeLabel(at(2025, 11, 31), now)).toBe("2025-12-31");
  });
});

describe("groupConversationsByDay", () => {
  it("按今天 / 昨天 / 更早分组，顺序固定，组内保持传进来的顺序", () => {
    const items = [
      { id: "a", updatedAt: at(2026, 8, 14, 14, 0) },
      { id: "b", updatedAt: at(2026, 8, 14, 9, 0) },
      { id: "c", updatedAt: at(2026, 8, 13, 9, 0) },
      { id: "d", updatedAt: at(2026, 7, 1, 9, 0) },
    ];
    const groups = groupConversationsByDay(items, now);
    expect(groups.map((group) => group.day)).toEqual(["今天", "昨天", "更早"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(groups[1].items.map((item) => item.id)).toEqual(["c"]);
    expect(groups[2].items.map((item) => item.id)).toEqual(["d"]);
  });

  it("空桶不出现在结果里", () => {
    const groups = groupConversationsByDay([{ id: "a", updatedAt: at(2026, 7, 1) }], now);
    expect(groups.map((group) => group.day)).toEqual(["更早"]);
  });
});
