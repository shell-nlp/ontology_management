import { describe, expect, it } from "vitest";
import { columnValuesHint, unknownPropertyHint } from "@/lib/query-dsl";

/**
 * 报错带路的两条文案（纯函数）。
 *
 * 背景（2026-10-14 实测）：模型在导进来的本体上写 `统计日期`，而那批属性名**就是物理列名**
 * （`STATIS_DATE` / `STATS`）—— 只说"没有属性"它就再猜一次，每多一步都要重发整个上下文。
 */
describe("unknownPropertyHint", () => {
  const properties = [
    { name: "STATIS_DATE", sourceField: "STATIS_DATE" },
    { name: "customer_id", sourceField: "CUST_ID" },
    { name: "customer_name", sourceField: "CUST_NAME" },
  ];

  it("写的是列名时，直接说属性叫什么", () => {
    const text = unknownPropertyHint("客户", properties, "CUST_ID");
    expect(text).toContain("是这一列的列名");
    expect(text).toContain("属性名是「customer_id」");
  });

  it("名字互相包含时给候选", () => {
    expect(unknownPropertyHint("专线产品用户", properties, "STATIS")).toContain("本体里有：STATIS_DATE");
  });

  it("一个都不沾边时把属性清单摊开", () => {
    const text = unknownPropertyHint("专线产品用户", properties, "统计日期");
    expect(text).toContain("STATIS_DATE");
    expect(text).toContain("customer_id");
    expect(text).toContain("共 3 个");
  });

  it("清单超过上限时只摊前 N 个并交代总数", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ name: `P${index}` }));
    const text = unknownPropertyHint("X", many, "nope");
    expect(text).toContain("P0");
    expect(text).not.toContain("P19");
    expect(text).toContain("共 20 个");
  });
});

describe("columnValuesHint", () => {
  it("有画像取值时给出真实码值（顺带把 CHAR 的尾空格去掉）", () => {
    const text = columnValuesHint("STATS", ["1 ", "3 ", "8 "]);
    expect(text).toContain("'1'、'3'、'8'");
    expect(text).toContain("STATS IN ('1', '3', '8')");
  });

  it("画像里没有这一列时说去哪儿看", () => {
    expect(columnValuesHint("STATS", [])).toContain("get_table_ddl");
  });
});
