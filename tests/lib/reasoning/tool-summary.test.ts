import { describe, expect, it } from "vitest";
import { toolResultSummary } from "@/lib/reasoning/tool-summary";

/** 工具成功时 output 就是 payload 本身（`{ payload }` 那层是给 MCP 用的包装）。 */
const summary = (tool: string, payload: unknown) => toolResultSummary(tool, payload);

describe("toolResultSummary", () => {
  it("run_sql 报行数，不说「无命中」", () => {
    expect(summary("run_sql", { returned: 6, truncated: false })).toBe("6 行");
    expect(summary("run_sql", { returned: 6, truncated: true })).toBe("6 行 · 已截断");
    expect(summary("run_sql", { returned: 0, truncated: false })).toBe("0 行");
  });

  it("get_table_ddl 说清 DDL 是从哪来的", () => {
    expect(summary("get_table_ddl", { table: "TB_X", ddl_source: "native" })).toBe("表结构 · 原始 DDL");
    expect(summary("get_table_ddl", { table: "TB_X", ddl_source: "metadata" })).toBe("表结构 · 按列元数据还原");
  });

  it("检索类工具报命中的概念数", () => {
    expect(summary("search_schema", { matches: [{}, {}] })).toBe("命中 2 个概念");
    expect(summary("search_schema", { matches: [] })).toBe("没有概念命中");
    expect(summary("get_object_type", { name: "集团客户" })).toBe("1 个对象类型");
  });

  it("分组与多跳报数量", () => {
    expect(summary("list_concept_groups", { group_count: 6, groups: [] })).toBe("6 个概念分组");
    expect(summary("traverse_object_types", { node_count: 12, edge_count: 15 })).toBe("12 个对象类型 · 15 条关系类型");
    // 没有计数字段时退一步数数组。
    expect(summary("list_actions", { actions: [{}, {}, {}] })).toBe("3 个动作");
  });

  it("拿不到可说的东西时给中性的「已返回」，不编数字", () => {
    expect(summary("run_sql", undefined)).toBe("已返回");
    expect(summary("unknown_tool", { anything: 1 })).toBe("已返回");
    expect(summary("search_schema", {})).toBe("已返回");
    // 结果超过工具结果上限时，执行层返回的是一条"已截断"的说明，不是真实载荷。
    expect(toolResultSummary("run_sql", { truncated: true, note: "结果过长已截断", preview: "x" })).toBe("结果过长 · 已截断");
  });
});
