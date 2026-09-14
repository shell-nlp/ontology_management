import { describe, expect, it } from "vitest";
import { longestCommonSubstring, queryTokens, rankSchemaConcepts, runReasoningTool, schemaConcepts } from "@/lib/reasoning/tools";
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
      { id: 用户类, name: "用户", description: "使用业务的客户", displayProperty: "姓名", parents: [], properties: [{ name: "姓名", dataType: "TEXT", required: true, unique: false, indexed: false }], sources: [] },
      { id: 专线类, name: "专业线产品用户", description: "开通了专线产品的用户", displayProperty: "姓名", parents: [用户类], properties: [{ name: "套餐", dataType: "TEXT", required: false, unique: false, indexed: false }], sources: [] },
      { id: 订单类, name: "订单", description: "业务订单", displayProperty: "编号", parents: [], properties: [{ name: "编号", dataType: "TEXT", required: true, unique: true, indexed: false }], sources: [] },
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
  it("对象类型带上对象数，属性带上类型，关系带上端点", () => {
    const concepts = schemaConcepts(definition(), runtimeTypes);
    const 用户 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "用户")!;
    expect(用户.detail).toContain("对象数 1");
    const 专线 = concepts.find((item) => item.kind === "OBJECT_TYPE" && item.name === "专业线产品用户")!;
    expect(专线.detail).toContain("父类 用户");
    // 继承来的属性也算这个类的属性
    expect(concepts.some((item) => item.kind === "PROPERTY" && item.name === "专业线产品用户.姓名")).toBe(true);
    const 下单 = concepts.find((item) => item.kind === "RELATION_TYPE")!;
    expect(下单.detail).toContain("用户 → 订单");
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

  it("完全没命中时按对象数兜底，不至于返回空", () => {
    const ranked = rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "zzz", 3);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].reason).toContain("兜底");
  });

  it("max_concepts 生效", () => {
    expect(rankSchemaConcepts(schemaConcepts(definition(), runtimeTypes), "用户", 2)).toHaveLength(2);
  });
});

const 数据资源 = "99999999-9999-4999-8999-999999999999";

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
    // 继承来、没有映射列的属性不该硬安一个来源角色。
    const 姓名 = payload.properties.find((item) => item.name === "姓名")!;
    expect(姓名.source_role).toBe("");
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