import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { applySourceBindings, brokenSourcesOf, matchSourceCandidates, planSourceBindings, unboundSourcesOf, type SourceHint } from "@/lib/source-binding";

const TYPE_ID = "11111111-1111-4111-8111-111111111111";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [
    {
      id: TYPE_ID,
      name: "集团客户",
      properties: [{ name: "CUST_ID", dataType: "TEXT", sourceField: "CUST_ID" }],
      sources: [
        { id: "primary", dataSourceId: "", schema: "GISTOOLS", view: "TB_MK_GRP_SERV_LEVEL_DAY", primaryKey: ["CUST_ID"] },
        { id: "bound", dataSourceId: "f1000000-0000-4000-8000-000000000001", schema: "GISTOOLS", view: "TB_OTHER", primaryKey: ["CUST_ID"] },
      ],
    },
  ],
  relationshipTypes: [],
});

const oracle: SourceHint = {
  id: "a1000000-0000-4000-8000-000000000001",
  name: "oracle-test",
  kind: "ORACLE",
  schema: "GISTOOLS",
  objects: [{ schema: "GISTOOLS", name: "TB_MK_GRP_SERV_LEVEL_DAY" }],
};

describe("unboundSourcesOf", () => {
  it("只挑「有表名、没资源」的来源，已绑定的不算", () => {
    const unbound = unboundSourcesOf(definition);
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toMatchObject({ entityTypeName: "集团客户", sourceId: "primary", label: "GISTOOLS.TB_MK_GRP_SERV_LEVEL_DAY" });
  });
});

describe("matchSourceCandidates", () => {
  it("表清单里唯一命中 -> 直接自动绑", () => {
    const [unbound] = unboundSourcesOf(definition);
    const result = matchSourceCandidates(unbound, [oracle]);
    expect(result.exact).toEqual([oracle.id]);
    expect(result.autoBind).toBe(oracle.id);
  });

  it("表清单命中多个 -> 不猜，交给界面选", () => {
    const [unbound] = unboundSourcesOf(definition);
    const other: SourceHint = { ...oracle, id: "a1000000-0000-4000-8000-000000000002", name: "oracle-backup" };
    const result = matchSourceCandidates(unbound, [oracle, other]);
    expect(result.exact).toHaveLength(2);
    expect(result.autoBind).toBe("");
  });

  it("表清单里都没有、模式唯一命中 -> 弱匹配自动绑", () => {
    const [unbound] = unboundSourcesOf(definition);
    const blind: SourceHint = { ...oracle, objects: [] };
    const result = matchSourceCandidates(unbound, [blind]);
    expect(result.exact).toEqual([]);
    expect(result.schemaOnly).toEqual([blind.id]);
    expect(result.autoBind).toBe(blind.id);
  });

  it("表清单没命中、模式也撞多个 -> 留空", () => {
    const [unbound] = unboundSourcesOf(definition);
    const blindA: SourceHint = { ...oracle, objects: [], id: "a1000000-0000-4000-8000-000000000003" };
    const blindB: SourceHint = { ...oracle, objects: [], id: "a1000000-0000-4000-8000-000000000004" };
    expect(matchSourceCandidates(unbound, [blindA, blindB]).autoBind).toBe("");
  });
});

describe("planSourceBindings / applySourceBindings", () => {
  it("brokenSourcesOf 把「指向已删资源的悬空引用」也算成待补：换过平台库的本体不能再假装绑好了", () => {
    const known = [oracle.id];
    const broken = brokenSourcesOf(definition, known);
    // 没绑的（primary）+ 绑到 f1… 这个本机不存在资源的（bound），两条都要出现。
    expect(broken.map((item) => item.sourceId)).toEqual(["primary", "bound"]);
    // 资源真的在本机时就不再报它。
    expect(brokenSourcesOf(definition, [...known, "f1000000-0000-4000-8000-000000000001"]).map((item) => item.sourceId)).toEqual(["primary"]);
  });

  it("自动绑的进 bindings，不确定的进 pending", () => {
    const plan = planSourceBindings(definition, [oracle]);
    expect(plan.bindings.get(`${TYPE_ID}/primary`)).toBe(oracle.id);
    expect(plan.pending).toHaveLength(0);
  });

  it("写回定义只动目标来源，别的来源原样保留", () => {
    const next = applySourceBindings(definition, new Map([[`${TYPE_ID}/primary`, oracle.id]]));
    expect(next.entityTypes[0].sources[0].dataSourceId).toBe(oracle.id);
    expect(next.entityTypes[0].sources[1].dataSourceId).toBe("f1000000-0000-4000-8000-000000000001");
    // 原定义不被改动（纯函数）。
    expect(definition.entityTypes[0].sources[0].dataSourceId).toBe("");
  });
});
