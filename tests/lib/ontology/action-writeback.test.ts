import { describe, expect, it } from "vitest";
import { actionWritebackDiffs, describeWritebackPlan, planActionWriteback, samePropertyValue } from "@/lib/ontology/action-writeback";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 动作写回：把"这次改了哪些属性"翻成"改哪张表的哪几列"。
 *
 * 这里只测**纯函数**那一半（计划 / 对拍 / 拒绝理由）。真去改库、键不唯一这些行为在连接器
 * （`updateRows`）里，靠真库验证，不在单测里假装。
 */

type Source = { id: string; kind: "PHYSICAL" | "DERIVED"; sql: string; rule: null; dataSourceId: string; schema: string; view: string; primaryKey: string[]; titleField: string };
type Property = { name: string; dataType: string; required: boolean; primaryKey: boolean; indexed: boolean; sourceField?: string; sourceId?: string };

const source = (over: Partial<Source> = {}): Source => ({
  id: "primary",
  kind: "PHYSICAL",
  sql: "",
  rule: null,
  dataSourceId: "ds-1",
  schema: "GISTOOLS",
  view: "TB_MK_GRP_LINE_LIST_DAY",
  primaryKey: ["USER_ID"],
  titleField: "",
  ...over,
});

const definition = (properties: Property[], sources: Source[] = [source()]): OntologyDefinition => ({
  entityTypes: [{ id: "t1", name: "专线产品用户", description: "", properties, sources }],
  relationshipTypes: [],
  actionTypes: [],
  interfaces: [],
  metrics: [],
  groups: [],
  rules: [],
} as unknown as OntologyDefinition);

const text = (name: string, over: Partial<Property> = {}): Property => ({
  name,
  dataType: "TEXT",
  required: false,
  primaryKey: false,
  indexed: false,
  ...over,
});

const userProps: Property[] = [
  text("用户标识", { sourceField: "USER_ID" }),
  text("客户名称", { sourceField: "CUST_NAME" }),
  text("产品状态", { sourceField: "PROD_STATE" }),
];

describe("前后对拍：这次动作到底改了什么", () => {
  const before = { nodes: [{ id: "n1", labels: ["专线产品用户"], properties: { 用户标识: "371", 产品状态: "在用" } }] };
  const definition0 = definition(userProps);

  it("值真的变了才算改动，没变的不进计划", () => {
    const after = { nodes: [{ id: "n1", labels: ["专线产品用户"], properties: { 用户标识: "371", 产品状态: "停用" } }] };
    const diffs = actionWritebackDiffs(definition0, before, after);
    expect(diffs).toEqual([{ nodeId: "n1", entityType: "专线产品用户", created: false, changes: [{ property: "产品状态", value: "停用" }] }]);
  });

  it("值没变（只有空白差异也算没变）就不进计划", () => {
    const after = { nodes: [{ id: "n1", labels: ["专线产品用户"], properties: { 用户标识: "371", 产品状态: " 在用 " } }] };
    expect(actionWritebackDiffs(definition0, before, after)).toEqual([]);
  });

  it("动作新建的对象单独标出来（写回只支持改已有行）", () => {
    const after = { nodes: [...before.nodes, { id: "n2", labels: ["专线产品用户"], properties: { 用户标识: "999" } }] };
    const diffs = actionWritebackDiffs(definition0, before, after);
    expect(diffs.at(-1)).toEqual({ nodeId: "n2", entityType: "专线产品用户", created: true, changes: [] });
  });

  it("画布坐标（fx / fy）不算业务改动", () => {
    const after = { nodes: [{ id: "n1", labels: ["专线产品用户"], properties: { 用户标识: "371", 产品状态: "在用", fx: 12, fy: 30 } }] };
    expect(actionWritebackDiffs(definition0, before, after)).toEqual([]);
  });
});

describe("写回计划", () => {
  it("单主键：键取改之前的属性值，赋值按属性的来源列", () => {
    const planned = planActionWriteback(definition(userProps), "专线产品用户", { 用户标识: "371", 产品状态: "在用" }, [{ property: "产品状态", value: "停用" }]);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.table).toBe("GISTOOLS.TB_MK_GRP_LINE_LIST_DAY");
    expect(planned.plan.schema).toBe("GISTOOLS");
    expect(planned.plan.view).toBe("TB_MK_GRP_LINE_LIST_DAY");
    expect(planned.plan.keys).toEqual([{ column: "USER_ID", value: "371" }]);
    expect(planned.plan.assignments).toEqual([{ column: "PROD_STATE", property: "产品状态", value: "停用" }]);
    expect(describeWritebackPlan(planned.plan)).toBe("改 GISTOOLS.TB_MK_GRP_LINE_LIST_DAY 里 USER_ID = 371 的那一行：PROD_STATE");
  });

  it("复合主键：两列都进 WHERE（多主键是一等公民）", () => {
    const props = [text("用户标识", { sourceField: "USER_ID" }), text("日期", { sourceField: "STATIS_DATE" }), text("产品状态", { sourceField: "PROD_STATE" })];
    const planned = planActionWriteback(
      definition(props, [source({ primaryKey: ["USER_ID", "STATIS_DATE"] })]),
      "专线产品用户",
      { 用户标识: "371", 日期: "2026-09-12", 产品状态: "在用" },
      [{ property: "产品状态", value: "停用" }],
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.keys).toEqual([{ column: "USER_ID", value: "371" }, { column: "STATIS_DATE", value: "2026-09-12" }]);
    expect(describeWritebackPlan(planned.plan)).toContain("USER_ID = 371 且 STATIS_DATE = 2026-09-12");
  });

  it("取数口径来源写不回去：拒绝理由要说清这是算出来的结果，并给出路", () => {
    const planned = planActionWriteback(definition(userProps, [source({ kind: "DERIVED", sql: "SELECT * FROM T", view: "T" })]), "专线产品用户", { 用户标识: "371" }, [{ property: "产品状态", value: "停用" }]);
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toContain("取数口径");
    expect(planned.refusal.hint).toBeTruthy();
  });

  it("没绑数据资源 / 没配主键列 / 主键列没映射到属性 —— 三种都拒绝并带路", () => {
    const noSource = planActionWriteback(definition(userProps, []), "专线产品用户", { 用户标识: "371" }, [{ property: "产品状态", value: "停用" }]);
    expect(noSource.ok).toBe(false);
    if (!noSource.ok) expect(noSource.refusal.reason).toContain("还没绑数据资源");

    const noPk = planActionWriteback(definition(userProps, [source({ primaryKey: [] })]), "专线产品用户", { 用户标识: "371" }, [{ property: "产品状态", value: "停用" }]);
    expect(noPk.ok).toBe(false);
    if (!noPk.ok) expect(noPk.refusal.hint).toContain("主键列");

    const unmapped = planActionWriteback(definition([text("用户标识"), text("产品状态", { sourceField: "PROD_STATE" })], [source({ primaryKey: ["USER_ID"] })]), "专线产品用户", { 用户标识: "371" }, [{ property: "产品状态", value: "停用" }]);
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) expect(unmapped.refusal.reason).toContain("USER_ID");
  });

  it("对象上没有主键值就不写：定位不到那一行", () => {
    const planned = planActionWriteback(definition(userProps), "专线产品用户", { 产品状态: "在用" }, [{ property: "产品状态", value: "停用" }]);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toContain("没有值");
  });

  it("主键属性不能用动作改：改了等于换一个对象", () => {
    const planned = planActionWriteback(definition(userProps), "专线产品用户", { 用户标识: "371" }, [{ property: "用户标识", value: "372" }]);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toContain("主键");
  });

  it("挂在补充来源上的属性不写回：只支持主来源", () => {
    const props = [text("用户标识", { sourceField: "USER_ID" }), text("客户名称", { sourceField: "CUST_NAME", sourceId: "secondary" })];
    const sources = [source(), source({ id: "secondary", view: "TB_OTHER", primaryKey: ["USER_ID"] })];
    const planned = planActionWriteback(definition(props, sources), "专线产品用户", { 用户标识: "371" }, [{ property: "客户名称", value: "新名字" }]);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.reason).toContain("补充来源");
  });

  it("没有任何属性变化时不产生计划（写回无事可做）", () => {
    const planned = planActionWriteback(definition(userProps), "专线产品用户", { 用户标识: "371" }, []);
    expect(planned.ok).toBe(false);
  });
});

describe("值的等价口径", () => {
  it("空值互相等价，空白差异不算变了，数字与字符串按文本比", () => {
    expect(samePropertyValue(null, "")).toBe(true);
    expect(samePropertyValue(undefined, null)).toBe(true);
    expect(samePropertyValue("在用", " 在用 ")).toBe(true);
    expect(samePropertyValue(371, "371")).toBe(true);
    expect(samePropertyValue("在用", "停用")).toBe(false);
  });
});
