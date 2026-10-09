import { describe, expect, it } from "vitest";
import { metricSchema } from "@/lib/ontology";

/**
 * 指标的状态位与负责人（2026-10-10）：
 * 库里混着「专线条数--test」「地市字典记录数（配置示例）」这种不可用的口径，模型没法程序化判断哪条可信。
 * status 给模型一个可过滤的信赖信号，owner 让「这条口径谁负责」有答案。
 */
describe("指标的状态位与负责人", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", name: "全球通成员数", entityTypeId: "" };

  it("不写 status / owner 时给默认值：默认 draft（还没验收），owner 空", () => {
    const parsed = metricSchema.parse(base);
    expect(parsed.status).toBe("draft");
    expect(parsed.owner).toBe("");
  });

  it("可以标 verified 并写上负责人", () => {
    const parsed = metricSchema.parse({ ...base, status: "verified", owner: "市场部数据组" });
    expect(parsed.status).toBe("verified");
    expect(parsed.owner).toBe("市场部数据组");
  });
});
