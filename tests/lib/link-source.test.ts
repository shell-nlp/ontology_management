import { describe, expect, it } from "vitest";
import { linkSourceViolations, normalizeLinkSource, planLinkSource, type LinkSourceDefinition } from "@/lib/ontology/link-source";
import { linkSeedFilters } from "@/lib/instance/object-service/links";
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

  it("外键式零配置：不选数据资源也能排出计划（外键端、表、来源全按键映射与对象类型主来源推出来）", () => {
    // 起点映射自己的主键（客户）→ 它是被引用端；终点映射的是非主键属性 customer_ref（外键）→ 它是外键所在端。
    const def = definition({
      sourceKeyMappings: [{ entityProperty: "customer_id" }],
      targetKeyMappings: [{ entityProperty: "customer_ref" }],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("FOREIGN_KEY");
    expect(plan.keyHolder).toBe("TARGET");
    expect(plan.dataSourceId).toBe(DS_ID);
    expect(plan.table).toEqual({ schema: "GISTOOLS", name: "TB_ACCT" });
    expect(linkSourceViolations(def)).toHaveLength(0);
  });

  /**
   * 起始端是**只有定义、没绑来源**的抽象类型（`用户`）：身份只能靠属性层（`user_id` 标着「必填 + 唯一」）。
   * 这正是 V5 的形态 —— 用户/客户/字典这些抽象类型没有表，实例散在按 USER_ID 建的各类明细表里。
   */
  function abstractDefinition(opts: { foreignKeySide: "SOURCE" | "TARGET" }): LinkSourceDefinition {
    return ontologyDefinitionSchema.parse({
      entityTypes: [
        {
          id: SOURCE_ID,
          name: "用户",
          properties: [
            { name: "user_id", dataType: "TEXT", required: true, primaryKey: true, description: "用户实例的唯一标识。" },
            { name: "customer_id", dataType: "TEXT" },
          ],
          sources: [],
        },
        {
          id: TARGET_ID,
          name: "专线产品用户",
          properties: [{ name: "USER_ID", dataType: "TEXT", sourceField: "USER_ID", required: true, primaryKey: true }],
          sources: [{ id: "primary", dataSourceId: DS_ID, schema: "GISTOOLS", view: "TB_MK_GRP_LINE_LIST_DAY", primaryKey: ["USER_ID"] }],
        },
      ],
      relationshipTypes: [
        {
          id: "33333333-3333-4333-8333-333333333331",
          name: "用户包含集团专线产品用户",
          sourceEntityTypeId: SOURCE_ID,
          targetEntityTypeId: TARGET_ID,
          sourceKeyMappings: [{ entityProperty: "user_id" }],
          targetKeyMappings: [{ entityProperty: "USER_ID" }],
          linkSource: { mode: "FOREIGN_KEY", foreignKeySide: opts.foreignKeySide },
        },
      ],
    }) as unknown as LinkSourceDefinition;
  }

  it("抽象类型当被引用端：按属性层主键认身份，外键端有表就能排出计划", () => {
    const def = abstractDefinition({ foreignKeySide: "TARGET" });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.mode !== "FOREIGN_KEY") throw new Error("应该是外键式");
    expect(plan.keyHolder).toBe("TARGET");
    expect(plan.table).toEqual({ schema: "GISTOOLS", name: "TB_MK_GRP_LINE_LIST_DAY" });
    expect(plan.holder).toMatchObject({ entityTypeName: "专线产品用户", keyColumns: ["USER_ID"] });
    // 被引用端只有属性定义：它的"列"就是属性名（对象身份在属性层也是按它算的）。
    expect(plan.foreignKeys.rowColumns).toEqual(["USER_ID"]);
    expect(plan.foreignKeys.keyColumns).toEqual(["user_id"]);
  });

  it("两端填的都是各自主键、又没选连接表：提示直接点破\"共用一个键值\"该怎么改", () => {
    const def = definition({
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "customer_id" }],
      targetKeyMappings: [{ linkProperty: "ACCT_ID", entityProperty: "account_id" }],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    const reason = plan.ok === false ? plan.reason : "";
    expect(reason).toContain("两端填的都是各自主键");
    expect(reason).toContain("共用一个键值");
    expect(reason).not.toBe("关系类型「客户拥有账户」还没选数据资源。");
  });

  it("抽象类型当外键所在端：说清是\"没绑数据来源\"，不再误报成非主键列", () => {
    const def = abstractDefinition({ foreignKeySide: "SOURCE" });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("还没绑数据来源");
  });

  it("抽象类型的键映射指向没标注主键的属性：提示写成\"没绑数据来源 + 只有属性定义\"", () => {
    const def = abstractDefinition({ foreignKeySide: "TARGET" });
    const relation = def.relationshipTypes[0];
    relation.sourceKeyMappings = [{ entityProperty: "customer_id" }];
    const plan = planLinkSource(def, relation);
    expect(plan.ok).toBe(false);
    const reason = plan.ok === false ? plan.reason : "";
    expect(reason).toContain("还没绑数据来源");
    expect(reason).toContain("user_id");
    expect(reason).not.toContain("非主键列");
  });

  it("外键式判断不出哪一端（两侧都映射自己的主键）-> 明确让人指定，不瞎猜", () => {
    const def = definition({
      sourceKeyMappings: [{ entityProperty: "customer_id" }],
      targetKeyMappings: [{ entityProperty: "account_id" }],
    });
    const plan = planLinkSource(def, def.relationshipTypes[0]);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain("判断不出外键长在哪一端");
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
    expect(normalizeLinkSource(undefined)).toEqual({ mode: "JOIN_TABLE", dataSourceId: "", schema: "", view: "", foreignKeySide: "AUTO" });
  });
});
