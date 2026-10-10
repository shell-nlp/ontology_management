import { describe, expect, it } from "vitest";
import { MCP_TOOL_GROUPS } from "@/lib/reasoning/mcp";
import { dataSourcesForTable, longestCommonSubstring, objectTypesBoundTo, parseTraverseDirection, queryTokens, rankSchemaConcepts, reasoningToolSet, REASONING_TOOLS, runReasoningTool, schemaConcepts, traverseTypeGraph } from "@/lib/reasoning/tools";
import { profileTableKey, type ColumnValueIndex } from "@/lib/datasource/column-profile";
import type { OntologyDefinition } from "@/lib/ontology";
import type { RuntimeTypeSet } from "@/lib/framework/graph/types";

const 用户类 = "11111111-1111-4111-8111-111111111111";
const 专线类 = "22222222-2222-4222-8222-222222222222";
const 订单类 = "33333333-3333-4333-8333-333333333333";
const 下单关系 = "44444444-4444-4444-8444-444444444444";
const 停机动作 = "55555555-5555-4555-8555-555555555555";

function definition(): OntologyDefinition {
  return {
    entityTypes: [
      { id: 用户类, name: "用户", description: "使用业务的客户", displayProperty: "姓名", properties: [{ name: "姓名", dataType: "TEXT", required: true, unique: false, indexed: false }], sources: [] },
      { id: 专线类, name: "专业线产品用户", description: "开通了专线产品的用户", displayProperty: "姓名", properties: [{ name: "套餐", dataType: "TEXT", required: false, unique: false, indexed: false }], sources: [] },
      { id: 订单类, name: "订单", description: "业务订单", displayProperty: "编号", properties: [{ name: "编号", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
    ],
    relationshipTypes: [{ id: 下单关系, name: "下单", sourceEntityTypeId: 用户类, targetEntityTypeId: 订单类, properties: [] }],
    actionTypes: [{ id: 停机动作, name: "停机", code: "suspend_line", description: "暂停专线服务", scopeEntityTypeId: 专线类, params: [{ name: "原因", dataType: "TEXT", required: true }], edits: [] }],
    rules: [],
  } as unknown as OntologyDefinition;
}

const runtimeTypes: RuntimeTypeSet = {
  labels: [
    { name: "用户", count: 1 },
    { name: "专业线产品用户", count: 2 },
    { name: "订单", count: 3 },
  ],
  relationshipTypes: [{ name: "下单", count: 3 }],
  entityCount: 6,
  relationshipCount: 3,
  relationshipEndpoints: {},
};

describe("queryTokens", () => {
  it("中文按 2 元组展开，英文按标点切", () => {
    expect(queryTokens("专线用户")).toContain("专线");
    expect(queryTokens("专线用户")).toContain("用户");
    expect(queryTokens("order list")).toEqual(expect.arrayContaining(["order", "list"]));
  });

  it("去掉标点与空白", () => {
    expect(queryTokens("  a, b  ")).toEqual(["a", "b"]);
  });
});

describe("longestCommonSubstring", () => {
  it("中文也能算出重合长度", () => {
    expect(longestCommonSubstring("专业线产品用户", "用户")).toBe(2);
    expect(longestCommonSubstring("订单编号", "编号")).toBe(2);
    expect(longestCommonSubstring("abc", "xyz")).toBe(0);
  });
});

describe("schemaConcepts", () => {
  it("对象类型带上属性，关系带上端点；实例层面的数字不进文案", () => {
    const concepts = schemaConcepts(definition(), runtimeTypes);
    const 用户 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")!;
    expect(用户.detail).toContain("属性 姓名");
    // 只在定义这一层推理：给模型看的文案里不该出现对象数 / 关系数
    expect(用户.detail).not.toContain("对象数");
    const 专线 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "专业线产品用户")!;
    // 类之间没有继承（2026-09-16 移除）：文案里不再有「父类 …」，也不会凭空多出别的类的属性。
    expect(专线.detail).not.toContain("父类");
    expect(concepts.some((item) => item.kind === "PROPERTY" && item.name === "专业线产品用户.姓名")).toBe(false);
    const 下单 = concepts.find((item) => item.kind === "RELATION_TYPE")!;
    // 关系类型双向：用 ↔ 表示两个方向都能走，不写箭头方向
    expect(下单.detail).toContain("用户 ↔ 订单");
    expect(下单.detail).not.toContain("关系数");
    const 停机 = concepts.find((item) => item.kind === "ACTION")!;
    expect(停机.detail).toContain("作用于 专业线产品用户");
  });
});

describe("rankSchemaConcepts", () => {
  it("名字完全一致排最前", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "订单", 5);
    expect(ranked[0]).toMatchObject({ kind: "OBJECT_TYPE", name: "订单" });
  });

  it("命中子类名字时也能找到（中文按 2 元组匹配）", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "专线", 5);
    expect(ranked.some((item) => item.name === "专业线产品用户")).toBe(true);
  });

  it("描述里的词也能命中", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "暂停专线服务", 5);
    expect(ranked.some((item) => item.kind === "ACTION" && item.name === "停机")).toBe(true);
  });

  it("完全没命中时兜底给一批概念，不至于返回空", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "zzz", 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].reason).toContain("兜底");
  });

  it("图库还是空的时候也兜得住（不按「有实例」筛）", () => {
    const empty: RuntimeTypeSet = { ...runtimeTypes, labels: [], relationshipTypes: [], entityCount: 0, relationshipCount: 0 };
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), empty), "zzz", 3);
    expect(ranked.length).toBeGreaterThan(0);
  });

  it("max_concepts 生效", () => {
    expect(rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "用户", 2)).toHaveLength(2);
  });
});

const 数据资源 = "99999999-9999-4999-8999-999999999999";

describe("工具范围", () => {
  it("定义层与实例工具都给模型用（实例工具走对象服务）", () => {
    const active = REASONING_TOOLS.filter((tool) => !tool.disabled).map((tool) => tool.name);
    // 2026-09-19：对象服务落地后实例工具重新开放（索引优先、没有就按主键回源）。
    expect(active).toEqual(["search_schema", "get_object_type", "list_concept_groups", "list_interfaces", "traverse_object_types", "get_table_ddl", "run_sql", "run_query", "query_object_instance", "query_instance_subgraph", "list_actions", "list_metrics"]);
    expect(REASONING_TOOLS.filter((tool) => tool.disabled).map((tool) => tool.name)).toEqual([]);
    // 2026-10-10：分组上的 disabled 曾漏改 —— 工具已开放，MCP 调试页却还把整组写成「暂不使用」。
    expect(MCP_TOOL_GROUPS.filter((group) => group.disabled).map((group) => group.key)).toEqual([]);
  });

  it("每个工具的 JSON Schema 都能被 AI SDK 的 jsonSchema() 收下（数组/枚举参数拼错只会在这里炸）", () => {
    const context = { store: {} as never, definition: definition(), runtimeTypes };
    expect(() => reasoningToolSet(context, () => {}, [])).not.toThrow();
    // 被用户关掉的工具不进模型能看到的那一份，别把开关做丢了。
    expect(Object.keys(reasoningToolSet(context, () => {}, ["run_sql"]))).not.toContain("run_sql");
  });
});

const 客户域id = "66666666-6666-4666-8666-666666666666";
const 账务域id = "77777777-7777-4777-8777-777777777777";

/** 三个对象类型两个分组：客户域有成员、账务域是空的、订单指向一个已删除的分组。 */
function groupedDefinition(): OntologyDefinition {
  const base = definition();
  return {
    ...base,
    groups: [
      { id: 客户域id, name: "客户域", color: "" },
      { id: 账务域id, name: "账务域", color: "" },
    ],
    entityTypes: base.entityTypes.map((item) =>
      item.id === 订单类 ? { ...item, groupId: "88888888-8888-4888-8888-888888888888" } : { ...item, groupId: 客户域id },
    ),
  } as unknown as OntologyDefinition;
}

describe("list_concept_groups", () => {
  it("列出概念分组和每组里的对象类型，空分组也列，未归组的单独说", async () => {
    const outcome = await runReasoningTool("list_concept_groups", {}, { store: {} as never, definition: groupedDefinition(), runtimeTypes });
    const payload = outcome.payload as {
      group_count: number;
      groups: { name: string; object_types: string[]; object_type_count: number }[];
      ungrouped_object_types?: string[];
      note: string;
    };
    expect(payload.group_count).toBe(2);
    expect(payload.groups).toEqual([
      { name: "客户域", object_types: ["用户", "专业线产品用户"], object_type_count: 2 },
      // 建了组还没归类型，照样列出来
      { name: "账务域", object_types: [], object_type_count: 0 },
    ]);
    // groupId 指向已删除的分组（或压根没填）的，都算未归组
    expect(payload.ungrouped_object_types).toEqual(["订单"]);
    expect(payload.note).toContain("不影响对象类型的定义");
    expect(outcome.evidence.map((item) => [item.kind, item.label])).toEqual([["GROUP", "客户域"], ["GROUP", "账务域"]]);
  });

  it("一个分组都没有时，全部类型都算未归组", async () => {
    const outcome = await runReasoningTool("list_concept_groups", {}, { store: {} as never, definition: definition(), runtimeTypes });
    const payload = outcome.payload as { group_count: number; groups: unknown[]; ungrouped_object_types?: string[] };
    expect(payload.group_count).toBe(0);
    expect(payload.groups).toEqual([]);
    expect(payload.ungrouped_object_types).toEqual(["用户", "专业线产品用户", "订单"]);
  });
});

describe("概念分组进检索面", () => {
  it("搜分组名能命中组里的对象类型", () => {
    const concepts = schemaConcepts(groupedDefinition(), runtimeTypes);
    const 用户 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")!;
    expect(用户.detail).toContain("分组 客户域");
    const ranked = rankSchemaConcepts(concepts, "客户域", 5);
    expect(ranked.some((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")).toBe(true);
  });

  it("get_object_type 报出它属于哪个分组", async () => {
    const outcome = await runReasoningTool("get_object_type", { type_name: "用户" }, { store: {} as never, definition: groupedDefinition(), runtimeTypes });
    expect((outcome.payload as { group: string }).group).toBe("客户域");
    const 订单 = await runReasoningTool("get_object_type", { type_name: "订单" }, { store: {} as never, definition: groupedDefinition(), runtimeTypes });
    // 没归组就是空串，不编一个分组名出来
    expect((订单.payload as { group: string }).group).toBe("");
  });
});

describe("get_object_type 的一跳信息", () => {
  const context = { store: {} as never, definition: chainDefinition(), runtimeTypes };
  type Neighbor = { relation: string; name: string; group: string; description: string; bound_tables: string[] };
  type OneHop = { outgoing: Neighbor[]; incoming: Neighbor[]; note: string };

  it("出边、入边分开列，带上对方的分组与绑表", async () => {
    const 用户 = (await runReasoningTool("get_object_type", { type_name: "用户" }, context)).payload as { one_hop: OneHop };
    expect(用户.one_hop.outgoing.map((item) => `${item.relation}→${item.name}@${item.group}`)).toEqual(["用户产生应收→应收@", "用户拥有订购关系→订购关系@"]);
    expect(用户.one_hop.incoming.map((item) => `${item.relation}←${item.name}@${item.group}`)).toEqual(["客户拥有用户←客户@客户域"]);
    expect(用户.one_hop.note).toContain("traverse_object_types");

    const 应收 = (await runReasoningTool("get_object_type", { type_name: "应收" }, context)).payload as { one_hop: OneHop };
    expect(应收.one_hop.outgoing).toEqual([]);
    expect(应收.one_hop.incoming.map((item) => `${item.relation}←${item.name}`)).toEqual(["用户产生应收←用户", "订购关系产生应收←订购关系"]);
  });

  it("不再另外给一份没方向的 relations（一跳就这一处，别让模型读到两份）", async () => {
    const payload = (await runReasoningTool("get_object_type", { type_name: "用户" }, context)).payload as Record<string, unknown>;
    expect("one_hop" in payload).toBe(true);
    expect("relations" in payload).toBe(false);
  });
});

/** 把「专业线产品用户」绑到一张表上，用来验证工具会把绑定翻译成可读文本。 */
function boundDefinition(): OntologyDefinition {
  const base = definition();
  return {
    ...base,
    entityTypes: base.entityTypes.map((item) =>
      item.id === 专线类
        ? {
            ...item,
            properties: [
              {
                name: "套餐",
                displayName: "套餐名",
                description: "用户当前主套餐",
                dataType: "TEXT",
                required: false,
                unique: false,
                indexed: false,
                sourceField: "PACKAGE_NAME",
              },
            ],
            sources: [
              {
                id: "src-1",
                dataSourceId: 数据资源,
                schema: "GISTOOLS",
                view: "TB_MK_GRP_LINE_LIST_DAY",
                primaryKey: ["USER_ID"],
                titleField: "USER_ID",
              },
            ],
          }
        : item,
    ),
  } as unknown as OntologyDefinition;
}

describe("schemaConcepts 的绑定信息", () => {
  it("对象类型的说明里带上绑定的表与资源名", () => {
    const concepts = schemaConcepts(boundDefinition(), runtimeTypes, [{ id: 数据资源, name: "Oracle 测试 1251" } as never]);
    const 专线 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "专业线产品用户")!;
    expect(专线.detail).toContain("绑定 GISTOOLS.TB_MK_GRP_LINE_LIST_DAY");
    expect(专线.detail).toContain("Oracle 测试 1251");
    // 表名进检索面：问「TB_MK_GRP_LINE_LIST_DAY 是哪张表」也能命中这个对象类型。
    const ranked = rankSchemaConcepts(concepts, "TB_MK_GRP_LINE_LIST_DAY", 5);
    expect(ranked.some((item) => item.kind === "OBJECT_TYPE" && item.name === "专业线产品用户")).toBe(true);
  });
});

const 标签类 = "77777777-7777-4777-8777-777777777777";

/** 带取值枚举的样本：U_TYPE 这种「码值藏在注释里」的列，靠 enumValues 把中文口径显式挂上。 */
function enumDefinition(): OntologyDefinition {
  return {
    entityTypes: [{
      id: 标签类,
      name: "全量用户标签",
      description: "用户的全球通等级等标签",
      displayProperty: "USER_ID",
      properties: [
        { name: "USER_ID", dataType: "TEXT", required: true, unique: true, indexed: false, sourceField: "USER_ID" },
        { name: "U_TYPE", displayName: "全球通等级", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "U_TYPE", enumValues: [{ value: "1", label: "全球通" }, { value: "0", label: "非全球通" }] },
      ],
      sources: [{ id: "primary", dataSourceId: 线路资源, schema: "GISTOOLS", view: "TB_KR_GRP_ALL_USER_FLAG_DAY", primaryKey: ["USER_ID"], titleField: "USER_ID" }],
    }],
    groups: [],
    interfaces: [],
    metrics: [],
    relationshipTypes: [],
    actionTypes: [],
    rules: [],
  } as unknown as OntologyDefinition;
}

describe("属性的取值枚举（码值）在工具里的说法", () => {
  it("get_object_type 把属性上的取值枚举带给模型（码值 + 中文含义）", async () => {
    const payload = (await runReasoningTool("get_object_type", { type_name: "全量用户标签" }, { store: {} as never, definition: enumDefinition(), runtimeTypes })).payload as { properties: { name: string; enum_values?: { value: string; label: string }[] }[] };
    expect(payload.properties.find((item) => item.name === "U_TYPE")!.enum_values).toEqual([{ value: "1", label: "全球通" }, { value: "0", label: "非全球通" }]);
  });

  it("search_schema 能用枚举的中文名命中属性（「全球通」→ U_TYPE），算取值命中", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(enumDefinition(), runtimeTypes), "全球通", 20);
    const hit = ranked.find((item) => item.source_column === "U_TYPE")!;
    expect(hit.matched).toBe("value");
    expect(hit.object_type).toBe("全量用户标签");
  });
});

describe("search_schema 的 data_source 落点（省掉一轮反查）", () => {
  it("命中结果带上结构化 data_source：模型不用再从说明文字里人工读资源名", () => {
    const concepts = schemaConcepts(boundDefinition(), runtimeTypes, [{ id: 数据资源, name: "Oracle 测试 1251" } as never]);
    const ranked = rankSchemaConcepts(concepts, "TB_MK_GRP_LINE_LIST_DAY", 5);
    const hit = ranked.find((item) => item.kind === "OBJECT_TYPE" && item.name === "专业线产品用户")!;
    expect(hit.bound_table).toBe("GISTOOLS.TB_MK_GRP_LINE_LIST_DAY");
    expect(hit.data_source).toBe("Oracle 测试 1251");
  });

  it("属性命中同样带 data_source：取值命中时「哪张表 + 哪一列 + 哪个资源」一次给全", () => {
    const concepts = schemaConcepts(boundDefinition(), runtimeTypes, [{ id: 数据资源, name: "Oracle 测试 1251" } as never]);
    const ranked = rankSchemaConcepts(concepts, "套餐", 20);
    const hit = ranked.find((item) => item.source_column === "PACKAGE_NAME")!;
    expect(hit.data_source).toBe("Oracle 测试 1251");
  });
});

describe("get_object_type 的数据来源", () => {
  it("把绑定翻译成资源名与表名，不是 UUID；属性带上映射列", async () => {
    const outcome = await runReasoningTool(
      "get_object_type",
      { type_name: "专业线产品用户" },
      { store: {} as never, definition: boundDefinition(), runtimeTypes, dataSources: [{ id: 数据资源, name: "Oracle 测试 1251" } as never] },
    );
    const payload = outcome.payload as {
      sources: Record<string, unknown>[];
      properties: Record<string, unknown>[];
      data_source_note: string;
    };
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0]).toMatchObject({
      role: "主来源",
      data_source: "Oracle 测试 1251",
      schema: "GISTOOLS",
      view: "TB_MK_GRP_LINE_LIST_DAY",
      primary_key: ["USER_ID"],
      title_field: "USER_ID",
    });
    const 套餐 = payload.properties.find((item) => item.name === "套餐")!;
    expect(套餐.source_field).toBe("PACKAGE_NAME");
    expect(套餐.source_role).toBe("主来源");
    expect(套餐.display_name).toBe("套餐名");
    // 只有这个类自己定义的属性（继承已移除）：别的类的属性不会跟过来。
    expect(payload.properties.some((item) => item.name === "姓名")).toBe(false);
  });

  it("没绑数据源时如实说明，不编造 sources", async () => {
    const outcome = await runReasoningTool(
      "get_object_type",
      { type_name: "订单" },
      { store: {} as never, definition: boundDefinition(), runtimeTypes },
    );
    const payload = outcome.payload as { sources: unknown[]; data_source_note: string };
    expect(payload.sources).toEqual([]);
    expect(payload.data_source_note).toContain("还没有绑定数据资源");
  });

  it("来源没绑数据资源（dataSourceId 为空）时如实标出，并用唯一的模式名匹配兜底给出资源名", async () => {
    const def = boundDefinition();
    (def.entityTypes.find((item) => item.id === 专线类)!.sources as { dataSourceId: string }[])[0].dataSourceId = "";
    const outcome = await runReasoningTool(
      "get_object_type",
      { type_name: "专业线产品用户" },
      { store: {} as never, definition: def, runtimeTypes, dataSources: [{ id: 数据资源, name: "Oracle 测试 1251", schema_name: "GISTOOLS" } as never] },
    );
    const payload = outcome.payload as { sources: Record<string, unknown>[] };
    expect(payload.sources[0].binding).toBe("unbound");
    // 模式名唯一对得上，就兜底把资源名给出来，模型才能接着调 get_table_ddl。
    expect(payload.sources[0].data_source).toBe("Oracle 测试 1251");
  });
});
const 客户id = "aaaaaaa1-1111-4111-8111-111111111111";
const 用户id = "aaaaaaa2-2222-4222-8222-222222222222";
const 应收id = "aaaaaaa3-3333-4333-8333-333333333333";
const 订购关系id = "aaaaaaa4-4444-4444-8444-444444444444";

/**
 * 多跳用的样本：客户 —拥有→ 用户 —产生→ 应收，用户还有一条 —拥有→ 订购关系，订购关系又 —产生→ 应收。
 * 应收既在 2 跳上（经用户）、又在 3 跳上（经订购关系），用来验证 hop 取的是**最短**距离。
 */
function chainDefinition(): OntologyDefinition {
  const type = (id: string, name: string, description: string, groupId = "") => ({ id, name, description, displayProperty: "", groupId, properties: [], sources: [] });
  return {
    groups: [{ id: "aaaaaaa9-9999-4999-8999-999999999999", name: "客户域", color: "" }],
    entityTypes: [
      { ...type(客户id, "客户", "社会实体", "aaaaaaa9-9999-4999-8999-999999999999") },
      { ...type(用户id, "用户", "客户订购的服务实例") },
      { ...type(应收id, "应收", "应向客户收取的费用") },
      { ...type(订购关系id, "订购关系", "用户与产品的订购关系") },
    ],
    relationshipTypes: [
      { id: "rrrrrrr1-1111-4111-8111-111111111111", name: "客户拥有用户", sourceEntityTypeId: 客户id, targetEntityTypeId: 用户id, cardinality: "ONE_TO_MANY", properties: [], sourceKeyMappings: [{ entityProperty: "CUST_ID" }], targetKeyMappings: [{ entityProperty: "ID" }] },
      { id: "rrrrrrr2-2222-4222-8222-222222222222", name: "用户产生应收", sourceEntityTypeId: 用户id, targetEntityTypeId: 应收id, properties: [] },
      { id: "rrrrrrr3-3333-4333-8333-333333333333", name: "用户拥有订购关系", sourceEntityTypeId: 用户id, targetEntityTypeId: 订购关系id, properties: [] },
      { id: "rrrrrrr4-4444-4444-8444-444444444444", name: "订购关系产生应收", sourceEntityTypeId: 订购关系id, targetEntityTypeId: 应收id, properties: [] },
    ],
    actionTypes: [],
    rules: [],
  } as unknown as OntologyDefinition;
}

describe("traverseTypeGraph", () => {
  it("实现接口带来的关系也算一条边：账户 1 跳能到实现了接口的集团客户", () => {
    const 账户id = "aaaaaaa5-5555-4555-8555-555555555555";
    const 集团客户id = "aaaaaaa6-6666-4666-8666-666666666666";
    const 接口id = "aaaaaaa7-7777-4777-8777-777777777777";
    const 特征约束 = { id: "ccccccc1-1111-4111-8111-111111111111", name: "客户拥有账户", targetKind: "OBJECT_TYPE" as const, targetId: 账户id, cardinality: "MANY" as const };
    const definition = {
      groups: [],
      entityTypes: [
        { id: 客户id, name: "客户", description: "", properties: [], sources: [] },
        { id: 集团客户id, name: "集团客户", description: "", properties: [], sources: [], implements: [接口id] },
        { id: 账户id, name: "账户", description: "", properties: [], sources: [] },
      ],
      interfaces: [{ id: 接口id, name: "客户", description: "", promotedFromEntityTypeId: 客户id, extends: [], properties: [], linkConstraints: [特征约束] }],
      relationshipTypes: [{ id: "rrrrrrr9-9999-4999-8999-999999999999", name: "客户拥有账户", sourceEntityTypeId: 客户id, targetEntityTypeId: 账户id, properties: [] }],
      actionTypes: [],
      rules: [],
    } as unknown as OntologyDefinition;

    // 集团客户 一条直接关系都没有，但实现了接口「客户」，所以 账户 1 跳就能走到它。
    const result = traverseTypeGraph(definition, { start: "账户", hops: 1 });
    expect(result.nodes.map((node) => `${node.name}@${node.hop}`)).toContain("集团客户@1");
    const derived = result.edges.find((edge) => edge.from === "集团客户" && edge.to === "账户")!;
    expect(derived.via_interface).toBe("客户");
    // 直接建在影子对象类型上的那条边照旧也在（不是二选一）。
    expect(result.edges.some((edge) => edge.from === "客户" && edge.relation === "客户拥有账户")).toBe(true);
  });

  it("默认 3 跳；hop 取最短距离，edges 是诱导子图（含跨层的那些关系）", () => {
    const result = traverseTypeGraph(chainDefinition(), { start: "客户" });
    expect(result.hops).toBe(3);
    expect(result.nodes.map((node) => `${node.name}@${node.hop}`)).toEqual(["客户@0", "用户@1", "应收@2", "订购关系@2"]);
    // 应收在 2 跳（经用户）就在 2 跳上定下来，不会因为 3 跳那条路变成 3
    expect(result.edges.map((edge) => `${edge.relation}@${edge.hop}`)).toEqual(["客户拥有用户@1", "用户产生应收@2", "用户拥有订购关系@2", "订购关系产生应收@2"]);
    expect(result.nodes[0].group).toBe("客户域");
  });

  it("不指定起点 = 从全部对象类型出发，等于整张类型图（都是 0 跳）", () => {
    const result = traverseTypeGraph(chainDefinition());
    expect(result.starts).toEqual(["客户", "用户", "应收", "订购关系"]);
    expect(result.nodes.map((node) => node.hop)).toEqual([0, 0, 0, 0]);
    expect(result.edges).toHaveLength(4);
  });

  it("跳数可设：1 跳只看一圈，超过上限按 5 跳算", () => {
    const one = traverseTypeGraph(chainDefinition(), { start: "客户", hops: 1 });
    expect(one.nodes.map((node) => node.name)).toEqual(["客户", "用户"]);
    expect(one.edges.map((edge) => edge.relation)).toEqual(["客户拥有用户"]);
    expect(traverseTypeGraph(chainDefinition(), { hops: 9 }).hops).toBe(5);
    // 没给 / 给了非数字都回到默认 3
    expect(traverseTypeGraph(chainDefinition(), { hops: Number.NaN }).hops).toBe(3);
  });

  it("从终点往回也走：关系类型是双向的，遍历默认不分方向", () => {
    const result = traverseTypeGraph(chainDefinition(), { start: "应收", hops: 1 });
    expect(result.direction).toBe("both");
    // 节点按定义顺序返回
    expect(result.nodes.map((node) => node.name)).toEqual(["用户", "应收", "订购关系"]);
    // 这是节点集合的诱导子图：用户与订购关系都被走到（各 1 跳）时，它们之间那条关系也在结果里
    expect(result.edges.map((edge) => `${edge.relation}@${edge.hop}`).sort()).toEqual(["用户产生应收@1", "用户拥有订购关系@1", "订购关系产生应收@1"].sort());
  });

  it("direction 收窄：forward 只沿起点→终点，backward 只沿终点→起点", () => {
    // 客户只有出边：只往回走就一步都走不出去
    expect(traverseTypeGraph(chainDefinition(), { start: "客户", direction: "backward" }).nodes.map((node) => node.name)).toEqual(["客户"]);
    // 应收只有入边：只往外走同样走不出去
    expect(traverseTypeGraph(chainDefinition(), { start: "应收", direction: "forward" }).nodes.map((node) => node.name)).toEqual(["应收"]);
    // 用户两头都有：forward 到应收与订购关系，backward 到客户
    expect(traverseTypeGraph(chainDefinition(), { start: "用户", direction: "forward", hops: 1 }).nodes.map((node) => node.name)).toEqual(["用户", "应收", "订购关系"]);
    expect(traverseTypeGraph(chainDefinition(), { start: "用户", direction: "backward", hops: 1 }).nodes.map((node) => node.name)).toEqual(["客户", "用户"]);
    // 不认识的方向回落 both（工具入参先过一遍 parseTraverseDirection）
    expect(parseTraverseDirection("sideways")).toBe("both");
    expect(parseTraverseDirection(undefined)).toBe("both");
  });

  it("限定关系类型：只沿这几条走", () => {
    const result = traverseTypeGraph(chainDefinition(), { start: "用户", relationshipTypes: ["用户产生应收"] });
    expect(result.nodes.map((node) => `${node.name}@${node.hop}`)).toEqual(["用户@0", "应收@1"]);
    expect(result.edges.map((edge) => edge.relation)).toEqual(["用户产生应收"]);
    expect(result.filters.relationship_types).toEqual(["用户产生应收"]);
    // 从客户出发、只留下游那条关系：一步都走不出去，只剩起点
    const stuck = traverseTypeGraph(chainDefinition(), { start: "客户", relationshipTypes: ["用户产生应收"] });
    expect(stuck.nodes.map((node) => node.name)).toEqual(["客户"]);
    expect(stuck.edges).toEqual([]);
  });

  it("限定对象类型：范围外的类型整支都不展开", () => {
    const result = traverseTypeGraph(chainDefinition(), { start: "客户", objectTypes: ["客户", "用户"] });
    expect(result.nodes.map((node) => node.name)).toEqual(["客户", "用户"]);
    expect(result.edges.map((edge) => edge.relation)).toEqual(["客户拥有用户"]);
  });

  it("起点写错、过滤名字写错都如实报出来，不猜", () => {
    const bad = traverseTypeGraph(chainDefinition(), { start: "查无此类" });
    expect(bad.unknown_start).toBe("查无此类");
    expect(bad.nodes).toEqual([]);
    const filtered = traverseTypeGraph(chainDefinition(), { start: "客户", objectTypes: ["客户", "不存在的类"], relationshipTypes: ["也不存在"] });
    expect(filtered.unknown_names).toEqual(["不存在的类", "也不存在"]);
  });

  it("没有对象类型时不炸", () => {
    expect(traverseTypeGraph({ groups: [], entityTypes: [], relationshipTypes: [], actionTypes: [], rules: [] } as unknown as OntologyDefinition).nodes).toEqual([]);
  });
});

describe("traverse_object_types", () => {
  const context = { store: {} as never, definition: chainDefinition(), runtimeTypes };

  it("返回节点、关系与限定条件；证据里带上对象类型与关系类型", async () => {
    const outcome = await runReasoningTool("traverse_object_types", { start_type: "客户", hops: 2 }, context);
    const payload = outcome.payload as {
      hops: number;
      starts: string[];
      node_count: number;
      edge_count: number;
      // 列序固定：nodes = [对象类型名, 分组, 跳数, 描述, [绑定的表]]
      nodes: [string, string, number, string, string[]][];
      edges: [string, string, string, number, string, string][];
      note: string;
    };
    expect(payload.hops).toBe(2);
    expect(payload.starts).toEqual(["客户"]);
    expect(payload.node_count).toBe(4);
    expect(payload.nodes).toContainEqual(["应收", "", 2, expect.any(String), expect.any(Array)]);
    // 列序必须写在工具说明里（模型靠它读数组）—— 说明与实现不能对不上。
    expect(REASONING_TOOLS.find((item) => item.name === "traverse_object_types")!.description).toContain("[对象类型名, 分组, 跳数, 描述, [绑定的表]]");
    expect(payload.edge_count).toBe(4);
    expect(payload.note).toContain("get_object_type");
    expect(outcome.evidence.some((item) => item.kind === "OBJECT_TYPE" && item.label === "应收")).toBe(true);
    expect(outcome.evidence.some((item) => item.kind === "RELATION_TYPE" && item.label === "用户产生应收")).toBe(true);
  });

  it("边带上 key_mapping：2 跳以上也能拿到连接键，不用猜（列序写进说明）", async () => {
    const outcome = await runReasoningTool("traverse_object_types", { start_type: "客户", hops: 1 }, context);
    const edges = (outcome.payload as { edges: [string, string, string, number, string, string, { source: string[]; target: string[] } | ""][] }).edges;
    const edge = edges.find((item) => item[0] === "客户拥有用户")!;
    // 没配键映射的边第 7 位是空串；配了的给出 source → target 两端。
    expect(edge[6]).toEqual({ source: ["外键 CUST_ID"], target: ["外键 ID"] });
    expect(edges.filter((item) => item[0] !== "客户拥有用户").every((item) => item[6] === "")).toBe(true);
    // 列序必须写在工具说明里（模型靠它读数组）—— 说明与实现不能对不上。
    expect(REASONING_TOOLS.find((item) => item.name === "traverse_object_types")!.description).toContain("[关系类型名, 起点对象类型, 终点对象类型, 跳数, 经哪个接口, 基数, 键映射]");
  });

  it("参数照传：关系类型限定、跳数上限", async () => {
    const limited = await runReasoningTool("traverse_object_types", { start_type: "客户", hops: 9, relationship_types: ["客户拥有用户"] }, context);
    const payload = limited.payload as { hops: number; filters: { relationship_types: string[] }; edges: [string, string, string, number, string, string][] };
    expect(payload.hops).toBe(5);
    expect(payload.filters.relationship_types).toEqual(["客户拥有用户"]);
    expect(payload.edges.map((edge) => edge[0])).toEqual(["客户拥有用户"]);
  });

  it("direction 照传，note 里说明本次方向；不认识的取值回落 both", async () => {
    const backward = await runReasoningTool("traverse_object_types", { start_type: "客户", direction: "backward" }, context);
    const payload = backward.payload as { direction: string; node_count: number; edges: unknown[]; note: string };
    expect(payload.direction).toBe("backward");
    // 客户只有出边，只往回走就只剩起点
    expect(payload.node_count).toBe(1);
    expect(payload.edges).toEqual([]);
    expect(payload.note).toContain("只沿终点→起点");

    const fallback = await runReasoningTool("traverse_object_types", { start_type: "客户", direction: "sideways" }, context);
    expect((fallback.payload as { direction: string }).direction).toBe("both");
  });

  it("起点名字不对时直接报错，让模型先确认名字", async () => {
    await expect(runReasoningTool("traverse_object_types", { start_type: "查无此类" }, context)).rejects.toThrow("先用 search_schema");
  });

  it("过滤里出现本体没有的名字时如实返回", async () => {
    const outcome = await runReasoningTool("traverse_object_types", { start_type: "客户", object_types: ["客户", "不存在的类"] }, context);
    const payload = outcome.payload as { unknown_names?: string[]; unknown_note?: string };
    expect(payload.unknown_names).toEqual(["不存在的类"]);
    expect(payload.unknown_note).toContain("search_schema");
  });
});

const 线路类 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const 指标id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const 线路资源 = "99999999-9999-4999-8999-999999999997";
const 线路表 = "TB_MK_GRP_LINE_LIST_DAY";

/**
 * 带数据来源与指标的对象类型：查「落点字段」与「指标」用。
 * 属性的 description 故意写成「2=互联网专线」这种**列注释式口径**——现实里口径就长这样。
 */
function profiledDefinition(): OntologyDefinition {
  const base = definition();
  return {
    ...base,
    metrics: [
      {
        id: 指标id,
        name: "互联网专线条数",
        description: "状态正常的互联网专线条数",
        entityTypeId: 线路类,
        aggregation: "SUM",
        property: "条数",
        filters: [{ property: "专线类型", operator: "EQ", value: "2" }],
        dimensions: ["地市"],
        timeProperty: "",
        unitType: "",
        unit: "条",
        status: "verified",
        owner: "市场部数据组",
        tags: [],
      },
    ],
    entityTypes: [
      ...base.entityTypes.filter((item) => item.id !== 专线类),
      {
        id: 线路类,
        name: "专业线产品用户",
        description: "开通了专线产品的用户",
        displayProperty: "姓名",
        properties: [
          { name: "姓名", dataType: "TEXT", required: true, unique: false, indexed: false, sourceField: "CUST_NAME" },
          { name: "专线类型", description: "专线类型：2=互联网专线，3=语音专线", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "ZX_FLAG" },
          { name: "账单产品大类", description: "账单产品大类", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "OFFER_FLAG" },
          { name: "条数", dataType: "INTEGER", required: false, unique: false, indexed: false, sourceField: "ZX_COUNT" },
        ],
        sources: [{ id: "primary", dataSourceId: 线路资源, schema: "GISTOOLS", view: 线路表, primaryKey: ["CUST_ID"], titleField: "CUST_NAME" }],
      },
    ],
  } as unknown as OntologyDefinition;
}

describe("search_schema v2：落点字段、取值命中与配额", () => {
  it("属性的说明进检索面，命中时给出落点（哪张表、哪一列）", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(profiledDefinition(), runtimeTypes), "互联网专线", 20);
    const hit = ranked.find((item) => item.name === "专业线产品用户.专线类型");
    expect(hit).toBeTruthy();
    // 口径写在属性的说明里，不是名字里 —— matched 要如实说"是描述命中"。
    expect(hit!.matched).toBe("description");
    expect(hit!.bound_table).toBe(`GISTOOLS.${线路表}`);
    expect(hit!.source_column).toBe("ZX_FLAG");
    expect(hit!.object_type).toBe("专业线产品用户");
  });

  it("取值命中单独一档：列画像里的码值能被搜到，并给出落点", () => {
    const index: ColumnValueIndex = new Map([
      [profileTableKey("GISTOOLS", 线路表), new Map([["OFFER_FLAG", ["短彩信", "专线", "5G"]]])],
    ]);
    const ranked = rankSchemaConcepts(schemaConcepts(profiledDefinition(), runtimeTypes, [], index), "短彩信", 20);
    const hit = ranked.find((item) => item.source_column === "OFFER_FLAG");
    expect(hit?.matched).toBe("value");
    expect(hit?.bound_table).toBe(`GISTOOLS.${线路表}`);
  });

  it("kinds 只看指定类型；object_type 只看挂在某个对象类型下的概念", () => {
    const concepts = schemaConcepts(profiledDefinition(), runtimeTypes);
    const onlyTypes = rankSchemaConcepts(concepts, "用户", 20, { kinds: ["OBJECT_TYPE"] });
    expect(onlyTypes.length).toBeGreaterThan(0);
    expect(onlyTypes.every((item) => item.kind === "OBJECT_TYPE")).toBe(true);

    const scoped = rankSchemaConcepts(concepts.filter((item) => item.references?.includes("专业线产品用户")), "条数", 20);
    expect(scoped.every((item) => item.name.includes("专业线产品用户") || item.kind === "METRIC")).toBe(true);
    expect(scoped.some((item) => item.name === "订单")).toBe(false);
  });

  it("不传 kinds 时类型类概念保底占一半名额，不会被属性刷屏", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "用户", 5);
    const typeish = ranked.filter((item) => item.kind === "OBJECT_TYPE" || item.kind === "RELATION_TYPE" || item.kind === "METRIC");
    expect(typeish.length).toBeGreaterThanOrEqual(3);
  });

  it("指标是一类独立概念，能被检索、能被 get_object_type 与 list_metrics 取到", async () => {
    const def = profiledDefinition();
    const ranked = rankSchemaConcepts(schemaConcepts(def, runtimeTypes), "互联网专线条数", 20);
    expect(ranked[0]).toMatchObject({ kind: "METRIC", name: "互联网专线条数", matched: "name" });

    const detail = await runReasoningTool("get_object_type", { type_name: "专业线产品用户" }, { store: {} as never, definition: def, runtimeTypes });
    expect((detail.payload as { metrics: { name: string }[] }).metrics.map((item) => item.name)).toEqual(["互联网专线条数"]);

    const outcome = await runReasoningTool("list_metrics", {}, { store: {} as never, definition: def, runtimeTypes });
    const payload = outcome.payload as { metrics: { name: string; aggregation: string; property: string; unit: string; scope_object_type: string; filters: { property: string; value: string }[] }[] };
    expect(payload.metrics[0]).toMatchObject({ name: "互联网专线条数", aggregation: "SUM", property: "条数", unit: "条", scope_object_type: "专业线产品用户" });
    expect(payload.metrics[0].filters[0]).toMatchObject({ property: "专线类型", value: "2" });
    expect(outcome.evidence.map((item) => item.kind)).toEqual(["METRIC"]);
  });

  it("list_metrics 带 status / owner，并能按 status 过滤：模型据此分辨哪条口径可信", async () => {
    const def = profiledDefinition();
    def.metrics.push({ ...def.metrics[0], id: "66666666-6666-4666-8666-666666666666", name: "专线条数--test", status: "draft", owner: "" } as never);
    const all = (await runReasoningTool("list_metrics", {}, { store: {} as never, definition: def, runtimeTypes })).payload as { metrics: { name: string; status: string; owner: string }[] };
    expect(all.metrics.map((item) => [item.name, item.status])).toEqual([["互联网专线条数", "verified"], ["专线条数--test", "draft"]]);
    expect(all.metrics[0].owner).toBe("市场部数据组");
    // 只看已验收的口径：测试残留 / 配置示例就被过滤掉了。
    const verified = (await runReasoningTool("list_metrics", { status: "verified" }, { store: {} as never, definition: def, runtimeTypes })).payload as { metrics: { name: string }[] };
    expect(verified.metrics.map((item) => item.name)).toEqual(["互联网专线条数"]);
  });

  it("整个本体都没命中时给 no_match + 明确措辞：别把兜底推荐当成「命中的概念」", async () => {
    const ctx = { store: {} as never, definition: definition(), runtimeTypes };
    const miss = (await runReasoningTool("search_schema", { query: "完全不存在的业务黑话zzz" }, ctx)).payload as { no_match?: boolean; hint: string; matches: { matched: string }[] };
    expect(miss.no_match).toBe(true);
    expect(miss.hint).toContain("都没有命中");
    // 兜底结果照旧返回（供模型看本体里大概有什么），但每一条都要如实标成 fallback。
    expect(miss.matches.length).toBeGreaterThan(0);
    expect(miss.matches.every((item) => item.matched === "fallback")).toBe(true);

    // 有真命中就不该带 no_match。
    const hit = (await runReasoningTool("search_schema", { query: "订单" }, ctx)).payload as { no_match?: boolean };
    expect(hit.no_match).toBeUndefined();
  });

  it("工具层：没连平台库也能检索（取值索引取不到就跳过），并明确「表只能通过对象类型到达」", async () => {
    const outcome = await runReasoningTool("search_schema", { query: "专线", max_concepts: 20 }, { store: {} as never, definition: definition(), runtimeTypes });
    const payload = outcome.payload as { matches: { name: string }[]; note: string };
    expect(payload.matches.some((item) => item.name === "专业线产品用户")).toBe(true);
    expect(payload.note).toContain("表只能通过对象类型到达");
  });

  /*
   * 2026-10-10 用户口径：「列清单不要设上限把尾巴砍掉」。
   * 以前默认只回 20 条、上限 50，模型看到"命中 20 个概念"就以为是全部 ——
   * 尾巴里的概念（表尾列、低频属性）永远查不到。现在不传就是不限量。
   */
  it("不传 max_concepts 时给默认条数，但**如实报出命中总数**（尾巴可以不给，不能隐形）", async () => {
    const context = { store: {} as never, definition: profiledDefinition(), runtimeTypes };
    const all = (await runReasoningTool("search_schema", { query: "用户" }, context)).payload as { matches: unknown[]; total_matched: number; omitted?: number };
    expect(all.total_matched).toBeGreaterThanOrEqual(all.matches.length);
    // 同一份定义里传 5 条：拿到的更少，但总数必须一致（总数是真值，不是截断后的长度）。
    const capped = (await runReasoningTool("search_schema", { query: "用户", max_concepts: 5 }, context)).payload as { matches: unknown[]; total_matched: number };
    expect(all.matches.length).toBeGreaterThan(capped.matches.length);
    expect(capped.total_matched).toBe(all.total_matched);
  });

  it("自己传了 max_concepts 才截断，并且如实报出总数与被省掉的条数", async () => {
    const context = { store: {} as never, definition: profiledDefinition(), runtimeTypes };
    const capped = (await runReasoningTool("search_schema", { query: "用户", max_concepts: 5 }, context)).payload as { matches: unknown[]; total_matched: number; omitted?: number; omitted_note?: string };
    expect(capped.matches).toHaveLength(5);
    expect(capped.total_matched).toBeGreaterThan(5);
    expect(capped.omitted).toBe(capped.total_matched - 5);
    expect(capped.omitted_note).toContain("没给");
    expect(capped.omitted_note).toContain("max_concepts");
  });
});

describe("批量本体工具：单项信息不缩水", () => {
  const context = { store: {} as never, definition: groupedDefinition(), runtimeTypes };

  it("search_schema 支持多个 query，并按概念去重且保留命中来源", async () => {
    const single = (await runReasoningTool("search_schema", { query: "用户" }, context)).payload as { matches: { kind: string; name: string; detail: string }[] };
    const batch = (await runReasoningTool("search_schema", { queries: ["用户", "客户域"] }, context)).payload as { matches: { kind: string; name: string; detail: string; matched_queries: string[] }[] };
    const user = batch.matches.find((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")!;
    expect(user.detail).toBe(single.matches.find((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")!.detail);
    expect(user.matched_queries).toContain("用户");
    expect(new Set(batch.matches.map((item) => `${item.kind}:${item.name}`)).size).toBe(batch.matches.length);
  });

  it("get_object_type 数组返回每个单项的完整 payload", async () => {
    const single = (await runReasoningTool("get_object_type", { type_name: "用户" }, context)).payload as Record<string, unknown>;
    const batch = (await runReasoningTool("get_object_type", { type_names: ["用户", "订单"] }, context)).payload as { objects: Record<string, unknown>[] };
    expect(batch.objects[0]).toEqual(single);
    expect(batch.objects).toHaveLength(2);
  });
});

describe("数量关系（cardinality）在工具里的说法", () => {
  const context = { store: {} as never, definition: chainDefinition(), runtimeTypes };
  type Neighbor = { relation: string; name: string; cardinality?: string; cardinality_label?: string; cardinality_from_here?: string };
  type OneHop = { outgoing: Neighbor[]; incoming: Neighbor[] };

  it("get_object_type：出边给「从我看过去」的说法，入边把基数翻过来说", async () => {
    // chainDefinition 里「客户拥有用户」声明的是客户(起点) 一对多 用户(终点)。
    const 客户 = (await runReasoningTool("get_object_type", { type_name: "客户" }, context)).payload as { one_hop: OneHop };
    const out = 客户.one_hop.outgoing.find((item) => item.relation === "客户拥有用户")!;
    expect(out).toMatchObject({ cardinality: "ONE_TO_MANY", cardinality_label: "一对多" });
    expect(out.cardinality_from_here).toBe("一个「客户」→ 多个「用户」");

    const 用户 = (await runReasoningTool("get_object_type", { type_name: "用户" }, context)).payload as { one_hop: OneHop };
    const back = 用户.one_hop.incoming.find((item) => item.relation === "客户拥有用户")!;
    // 声明原样保留，但从用户这一侧看要翻过来说：多个用户 → 一个客户。
    expect(back.cardinality).toBe("ONE_TO_MANY");
    expect(back.cardinality_from_here).toBe("多个「用户」→ 一个「客户」");
  });

  it("没标注的关系类型不带 cardinality 字段（不是「多对多」）", async () => {
    const 用户 = (await runReasoningTool("get_object_type", { type_name: "用户" }, context)).payload as { one_hop: OneHop };
    const 未标注 = 用户.one_hop.outgoing.find((item) => item.relation === "用户产生应收")!;
    expect(未标注.cardinality).toBeUndefined();
    expect(未标注.cardinality_from_here).toBeUndefined();
  });

  it("traverse_object_types：边也带上基数", async () => {
    const outcome = await runReasoningTool("traverse_object_types", { start_type: "客户", hops: 1 }, context);
    // edges 的列序：[关系类型名, 起点, 终点, 跳数, 经哪个接口, 基数]
    const edges = (outcome.payload as { edges: [string, string, string, number, string, string][] }).edges;
    expect(edges.find((edge) => edge[0] === "客户拥有用户")?.[5]).toBe("ONE_TO_MANY");
    expect(edges.filter((edge) => edge[0] !== "客户拥有用户").every((edge) => edge[5] === "")).toBe(true);
  });

  it("search_schema：关系类型的 detail 里写出基数", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(chainDefinition(), runtimeTypes), "客户拥有用户", 10);
    const hit = ranked.find((item) => item.kind === "RELATION_TYPE" && item.name === "客户拥有用户")!;
    expect(hit.detail).toContain("基数 一对多");
  });
});

describe("objectTypesBoundTo（get_table_ddl 的反向引用）", () => {
  it("给出这张表被哪些对象类型绑定、各映射了哪几列；表名大小写不敏感", () => {
    const bound = objectTypesBoundTo(profiledDefinition(), 线路资源, "GISTOOLS", 线路表);
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ object_type: "专业线产品用户", source_role: expect.stringContaining("来源") });
    expect(bound[0].mapped_columns.sort()).toEqual(["CUST_NAME", "OFFER_FLAG", "ZX_COUNT", "ZX_FLAG"]);
    expect(bound[0].mapped_column_count).toBe(4);
    expect(objectTypesBoundTo(profiledDefinition(), 线路资源, "gistools", "tb_mk_grp_line_list_day")).toHaveLength(1);
  });

  it("没被任何对象类型绑定的表返回空 —— 这正是模型排查「表名是不是写错了」的线索", () => {
    expect(objectTypesBoundTo(profiledDefinition(), 线路资源, "GISTOOLS", "TB_OTHER")).toEqual([]);
    expect(objectTypesBoundTo(profiledDefinition(), "00000000-0000-4000-8000-000000000000", "GISTOOLS", 线路表)).toEqual([]);
  });

  it("来源的 dataSourceId 为空（导入后没补齐绑定）时仍然算绑定，并标出「未绑定数据资源」", () => {
    const def = profiledDefinition();
    (def.entityTypes.find((item) => item.id === 线路类)!.sources as { dataSourceId: string }[])[0].dataSourceId = "";
    const bound = objectTypesBoundTo(def, 线路资源, "GISTOOLS", 线路表);
    expect(bound).toHaveLength(1);
    expect(bound[0].binding).toBe("unbound");
    expect(bound[0].mapped_column_count).toBe(4);
  });

  it("来源正常绑定时标 bound —— 让模型能分辨「没填」和「填错了」", () => {
    const bound = objectTypesBoundTo(profiledDefinition(), 线路资源, "GISTOOLS", 线路表);
    expect(bound[0].binding).toBe("bound");
  });

  it("get_table_ddl 的说明写死了 bound_object_types 的列序（说明与实现对不上就是真丢信息）", () => {
    expect(REASONING_TOOLS.find((item) => item.name === "get_table_ddl")!.description)
      .toContain("[对象类型名, 映射到这张表的列, 来源角色, 主键列, 映射列总数, 绑定状态]");
  });

  /*
   * 2026-10-10 用户口径：「列清单不要设上限把尾巴砍掉」。
   * 现场是一张被映射了 51 列的表，返回里只列了前 30 列，从第 31 列起（含 U_TYPE 这种关键口径列）
   * 永远看不见，模型只能再调一次 get_object_type 反查。这个用例就是钉住"给全"。
   */
  it("映射列超过 30 个时也给全，不砍尾巴（清单长度 = 总数）", () => {
    const def = profiledDefinition();
    const many = Array.from({ length: 33 }, (_, index) => ({
      name: `属性${index + 1}`,
      dataType: "TEXT",
      required: false,
      unique: false,
      indexed: false,
      sourceField: `COL_${String(index + 1).padStart(2, "0")}`,
    }));
    (def.entityTypes.find((item) => item.id === 线路类)!.properties as typeof many) = many;
    const bound = objectTypesBoundTo(def, 线路资源, "GISTOOLS", 线路表);
    expect(bound[0].mapped_columns).toHaveLength(33);
    expect(bound[0].mapped_columns).toContain("COL_33");
    expect(bound[0].mapped_column_count).toBe(bound[0].mapped_columns.length);
  });
});

describe("get_table_ddl 自动定位数据资源（不给 data_source 也能查）", () => {
  const 资源 = (id: string, name: string, schema_name: string) => ({ id, name, schema_name } as never);

  it("按「模式.表」认资源；只给表名（不带模式）也认；没人认领就是空", () => {
    const def = profiledDefinition();
    const sources = [资源(线路资源, "Oracle 测试 1251", "GISTOOLS")];
    expect(dataSourcesForTable(def, sources, "GISTOOLS", 线路表).map((item) => item.name)).toEqual(["Oracle 测试 1251"]);
    expect(dataSourcesForTable(def, sources, "", 线路表).map((item) => item.name)).toEqual(["Oracle 测试 1251"]);
    expect(dataSourcesForTable(def, sources, "GISTOOLS", "TB_NOPE")).toEqual([]);
  });

  it("表名没人认领时给可操作的报错，且不先连库", async () => {
    await expect(runReasoningTool("get_table_ddl", { table: "GISTOOLS.TB_NOPE" }, {
      store: {} as never, definition: profiledDefinition(), runtimeTypes,
      dataSources: [资源(线路资源, "Oracle 测试 1251", "GISTOOLS")],
    })).rejects.toThrow(/TB_NOPE/);
  });

  it("工具的参数表里 data_source 不再是必填（table 才是）", () => {
    const spec = REASONING_TOOLS.find((item) => item.name === "get_table_ddl")!;
    expect(spec.parameters.required).toEqual(["tables"]);
  });
});
