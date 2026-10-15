import { describe, expect, it } from "vitest";
import { metricSchema, ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { metricViolations } from "@/lib/ontology/metrics";
import { compileQuerySql, parseQueryDsl, resolveQueryDsl } from "@/lib/query-dsl";

/**
 * 指标的正文 = **关联（多个对象类型）+ 计算（可空）**（2026-10-15 用户设计）。
 *
 * 两条口径在这里钉死：
 * 1. 关联 ≠ 能算：关联决定它出现在哪些类型的上下文里；**能不能出数只看计算口径**；
 * 2. 不配计算口径 = 只描述：合法形态，模型能讲清它是什么，但**不能出数**（放模型去猜口径
 *    正是指标要消灭的东西）。所以查询层直接报错，不是"提示一下"。
 */
const 专线类 = "22222222-2222-4222-8222-222222222222";
const 客户类 = "33333333-3333-4333-8333-333333333333";
const 数据资源 = "99999999-9999-4999-8999-999999999999";
const 指标id = "66666666-6666-4666-8666-666666666666";

function 定义(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: 专线类, name: "专线产品用户", displayProperty: "地市编码",
        properties: [
          { name: "统计日期", dataType: "DATE", sourceField: "STATIS_DATE" },
          { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
          { name: "条数", dataType: "INTEGER", sourceField: "ZX_COUNT" },
        ],
        sources: [{ id: "primary", dataSourceId: 数据资源, schema: "GISTOOLS", view: "TB_MK_GRP_LINE_LIST_DAY", primaryKey: ["USER_ID"], titleField: "" }],
      },
      { id: 客户类, name: "集团客户", displayProperty: "客户名", properties: [{ name: "客户名", dataType: "TEXT" }], sources: [] },
    ],
    metrics: [{
      id: 指标id,
      name: "专线条数",
      description: "专线产品用户的行数",
      // 关联两个类型，计算落在其中一个：这就是"关联 ≠ 能算"
      entityTypeIds: [专线类, 客户类],
      calculation: { entityTypeId: 专线类, aggregation: "SUM", property: "条数", filters: [], dimensions: ["地市编码"], timeProperty: "统计日期" },
      unit: "条",
      status: "draft",
    }],
  });
}

const 查 = (select: unknown, groupBy?: unknown) => parseQueryDsl({
  version: "1.0",
  kind: "aggregate",
  from: { object_type: "专线产品用户" },
  select,
  ...(groupBy ? { group_by: groupBy } : {}),
});

function 抓错误(run: () => unknown) {
  try {
    run();
  } catch (error) {
    return error as { code: string; message: string; hint?: string };
  }
  throw new Error("预期报错，但没报。");
}

describe("指标的形状：关联（多）+ 计算（可空）", () => {
  it("老快照的扁平字段折成新形状：entityTypeId → 关联数组 + 计算口径", () => {
    const parsed = metricSchema.parse({ id: 指标id, name: "旧口径", entityTypeId: 专线类, aggregation: "SUM", property: "条数", dimensions: ["地市编码"] });
    expect(parsed.entityTypeIds).toEqual([专线类]);
    expect(parsed.calculation).toMatchObject({ entityTypeId: 专线类, aggregation: "SUM", property: "条数", dimensions: ["地市编码"] });
  });

  it("老快照里没选类型的口径 = 只描述：关联为空、没有计算口径", () => {
    const parsed = metricSchema.parse({ id: 指标id, name: "旧口径", entityTypeId: "", aggregation: "COUNT" });
    expect(parsed.entityTypeIds).toEqual([]);
    expect(parsed.calculation).toBeNull();
  });

  it("新形状原样读：关联多个类型、计算为 null 都不丢", () => {
    const parsed = ontologyDefinitionSchema.parse({ metrics: [{ id: 指标id, name: "客户流失风险", entityTypeIds: [客户类, 专线类], calculation: null }] });
    expect(parsed.metrics[0].entityTypeIds).toEqual([客户类, 专线类]);
    expect(parsed.metrics[0].calculation).toBeNull();
  });
});

describe("指标的发布前校验", () => {
  it("只描述、没有计算口径：提醒但不拦（合法形态，但明说它出不了数）", () => {
    const def = 定义();
    def.metrics[0].calculation = null;
    const violations = metricViolations(def);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: "WARN" });
    expect(violations[0].message).toContain("不能用它出数");
  });

  it("计算落点不在关联里：挡发布", () => {
    const def = 定义();
    def.metrics[0].entityTypeIds = [客户类];
    const violations = metricViolations(def);
    const hit = violations.find((item) => item.message.includes("计算落点必须是关联类型之一"));
    expect(hit).toBeDefined();
    expect(hit!.severity).toBeUndefined();
  });

  it("写了算法但还没挑落点：只提醒（外部导入的常态），不拦发布", () => {
    const def = 定义();
    def.metrics[0].calculation = { ...def.metrics[0].calculation!, entityTypeId: "" };
    const violations = metricViolations(def);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ severity: "WARN" });
    expect(violations[0].message).toContain("还没选落在哪个对象类型上");
  });
});

describe("查询：关联 ≠ 能算", () => {
  it("只描述的指标不能出数：报 METRIC_NOT_CALCULABLE，并给两条出路", () => {
    const def = 定义();
    def.metrics[0].calculation = null;
    const error = 抓错误(() => resolveQueryDsl(def, 查([{ metric: "专线条数", as: "条数" }])));
    expect(error.code).toBe("METRIC_NOT_CALCULABLE");
    expect(error.message).toContain("只有描述、没有配置怎么算");
    expect(error.hint).toContain("本体建模 → 指标");
    expect(error.hint).toContain("未引用已定义指标");
  });

  it("关联了、但计算口径配在别的类型上：告诉模型该从哪个类型出数", () => {
    const def = 定义();
    def.metrics[0].calculation = { ...def.metrics[0].calculation!, entityTypeId: 客户类, property: "" };
    const error = 抓错误(() => resolveQueryDsl(def, 查([{ metric: "专线条数", as: "条数" }])));
    expect(error.code).toBe("METRIC_NOT_CALCULABLE_HERE");
    expect(error.hint).toContain("SELECT 专线条数 FROM 集团客户");
  });

  it("时间维度自动算一个可用维度：按它分组不再被拒", () => {
    const def = 定义();
    const compiled = compileQuerySql(resolveQueryDsl(def, 查([{ field: { property: "统计日期" }, as: "统计日期" }, { metric: "专线条数", as: "条数" }], [{ property: "统计日期" }])), "ORACLE");
    expect(compiled.statement).toContain("STATIS_DATE");
  });

  it("没勾进可用维度的属性：报错时把可用维度列出来（并带上时间维度）", () => {
    const def = 定义();
    const error = 抓错误(() => resolveQueryDsl(def, 查([{ field: { property: "条数" }, as: "条数" }, { metric: "专线条数", as: "合计" }], [{ property: "条数" }])));
    expect(error.code).toBe("METRIC_DIMENSION_MISMATCH");
    expect(error.hint).toContain("地市编码");
    expect(error.hint).toContain("统计日期");
  });
});