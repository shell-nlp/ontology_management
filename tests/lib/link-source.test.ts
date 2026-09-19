import { describe, expect, it } from "vitest";
import { linkSourceViolations, normalizeLinkSource, planLinkSource, type LinkSourceDefinition } from "@/lib/link-source";
import { linkSeedFilters } from "@/lib/object-service/links";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const DS_ID = "a1000000-0000-4000-8000-000000000001";

/** 两端都有主键、都绑了表的最小定义；键映射按需要往两边加。 */
function definition(overrides: Partial<Record<"sourceKeyMappings" | "targetKeyMappings" | "linkSource", unknown>> = {}): LinkSourceDefinition {
  const parsed = ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: SOURCE_ID,
        name: "客户",
        properties: [
          { name: "customer_id", dataType: "TEXT", sourceField: "CUST_ID" },
          { name: "customer_name", dataType: "TEXT", sourceField: "CUST_NAME" },
        ],
        sources: [{ id: "primary", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_CUST", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" }],
      },
      {
        id: TARGET_ID,
        name: "账户",
        properties: [
          { name: "account_id", dataType: "TEXT", sourceField: "ACCT_ID" },
          { name: "customer_ref", dataType: "TEXT", sourceField: "CUST_ID" },
        ],
        sources: [{ id: "primary", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_ACCT", primaryKey: ["ACCT_ID"], titleField: "ACCT_ID" }],
      },
    ],
    relationshipTypes: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "客户拥有账户",
        sourceEntityTypeId: SOURCE_ID,
        targetEntityTypeId: TARGET_ID,
        sourceKeyMappings: [],
        targetKeyMappings: [],
        ...overrides,
      },
    ],
  });
  return parsed as unknown as LinkSourceDefinition;
}

describe("planLinkSource", () => {
  it("没配数据资源 -> 明确说没配，不报错", () => {
    const plan = planLinkSource(definition(), definition().relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("还没选数据资源");
  });

  it("连接表式：键映射两侧都要覆盖主键列，列对不上就说清缺哪一列", () => {
    const def = definition({
      linkSource: { mode: "JOIN_TABLE", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_CUST_ACCT" },
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "customer_id" }],
      targetKeyMappings: [],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("终止端");
    expect(plan.ok === false && plan.reason).toContain("主键列");
  });

  it("连接表式：把属性和列都换成真实列名，取数清单去重", () => {
    const def = definition({
      linkSource: { mode: "JOIN_TABLE", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_CUST_ACCT" },
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "customer_id" }],
      targetKeyMappings: [{ linkProperty: "ACCT_ID", entityProperty: "account_id" }],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode !== "JOIN_TABLE") throw new Error("应该是连接表式");
    expect(plan.table).toEqual({ schema: "GISTOOLS", name: "TB_CUST_ACCT" });
    expect(plan.columns.sort()).toEqual(["ACCT_ID", "CUST_ID"]);
    expect(plan.source.pairs).toEqual([{ rowColumn: "CUST_ID", keyColumn: "CUST_ID" }]);
    expect(plan.target.pairs).toEqual([{ rowColumn: "ACCT_ID", keyColumn: "ACCT_ID" }]);
  });

  it("外键式：外键那一端不写连接列，表为空时用外键端对象类型的主来源表", () => {
    const def = definition({
      linkSource: { mode: "FOREIGN_KEY", dataSourceId: DS_ID, foreignKeySide: "TARGET" },
      sourceKeyMappings: [{ entityProperty: "customer_id" }],
      targetKeyMappings: [{ entityProperty: "customer_ref" }],
    });
    // 起始端（客户）是被引用端，终止端（账户）持有外键 —— 表应该取账户的主来源表。
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode !== "FOREIGN_KEY") throw new Error("应该是外键式");
    expect(plan.keyHolder).toBe("TARGET");
    expect(plan.table).toEqual({ schema: "GISTOOLS", name: "TB_ACCT" });
    expect(plan.holder).toMatchObject({ entityTypeName: "账户", keyColumns: ["ACCT_ID"] });
    expect(plan.foreignKeys.rowColumns).toEqual(["CUST_ID"]);
    expect(plan.foreignKeys.keyColumns).toEqual(["CUST_ID"]);
    expect(plan.columns.sort()).toEqual(["ACCT_ID", "CUST_ID"]);
  });

  it("外键式：外键端写了连接列 -> 直接指出这是中间表式才填的东西", () => {
    const def = definition({
      linkSource: { mode: "FOREIGN_KEY", dataSourceId: DS_ID, foreignKeySide: "TARGET" },
      sourceKeyMappings: [{ entityProperty: "customer_id" }],
      targetKeyMappings: [{ linkProperty: "ACCT_ID", entityProperty: "customer_ref" }],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("不该填连接列");
  });
});

describe("linkSeedFilters", () => {
  const def = definition({
    linkSource: { mode: "JOIN_TABLE", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_CUST_ACCT" },
    sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "customer_id" }],
    targetKeyMappings: [{ linkProperty: "ACCT_ID", entityProperty: "account_id" }],
  });
  const plan = planLinkSource(def, def.relationshipTypes[0]);

  it("单个起点 -> 等值过滤（走得了索引）", () => {
    expect(linkSeedFilters(plan, { entityType: "客户", keys: [{ CUST_ID: "1001" }] })).toEqual([{ column: "CUST_ID", operator: "EQ", value: "1001" }]);
  });

  it("一批起点 -> IN 过滤，一次查询问完，不拉整张连接表", () => {
    expect(linkSeedFilters(plan, { entityType: "客户", keys: [{ CUST_ID: "1001" }, { CUST_ID: "1002" }, { CUST_ID: "1001" }] }))
      .toEqual([{ column: "CUST_ID", operator: "IN", value: ["1001", "1002"] }]);
  });

  it("从终点侧起问 -> 过滤落在终点那一列上", () => {
    expect(linkSeedFilters(plan, { entityType: "账户", keys: [{ ACCT_ID: "A9" }] })).toEqual([{ column: "ACCT_ID", operator: "EQ", value: "A9" }]);
  });

  it("跟这条关系类型无关的对象类型 -> null，不问", () => {
    expect(linkSeedFilters(plan, { entityType: "字典", keys: [{ CODE: "1" }] })).toBeNull();
  });

  it("主键列对不上 -> null，宁可不问也不给错结果", () => {
    expect(linkSeedFilters(plan, { entityType: "客户", keys: [{ OTHER: "1" }] })).toBeNull();
  });
});

describe("linkSourceViolations", () => {
  it("没配不报；配了但取不出实例才报 WARN（不挡发布）", () => {
    expect(linkSourceViolations(definition())).toHaveLength(0);
    const def = definition({ linkSource: { mode: "JOIN_TABLE", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_CUST_ACCT" } });
    const found = linkSourceViolations(def);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "客户拥有账户.数据来源", severity: "WARN" });
  });
});

describe("normalizeLinkSource", () => {
  it("老快照没有这一项 -> 读出来是「连接表式、没配」", () => {
    expect(normalizeLinkSource(undefined)).toEqual({ mode: "JOIN_TABLE", dataSourceId: "", schema: "", view: "", foreignKeySide: "SOURCE" });
  });
});
