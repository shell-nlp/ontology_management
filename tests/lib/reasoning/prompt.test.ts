import { describe, expect, it } from "vitest";
import { buildInstructions, DEFAULT_SYSTEM_PROMPT, isCustomSystemPrompt, schemaBrief, toolGuide } from "@/lib/reasoning/prompt";
import type { OntologyDefinition } from "@/lib/ontology";
import type { RuntimeTypeSet } from "@/lib/infrastructure/graph/types";

const 客户id = "bbbbbbb1-1111-4111-8111-111111111111";
const 用户id = "bbbbbbb2-2222-4222-8222-222222222222";
const 账单id = "bbbbbbb3-3333-4333-8333-333333333333";
const 客户域id = "bbbbbbb9-9999-4999-8999-999999999999";

function definition(): OntologyDefinition {
  return {
    groups: [{ id: 客户域id, name: "客户域", color: "" }],
    entityTypes: [
      { id: 客户id, name: "客户", description: "社会实体", displayProperty: "", groupId: 客户域id, properties: [], sources: [] },
      {
        id: 用户id,
        name: "用户",
        description: "客户订购的服务实例",
        displayProperty: "",
        groupId: 客户域id,
        properties: [],
        sources: [{ id: "primary", dataSourceId: "src-1", schema: "GISTOOLS", view: "TB_X", primaryKey: ["USER_ID"], titleField: "USER_ID" }],
      },
      { id: 账单id, name: "账单", description: "账期费用", displayProperty: "", groupId: "", properties: [], sources: [] },
    ],
    relationshipTypes: [{ id: "rrrrrrr1-1111-4111-8111-111111111111", name: "客户拥有用户", sourceEntityTypeId: 客户id, targetEntityTypeId: 用户id, properties: [] }],
    actionTypes: [],
    rules: [],
  } as unknown as OntologyDefinition;
}

const runtimeTypes: RuntimeTypeSet = { labels: [], relationshipTypes: [], entityCount: 0, relationshipCount: 0, relationshipEndpoints: {} };
const context = () => ({ store: {} as never, definition: definition(), runtimeTypes });

describe("schemaBrief", () => {
  it("概念分组直接带上成员，模型不调工具也知道每组里有哪些对象类型", () => {
    const brief = schemaBrief(context());
    expect(brief).toContain("概念分组：客户域（2 个：客户、用户）；未归组：账单");
    expect(brief).toContain("对象类型：");
    expect(brief).toContain("用户(绑定 GISTOOLS.TB_X)");
    expect(brief).toContain("关系类型：客户拥有用户");
  });

  it("分组里没有成员、或整个本体都没有分组时也说得清楚", () => {
    const empty: OntologyDefinition = { ...definition(), groups: [{ id: 客户域id, name: "空域", color: "" }], entityTypes: definition().entityTypes.map((item) => ({ ...item, groupId: "" })) } as unknown as OntologyDefinition;
    const brief = schemaBrief({ store: {} as never, definition: empty, runtimeTypes });
    expect(brief).toContain("空域（0 个：还没有对象类型）");
    expect(brief).toContain("未归组：客户、用户、账单");

    const none: OntologyDefinition = { ...definition(), groups: [] } as unknown as OntologyDefinition;
    expect(schemaBrief({ store: {} as never, definition: none, runtimeTypes })).toContain("概念分组：无；未归组：客户、用户、账单");
  });

  it("不带对象数：实例层面的数字不给模型", () => {
    const withCounts: RuntimeTypeSet = { labels: [{ name: "用户", count: 42 }], relationshipTypes: [{ name: "客户拥有用户", count: 7 }], entityCount: 42, relationshipCount: 7, relationshipEndpoints: {} };
    const brief = schemaBrief({ store: {} as never, definition: definition(), runtimeTypes: withCounts });
    expect(brief).not.toContain("42");
    expect(brief).not.toContain("7 条");
  });

  it("工具关了，就不再把它的 data_source 提示写给模型", () => {
    const withSource = { store: {} as never, definition: definition(), runtimeTypes, dataSources: [{ id: "s", name: "Oracle 测试", kind: "ORACLE", schema_name: "GISTOOLS" }] as never };
    expect(schemaBrief(withSource, ["search_schema"])).not.toContain("data_source 用这里的名字");
    expect(schemaBrief(withSource, ["search_schema", "run_sql"])).toContain("run_sql 的 data_source 用这里的名字");
    // 不传 = 老行为（单测与老调用方不受影响）
    expect(schemaBrief(withSource)).toContain("get_table_ddl / run_sql 的 data_source 用这里的名字");
  });
});

describe("buildInstructions", () => {
  it("没配提示词就用默认的，概念清单照样接在后面", () => {
    const instructions = buildInstructions(undefined, context());
    expect(instructions.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
    expect(instructions).toContain("当前本体的概念清单");
    expect(instructions).toContain("概念分组：客户域（2 个：客户、用户）");
  });

  /*
   * 这一组是 2026-10-14 用户实测的回归：管理员在「MCP 调试」里关掉 get_table_ddl，
   * 工具清单里已经没有它了，可提示词还写着"先 get_table_ddl 看表结构"，模型照着调，
   * 回一条 `AI_NoSuchToolError: Model tried to call unavailable tool 'get_table_ddl'`。
   * 判据：**关掉的工具名在最终 instructions 里一个字都不能出现**。
   */
  it("关掉的工具不会出现在提示词里（模型看不到，就不该让它去调）", () => {
    const instructions = buildInstructions(undefined, context(), {
      enabledTools: ["search_schema", "get_object_type", "list_concept_groups", "traverse_object_types", "run_query"],
    });
    expect(instructions).toContain("本轮可用工具");
    expect(instructions).toContain("run_query：**要具体数据优先用它**");
    expect(instructions).not.toContain("get_table_ddl");
    expect(instructions).not.toContain("run_sql");
  });

  it("提示词正文不再写死任何工具名（工具名只由「本轮可用工具」一节给）", () => {
    for (const name of ["search_schema", "get_object_type", "traverse_object_types", "list_concept_groups", "list_interfaces", "list_metrics", "list_actions", "run_query", "get_table_ddl", "run_sql"]) {
      expect(DEFAULT_SYSTEM_PROMPT).not.toContain(name);
    }
  });

  it("只开源表那条路时，说明里给的是 get_table_ddl + run_sql", () => {
    const instructions = buildInstructions(undefined, context(), { enabledTools: ["search_schema", "get_object_type", "get_table_ddl", "run_sql"] });
    expect(instructions).toContain("先 get_table_ddl");
    expect(instructions).not.toContain("run_query");
  });

  it("一个取数工具都没开时，明说这一轮取不了数", () => {
    const instructions = buildInstructions(undefined, context(), { enabledTools: ["search_schema", "get_object_type"] });
    expect(instructions).toContain("当前不开放取数");
    expect(toolGuide(["search_schema"])).not.toContain("get_table_ddl");
  });
  it("空白（只打了空格）也算没配", () => {
    expect(buildInstructions("   \n  ", context()).startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it("配了就用自己的那段，并且在最前面", () => {
    const instructions = buildInstructions("你是专线业务的助手，回答必须先说结论。", context());
    expect(instructions.startsWith("你是专线业务的助手，回答必须先说结论。")).toBe(true);
    expect(instructions).not.toContain("你是本体（ontology）推理助手");
    // 概念清单是数据不是提示词：无论用哪段提示词都自动带上
    expect(instructions).toContain("当前本体的概念清单");
  });

  it("自定义提示词也去不掉工具一节：它由代码按这一轮的真实开关生成", () => {
    const instructions = buildInstructions("你是专线业务的助手，回答必须先说结论。", context(), { enabledTools: ["search_schema", "run_query"] });
    expect(instructions).toContain("你是专线业务的助手，回答必须先说结论。");
    expect(instructions).toContain("本轮可用工具");
    expect(instructions).not.toContain("get_table_ddl");
  });
});

describe("isCustomSystemPrompt", () => {
  it("空、空白、以及和默认一模一样都算没改", () => {
    expect(isCustomSystemPrompt(undefined)).toBe(false);
    expect(isCustomSystemPrompt("  ")).toBe(false);
    expect(isCustomSystemPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });

  it("改了才算改（前后空格不算改）", () => {
    expect(isCustomSystemPrompt(` ${DEFAULT_SYSTEM_PROMPT} `)).toBe(false);
    expect(isCustomSystemPrompt(`${DEFAULT_SYSTEM_PROMPT}\n补充：先给结论。`)).toBe(true);
  });
});
