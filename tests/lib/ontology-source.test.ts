import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { validateEntitySources } from "@/lib/ontology/sources";

const entityId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const otherSourceId = "33333333-3333-4333-8333-333333333333";

describe("类的数据来源绑定", () => {
  it("一个类挂多份来源时，来源、连接键与属性映射都能原样存下来", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "客户",
        properties: [
          { name: "名称", dataType: "TEXT", sourceField: "CUST_NAME", sourceId: "primary" },
          { name: "信用分", dataType: "INTEGER", sourceField: "SCORE", sourceId: "credit" },
          { name: "编号", dataType: "TEXT" },
        ],
        sources: [
          { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" },
          { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID", "AREA_CODE"], titleField: "" },
        ],
      }],
      relationshipTypes: [],
      actionTypes: [],
      rules: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([
      { id: "primary", dataSourceId: sourceId, kind: "PHYSICAL", sql: "", schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID", "AREA_CODE"], titleField: "CUST_NAME" },
      { id: "credit", dataSourceId: otherSourceId, kind: "PHYSICAL", sql: "", schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID", "AREA_CODE"], titleField: "" },
    ]);
    expect(parsed.entityTypes[0].properties[0]).toMatchObject({ sourceField: "CUST_NAME", sourceId: "primary" });
    expect(parsed.entityTypes[0].properties[1]).toMatchObject({ sourceField: "SCORE", sourceId: "credit" });
    expect(parsed.entityTypes[0].properties[2].sourceField).toBeUndefined();
  });

  it("加多来源之前存下来的单来源草稿，读出来就是主来源", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "客户",
        properties: [{ name: "名称", dataType: "TEXT", sourceField: "CUST_NAME" }],
        source: { dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "CUST_NAME" },
      }],
      relationshipTypes: [],
      actionTypes: [],
      rules: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([
      { id: "primary", dataSourceId: sourceId, kind: "PHYSICAL", sql: "", schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "CUST_NAME" },
    ]);
  });

  it("没接过来源的草稿读出来是空清单，不会报错", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{ id: entityId, name: "客户", properties: [] }],
      relationshipTypes: [],
    });
    expect(parsed.entityTypes[0].sources).toEqual([]);
  });
});

describe("属性的取值枚举（码值）", () => {
  it("属性可以声明取值枚举；不写时是空数组（老快照读出来也是空）", () => {
    const parsed = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: entityId,
        name: "全量用户标签",
        properties: [
          { name: "U_TYPE", dataType: "TEXT", enumValues: [{ value: "1", label: "全球通" }, { value: "0", label: "非全球通" }] },
          { name: "别的", dataType: "TEXT" },
        ],
      }],
      relationshipTypes: [],
    });
    expect(parsed.entityTypes[0].properties[0].enumValues).toEqual([{ value: "1", label: "全球通" }, { value: "0", label: "非全球通" }]);
    // 没声明枚举就是缺省态：老快照读出来也是 undefined（与 sourceField 同一读法）。
    expect(parsed.entityTypes[0].properties[1].enumValues).toBeUndefined();
  });
});

describe("来源绑定的自检", () => {
  const primary = { id: "primary", kind: "PHYSICAL" as const, sql: "", dataSourceId: sourceId, schema: "GISTOOLS", view: "TB_CUSTOMER", primaryKey: ["ID"], titleField: "" };

  it("还没配完只提示，不拦发布", () => {
    const issues = validateEntitySources({ name: "客户", sources: [{ ...primary, view: "", primaryKey: [] }], properties: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("WARN");
  });

  it("主来源选了表却没绑数据资源（导入后没补齐绑定）：本机有可绑资源时明确提示", () => {
    const scope = { name: "客户", sources: [{ ...primary, dataSourceId: "" }], properties: [] };
    const hit = validateEntitySources(scope, { knownSourceIds: [sourceId] }).find((issue) => issue.message.includes("数据资源"));
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("WARN");
    expect(hit!.message).toContain("补齐");
    // 一个资源都没登记时不报：没得补，导入那一步已经提醒过（技能示例包导入到空平台就是这种）。
    expect(validateEntitySources(scope, { knownSourceIds: [] })).toEqual([]);
  });

  it("补充来源没填连接键时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [primary, { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: [""], titleField: "" }],
      properties: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBeUndefined();
    expect(issues[0].message).toContain("连接键");
  });

  it("连接键列数和主键对不上时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [
        { ...primary, primaryKey: ["ID", "AREA_CODE"] },
        { id: "credit", dataSourceId: otherSourceId, schema: "GISTOOLS", view: "TB_CREDIT", primaryKey: ["CUST_ID"], titleField: "" },
      ],
      properties: [],
    });
    expect(issues.some((issue) => issue.message.includes("两边要对齐"))).toBe(true);
  });

  it("属性指向一份已经不存在的来源时拦住发布", () => {
    const issues = validateEntitySources({
      name: "客户",
      sources: [primary],
      properties: [{ name: "信用分", sourceField: "SCORE", sourceId: "gone" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("信用分");
  });
});

describe("取数口径（DERIVED 来源）的发布前检查", () => {
  const derived = {
    id: "primary",
    kind: "DERIVED" as const,
    sql: "SELECT id, name FROM t_customer",
    dataSourceId: sourceId,
    schema: "",
    view: "",
    primaryKey: ["id"],
    titleField: "",
  };

  it("合法的口径不报问题（口径是来源，不再要求有表名）", () => {
    expect(validateEntitySources({ name: "客户", sources: [derived], properties: [] })).toEqual([]);
  });

  it("口径空着 / 写操作 / 没选数据资源：都挡住发布", () => {
    const empty = validateEntitySources({ name: "客户", sources: [{ ...derived, sql: "   " }], properties: [] });
    expect(empty.some((issue) => issue.message.includes("口径是空的"))).toBe(true);

    const write = validateEntitySources({ name: "客户", sources: [{ ...derived, sql: "DELETE FROM t_customer" }], properties: [] });
    const hit = write.find((issue) => issue.message.includes("只读"));
    expect(hit).toBeDefined();
    // 写语句是**挡住发布**，不是提示：放过去就是一个执行不了的来源。
    expect(hit!.severity).toBeUndefined();
    expect(hit!.message).toContain("只读");

    const noSource = validateEntitySources({ name: "客户", sources: [{ ...derived, dataSourceId: "" }], properties: [] });
    expect(noSource.some((issue) => issue.message.includes("在哪个数据资源上执行"))).toBe(true);
  });

  it("口径没配主键：只提示不拦（建模中途允许先搭结构）", () => {
    const issues = validateEntitySources({ name: "客户", sources: [{ ...derived, primaryKey: [] }], properties: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("WARN");
  });

  it("补充来源用口径：明确说不支持，别静默当表用", () => {
    const issues = validateEntitySources({ name: "客户", sources: [derived, { ...derived, id: "second" }], properties: [] });
    expect(issues.some((issue) => issue.message.includes("补充来源暂时只支持"))).toBe(true);
  });
});
