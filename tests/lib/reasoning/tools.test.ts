import { describe, expect, it } from "vitest";
import { longestCommonSubstring, queryTokens, rankSchemaConcepts, REASONING_TOOLS, runReasoningTool, schemaConcepts, traverseTypeGraph } from "@/lib/reasoning/tools";
import type { OntologyDefinition } from "@/lib/ontology";
import type { RuntimeTypeSet } from "@/lib/graph/types";

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
    expect(下单.detail).toContain("用户 → 订单");
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
  it("给模型的是定义层工具，实例工具留在目录里但标成 disabled", () => {
    const active = REASONING_TOOLS.filter((tool) => !tool.disabled).map((tool) => tool.name);
    const parked = REASONING_TOOLS.filter((tool) => tool.disabled).map((tool) => tool.name);
    // 这一版只在对象类型 / 关系类型这一层推理：实例工具不进模型、不进 MCP 的 tools/list，
    // 只在「MCP 调试」页灰着显示。要恢复实例推理，就把下面两个名字的 disabled 去掉。
    expect(active).toEqual(["search_schema", "get_object_type", "list_concept_groups", "list_interfaces", "traverse_object_types", "get_table_ddl", "run_sql", "list_actions", "review_model"]);
    expect(parked).toEqual(["query_object_instance", "query_instance_subgraph"]);
  });
});

describe("review_model", () => {
  it("把建模问题按两档列出来，每条带规则码、主体与改法", async () => {
    const base = definition() as unknown as { entityTypes: unknown[] };
    const broken = {
      ...definition(),
      entityTypes: [
        ...base.entityTypes,
        { id: "99999999-9999-4999-8999-999999999998", name: "空壳", description: "", displayProperty: "", groupId: "", implements: [], properties: [], sources: [] },
      ],
    } as unknown as OntologyDefinition;
    const outcome = await runReasoningTool("review_model", {}, { store: {} as never, definition: broken, runtimeTypes });
    const payload = outcome.payload as {
      summary: string;
      warn_count: number;
      info_count: number;
      findings: { code: string; level: string; scope: string; subject?: string; issue: string; how_to_fix: string }[];
      note: string;
    };
    expect(payload.summary).toContain("建模体检");
    expect(payload.warn_count + payload.info_count).toBe(payload.findings.length);
    const empty = payload.findings.find((item) => item.code === "ENTITY_NO_PROPERTIES");
    expect(empty?.subject).toBe("空壳");
    expect(empty?.level).toBe("该改");
    expect(empty?.scope).toBe("对象类型");
    expect(empty?.issue).toContain("空壳");
    expect(empty?.how_to_fix).toBeTruthy();
    // 体检是建议层，不是发布门禁 —— 这句话必须跟着结论一起出去。
    expect(payload.note).toContain("不阻断发布");
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
      { id: "rrrrrrr1-1111-4111-8111-111111111111", name: "客户拥有用户", sourceEntityTypeId: 客户id, targetEntityTypeId: 用户id, properties: [] },
      { id: "rrrrrrr2-2222-4222-8222-222222222222", name: "用户产生应收", sourceEntityTypeId: 用户id, targetEntityTypeId: 应收id, properties: [] },
      { id: "rrrrrrr3-3333-4333-8333-333333333333", name: "用户拥有订购关系", sourceEntityTypeId: 用户id, targetEntityTypeId: 订购关系id, properties: [] },
      { id: "rrrrrrr4-4444-4444-8444-444444444444", name: "订购关系产生应收", sourceEntityTypeId: 订购关系id, targetEntityTypeId: 应收id, properties: [] },
    ],
    actionTypes: [],
    rules: [],
  } as unknown as OntologyDefinition;
}

describe("traverseTypeGraph", () => {
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

  it("从终点往回也走（关系类型是有方向的，但遍历不分方向）", () => {
    const result = traverseTypeGraph(chainDefinition(), { start: "应收", hops: 1 });
    // 节点按定义顺序返回
    expect(result.nodes.map((node) => node.name)).toEqual(["用户", "应收", "订购关系"]);
    // 这是节点集合的诱导子图：用户与订购关系都被走到（各 1 跳）时，它们之间那条关系也在结果里
    expect(result.edges.map((edge) => `${edge.relation}@${edge.hop}`).sort()).toEqual(["用户产生应收@1", "用户拥有订购关系@1", "订购关系产生应收@1"].sort());
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
      nodes: { name: string; hop: number; group: string }[];
      edges: { relation: string; from: string; to: string; hop: number }[];
      note: string;
    };
    expect(payload.hops).toBe(2);
    expect(payload.starts).toEqual(["客户"]);
    expect(payload.node_count).toBe(4);
    expect(payload.nodes).toContainEqual(expect.objectContaining({ name: "应收", hop: 2 }));
    expect(payload.edge_count).toBe(4);
    expect(payload.note).toContain("get_object_type");
    expect(outcome.evidence.some((item) => item.kind === "OBJECT_TYPE" && item.label === "应收")).toBe(true);
    expect(outcome.evidence.some((item) => item.kind === "RELATION_TYPE" && item.label === "用户产生应收")).toBe(true);
  });

  it("参数照传：关系类型限定、跳数上限", async () => {
    const limited = await runReasoningTool("traverse_object_types", { start_type: "客户", hops: 9, relationship_types: ["客户拥有用户"] }, context);
    const payload = limited.payload as { hops: number; filters: { relationship_types: string[] }; edges: { relation: string }[] };
    expect(payload.hops).toBe(5);
    expect(payload.filters.relationship_types).toEqual(["客户拥有用户"]);
    expect(payload.edges.map((edge) => edge.relation)).toEqual(["客户拥有用户"]);
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
