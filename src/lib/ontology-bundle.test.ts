import { describe, expect, it } from "vitest";
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, buildOntologyBundle, bundleFileName, parseOntologyBundle, planBundleImport, readOntologyBundle, type LocalSourceRef } from "@/lib/ontology-bundle";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const PLACES = "33333333-3333-4333-8333-333333333333";
const ACTION = "44444444-4444-4444-8444-444444444444";
const RULE = "55555555-5555-4555-8555-555555555555";
const DATA_SOURCE = "66666666-6666-4666-8666-666666666666";

function definition(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: CUSTOMER,
        name: "客户",
        displayProperty: "名称",
        properties: [{ name: "名称", dataType: "TEXT" }],
        sources: [{ id: "primary", dataSourceId: DATA_SOURCE, schema: "GISTOOLS", view: "TB_CUST", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" }],
      },
      { id: ORDER, name: "订单", displayProperty: "编号", properties: [{ name: "编号", dataType: "TEXT" }] },
    ],
    relationshipTypes: [{ id: PLACES, name: "下单", sourceEntityTypeId: CUSTOMER, targetEntityTypeId: ORDER }],
    actionTypes: [{
      id: ACTION,
      name: "改名称",
      code: "rename",
      scopeEntityTypeId: CUSTOMER,
      params: [{ code: "newName", name: "新名称", kind: "VALUE", dataType: "TEXT" }],
      edits: [{ op: "SET_PROPERTY", entityTypeId: CUSTOMER, assignments: [{ property: "名称", value: { kind: "PARAM", code: "newName" } }] }],
    }],
    rules: [{
      id: RULE,
      name: "有订单不能改名",
      effect: "BLOCK",
      actionId: ACTION,
      conditions: [{ subject: { kind: "SUBJECT", relationshipTypeId: PLACES, direction: "OUT" }, property: "编号", operator: "IS_EMPTY" }],
    }],
  });
}

const LOCAL_SOURCE = "77777777-7777-4777-8777-777777777777";
const localSource: LocalSourceRef = { id: LOCAL_SOURCE, kind: "ORACLE", host: "39.164.136.34", port: 1251, database_name: "orcl", schema_name: "GISTOOLS" };

function bundle() {
  return buildOntologyBundle({
    ontology: { identifier: "telecom-order", name: "客户账务订购", description: "示例", tags: ["客户", "订购"] },
    definition: definition(),
    dataSources: [{ id: DATA_SOURCE, name: "GISTOOLS", kind: "ORACLE", host: "39.164.136.34", port: 1251, database_name: "orcl", schema_name: "GISTOOLS" }],
    instances: { objects: 3, relationships: 1 },
    exportedAt: "2026-09-14T00:00:00.000Z",
  });
}

/** 顺序发号，测试里才能断言具体 id。 */
function counter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`;
}

describe("本体包导出", () => {
  it("装的是一个自描述的单文件：信封 + 统计 + 数据资源坐标 + 原样定义", () => {
    const output = bundle();
    expect(output.format).toBe(BUNDLE_FORMAT);
    expect(output.formatVersion).toBe(BUNDLE_FORMAT_VERSION);
    expect(output.exportedAt).toBe("2026-09-14T00:00:00.000Z");
    expect(output.ontology).toEqual({ identifier: "telecom-order", name: "客户账务订购", description: "示例", color: "", tags: ["客户", "订购"] });
    expect(output.statistics).toEqual({ objectTypes: 2, relationTypes: 1, actionTypes: 1, rules: 1, objects: 3, relationships: 1 });
    // 定义原样进出，不做形状转换。
    expect(output.definition).toEqual(definition());
  });

  it("数据资源只记连接坐标，绝不带凭据", () => {
    const [source] = bundle().dataSources;
    expect(source).toEqual({ id: DATA_SOURCE, name: "GISTOOLS", kind: "ORACLE", host: "39.164.136.34", port: 1251, databaseName: "orcl", schemaName: "GISTOOLS" });
    expect(JSON.stringify(bundle())).not.toMatch(/password|credential|secret/i);
  });

  it("定义引用了本机已删掉的数据资源时，写一条只有 id 的占位，包仍然合法", () => {
    const output = buildOntologyBundle({ ontology: { identifier: "x", name: "X" }, definition: definition(), dataSources: [] });
    expect(output.dataSources).toEqual([{ id: DATA_SOURCE, name: "", kind: "", host: "", databaseName: "", schemaName: "" }]);
    // 关键：这样的包还能被读回来（否则会把导出端删过的资源变成一张读不了的废纸）。
    expect(() => readOntologyBundle(output)).not.toThrow();
  });

  it("文件名用标识，中文名也能落成可读的名字", () => {
    expect(bundleFileName({ identifier: "telecom-order", name: "客户账务订购" })).toBe("telecom-order.ontology.json");
    expect(bundleFileName({ name: "客户账务订购" })).toBe("客户账务订购.ontology.json");
    expect(bundleFileName({ name: "" })).toBe("ontology.ontology.json");
  });
});

describe("本体包导入", () => {
  it("文本先过 JSON 与格式校验，报错都是人话", () => {
    expect(() => parseOntologyBundle("")).toThrow("文件是空的");
    expect(() => parseOntologyBundle("{oops")).toThrow("不是合法 JSON");
    expect(() => parseOntologyBundle(JSON.stringify({ format: "something.else" }))).toThrow("这不是本体包");
    expect(() => parseOntologyBundle(JSON.stringify({ format: BUNDLE_FORMAT, formatVersion: 99 }))).toThrow("更新版本导出的");
  });

  it("定义缺字段时说清楚是哪个字段", () => {
    const broken = { ...bundle(), definition: { entityTypes: [{ name: "缺 id" }], relationshipTypes: [] } };
    expect(() => readOntologyBundle(broken)).toThrow(/字段/);
  });

  it("导入时全部 id 换新，且引用跟着换（实现接口、关系端点、动作作用域、规则条件）", () => {
    const plan = planBundleImport(bundle(), [localSource], counter());
    const [customer, order] = plan.definition.entityTypes;
    const [places] = plan.definition.relationshipTypes;
    const [action] = plan.definition.actionTypes;
    const [rule] = plan.definition.rules;

    // 新号与原号不同
    expect(customer.id).not.toBe(CUSTOMER);
    expect(new Set(plan.definition.entityTypes.map((item) => item.id)).size).toBe(2);

    // 引用必须指向新号，不能残留原号
    expect(places.sourceEntityTypeId).toBe(customer.id);
    expect(places.targetEntityTypeId).toBe(order.id);
    expect(action.scopeEntityTypeId).toBe(customer.id);
    expect(action.edits[0].entityTypeId).toBe(customer.id);
    expect(rule.actionId).toBe(action.id);
    expect(rule.conditions[0].subject.relationshipTypeId).toBe(places.id);

    const serialized = JSON.stringify(plan.definition);
    for (const old of [CUSTOMER, ORDER, PLACES, ACTION, RULE]) expect(serialized).not.toContain(old);
  });

  it("来源绑定按连接坐标接回本机资源（不看导出端的 id）", () => {
    const plan = planBundleImport(bundle(), [localSource], counter());
    expect(plan.definition.entityTypes[0].sources[0].dataSourceId).toBe(LOCAL_SOURCE);
    expect(plan.warnings).toEqual([]);
  });

  it("坐标对不上时把绑定留空并说明是哪个类，而不是静默丢绑定", () => {
    const other: LocalSourceRef = { ...localSource, id: "other", database_name: "another" };
    const plan = planBundleImport(bundle(), [other], counter());
    expect(plan.definition.entityTypes[0].sources[0].dataSourceId).toBe("");
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("没有登记");
    expect(plan.warnings[0]).toContain("客户");
    // 表名等其余绑定信息不丢，只把"接哪台机器"清空
    expect(plan.definition.entityTypes[0].sources[0].view).toBe("TB_CUST");
  });

  it("模式不一致时放宽匹配，但要给出提醒", () => {
    const plan = planBundleImport(bundle(), [{ ...localSource, schema_name: "OTHER" }], counter());
    expect(plan.definition.entityTypes[0].sources[0].dataSourceId).toBe(LOCAL_SOURCE);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("模式不一致");
  });

  it("重映射后的定义仍然能通过本体定义校验", () => {
    const plan = planBundleImport(bundle(), [localSource], counter());
    expect(ontologyDefinitionSchema.safeParse(plan.definition).success).toBe(true);
  });

  it("往返一次（导出 → 读回 → 换号）不改变结构本身", () => {
    const original = definition();
    const plan = planBundleImport(parseOntologyBundle(JSON.stringify(bundle())), [localSource], counter());
    const strip = (value: OntologyDefinition) => ({
      names: value.entityTypes.map((item) => item.name),
      properties: value.entityTypes.map((item) => item.properties.map((prop) => prop.name)),
      relationNames: value.relationshipTypes.map((item) => item.name),
      actionNames: value.actionTypes.map((item) => item.name),
      ruleNames: value.rules.map((item) => item.name),
      views: value.entityTypes.map((item) => item.sources.map((source) => source.view)),
      counts: [value.entityTypes.length, value.relationshipTypes.length, value.actionTypes.length, value.rules.length],
    });
    expect(strip(plan.definition)).toEqual(strip(original));
  });
});