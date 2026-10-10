import { describe, expect, it } from "vitest";
import { CARDINALITY_OPTIONS, cardinalityLabel, cardinalityPhrase, flipCardinality, RELATIONSHIP_CARDINALITIES } from "@/lib/ontology/relationship-cardinality";

/**
 * 关系类型的数量关系（Palantir 的 link type cardinality）。
 *
 * 它解决的是"走一条关系会不会把行数放大"：一个客户 141 条专线，按客户分组求和就会重复计数。
 * 两条口径钉在这里：
 * 1. 说的是**起点端 → 终点端**；从终点端看过去要**翻过来说**（`reversed`），否则方向会理解反；
 * 2. 空串 = 未标注 —— 它不代表多对多，工具里也如实说"没标注"。
 */
describe("flipCardinality", () => {
  it("一对多 ↔ 多对一；对称的两项与空值原样返回", () => {
    expect(flipCardinality("ONE_TO_MANY")).toBe("MANY_TO_ONE");
    expect(flipCardinality("MANY_TO_ONE")).toBe("ONE_TO_MANY");
    expect(flipCardinality("ONE_TO_ONE")).toBe("ONE_TO_ONE");
    expect(flipCardinality("MANY_TO_MANY")).toBe("MANY_TO_MANY");
    expect(flipCardinality("")).toBe("");
    expect(flipCardinality(undefined)).toBe("");
    expect(flipCardinality("瞎写的")).toBe("");
  });
});

describe("cardinalityLabel", () => {
  it("四种组合给汉字说法，未标注给空串", () => {
    expect(cardinalityLabel("ONE_TO_ONE")).toBe("一对一");
    expect(cardinalityLabel("ONE_TO_MANY")).toBe("一对多");
    expect(cardinalityLabel("MANY_TO_ONE")).toBe("多对一");
    expect(cardinalityLabel("MANY_TO_MANY")).toBe("多对多");
    expect(cardinalityLabel("")).toBe("");
    expect(cardinalityLabel(undefined)).toBe("");
  });
});

describe("cardinalityPhrase", () => {
  it("按声明的方向说清是哪两个对象类型之间的关系", () => {
    expect(cardinalityPhrase("ONE_TO_MANY", "客户", "专线产品用户")).toBe("一个「客户」→ 多个「专线产品用户」");
    expect(cardinalityPhrase("MANY_TO_ONE", "专线产品用户", "客户")).toBe("多个「专线产品用户」→ 一个「客户」");
  });

  it("从终点端看过去（reversed）要把基数翻过来说，别让模型把方向理解反", () => {
    // 声明是「客户(起点) 一对多 专线产品用户(终点)」；
    // 站在专线产品用户这一侧问"我这边是什么关系"，答案是"多个我 → 一个客户"。
    expect(cardinalityPhrase("ONE_TO_MANY", "专线产品用户", "客户", { reversed: true })).toBe("多个「专线产品用户」→ 一个「客户」");
    // 对称的与未标注的不受影响
    expect(cardinalityPhrase("MANY_TO_MANY", "A", "B", { reversed: true })).toBe("多个「A」→ 多个「B」");
    expect(cardinalityPhrase("", "A", "B", { reversed: true })).toBe("");
  });

  it("端点名字缺了也不炸（写「未指定」）", () => {
    expect(cardinalityPhrase("ONE_TO_ONE", "", "")).toBe("一个「未指定」→ 一个「未指定」");
  });
});

describe("选项清单", () => {
  it("界面上「未标注」排第一且值为空串，其余四项与枚举一致", () => {
    expect(CARDINALITY_OPTIONS[0]).toMatchObject({ value: "", label: "未标注" });
    expect(CARDINALITY_OPTIONS.map((item) => item.value)).toEqual(["", ...RELATIONSHIP_CARDINALITIES]);
    // 每个选项都要有给人看的一句解释，别只给四个词。
    for (const option of CARDINALITY_OPTIONS) expect(option.hint.length).toBeGreaterThan(10);
  });
});
