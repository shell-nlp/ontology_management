import { describe, expect, it } from "vitest";
import { PROFILE_MAX_VALUES, PROFILE_TTL_MS, columnValueOf, mappedColumnsFor, profileFromRows, profileIsFresh, profileTableKey } from "@/lib/column-profile";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 列画像的成本红线（用户口径：Oracle 大表 COUNT(DISTINCT) 很贵）：
 * 只对被对象类型绑定的表做、只采样不精确统计、按天缓存。
 * 这里钉住的是"怎么算"那部分纯逻辑，采样与缓存读写靠 `ensureColumnProfile`（要连库，不在单测里跑）。
 */

const 资源id = "99999999-9999-4999-8999-999999999999";
const 线路类 = "11111111-1111-4111-8111-111111111111";

function definition(): OntologyDefinition {
  return {
    entityTypes: [
      {
        id: 线路类,
        name: "专线产品用户",
        description: "",
        displayProperty: "",
        groupId: "",
        implements: [],
        properties: [
          { name: "专线类型", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "ZX_FLAG" },
          { name: "客户标识", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "CUST_ID" },
          { name: "没映射的属性", dataType: "TEXT", required: false, unique: false, indexed: false },
        ],
        sources: [{ id: "primary", dataSourceId: 资源id, schema: "GISTOOLS", view: "TB_MK_GRP_LINE_LIST_DAY", primaryKey: ["CUST_ID"], titleField: "" }],
      },
    ],
    groups: [],
    interfaces: [],
    metrics: [],
    relationshipTypes: [],
    actionTypes: [],
    rules: [],
  } as unknown as OntologyDefinition;
}

describe("profileTableKey / columnValueOf", () => {
  it("表键统一大写：Oracle 报大写、模型写小写都要能对上", () => {
    expect(profileTableKey("gistools", "tb_mk_grp_line_list_day")).toBe("GISTOOLS.TB_MK_GRP_LINE_LIST_DAY");
    const index = new Map([[profileTableKey("GISTOOLS", "TB_X"), new Map([["ZX_FLAG", ["1", "2"]]])]]);
    // 查的时候大小写不敏感，列名同理
    expect(columnValueOf(index, "gistools", "tb_x", "zx_flag")).toEqual(["1", "2"]);
    expect(columnValueOf(index, "GISTOOLS", "TB_Y", "ZX_FLAG")).toEqual([]);
  });
});

describe("profileFromRows（采样结果的算法）", () => {
  it("低基数列给取值清单（按出现次数降序），并算出空值比例", () => {
    const rows = [{ ZX_FLAG: "2" }, { ZX_FLAG: "2" }, { ZX_FLAG: "1" }, { ZX_FLAG: null }];
    const [column] = profileFromRows(rows, ["ZX_FLAG"]);
    expect(column).toMatchObject({ name: "ZX_FLAG", distinct: 2, highCardinality: false });
    expect(column.values).toEqual(["2", "1"]);
    expect(column.nullRate).toBeCloseTo(0.25);
  });

  it("列名大小写不敏感（Oracle 回的是大写，请求的是属性里写的那种写法）", () => {
    const [column] = profileFromRows([{ ZX_FLAG: "2" }], ["zx_flag"]);
    expect(column.values).toEqual(["2"]);
  });

  it("取值种数超过阈值就按高基数列处理：只留种数，不存取值（别把画像做成一张数据表）", () => {
    const rows = Array.from({ length: PROFILE_MAX_VALUES + 5 }, (_, i) => ({ CUST_ID: `C${i}` }));
    const [column] = profileFromRows(rows, ["CUST_ID"]);
    expect(column.highCardinality).toBe(true);
    expect(column.distinct).toBe(PROFILE_MAX_VALUES + 5);
    expect(column.values).toEqual([]);
  });

  it("超长文本截到 80 字符，不会把一行备注当成一个码值塞满画像", () => {
    const long = "长".repeat(200);
    const [column] = profileFromRows([{ NOTE: long }], ["NOTE"]);
    expect(column.values[0].length).toBeLessThan(100);
    expect(column.values[0].endsWith("…")).toBe(true);
  });
});

describe("mappedColumnsFor（只对绑定表、只对被映射的列做画像）", () => {
  it("给出这张表上被对象类型映射到的列，去重且忽略大小写", () => {
    expect(mappedColumnsFor(definition(), 资源id, "GISTOOLS", "TB_MK_GRP_LINE_LIST_DAY").sort()).toEqual(["CUST_ID", "ZX_FLAG"]);
    expect(mappedColumnsFor(definition(), 资源id, "gistools", "tb_mk_grp_line_list_day").sort()).toEqual(["CUST_ID", "ZX_FLAG"]);
  });

  it("没被任何对象类型绑定的表（或别的数据资源）返回空：调用方据此跳过采样", () => {
    expect(mappedColumnsFor(definition(), 资源id, "GISTOOLS", "TB_OTHER")).toEqual([]);
    expect(mappedColumnsFor(definition(), "00000000-0000-4000-8000-000000000000", "GISTOOLS", "TB_MK_GRP_LINE_LIST_DAY")).toEqual([]);
  });
});

describe("profileIsFresh（按天缓存）", () => {
  const base = { sourceId: 资源id, schema: "GISTOOLS", table: "TB_X", sampleSize: 1, columns: [] };
  it("一天之内算新鲜，超过一天算过期", () => {
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    expect(profileIsFresh({ ...base, sampledAt: new Date(now - PROFILE_TTL_MS + 60_000).toISOString() }, now)).toBe(true);
    expect(profileIsFresh({ ...base, sampledAt: new Date(now - PROFILE_TTL_MS - 60_000).toISOString() }, now)).toBe(false);
    // 时间戳坏了当成过期：宁可重采一次，也别拿一份读数不明的画像用。
    expect(profileIsFresh({ ...base, sampledAt: "not-a-date" }, now)).toBe(false);
  });
});
