import { describe, expect, it } from "vitest";
import { fromBknKnowledgeNetwork, isBknKnowledgeNetwork } from "@/lib/bkn-import";
import { ontologyBundleSchema } from "@/lib/ontology-bundle";

/** 一份最小但形状完整的 bkn 知识网络：一个带表的类、一个纯建模的类、一条关系。 */
function knowledgeNetwork() {
  return {
    id: "demo_kn",
    name: "演示知识网络",
    tags: ["演示"],
    comment: "用来验证转换的最小样本。",
    color: "#0e5fc5",
    module_type: "knowledge_network",
    concept_groups: [{ id: "g1", name: "客户域", comment: "客户相关", object_type_ids: ["t1"] }],
    metrics: [{ id: "m1", name: "客户数", comment: "客户数量" }],
    object_types: [
      {
        id: "t1",
        name: "集团客户",
        comment: "集团客户主体",
        display_key: "CUST_NAME",
        primary_keys: ["CUST_ID"],
        data_source: { type: "resource", id: "r1", name: "GISTOOLS.TB_MK_GRP_SERV_LEVEL_DAY" },
        data_properties: [
          { name: "CUST_ID", display_name: "CUST_ID", type: "string", comment: "集团客户编码", mapped_field: { name: "CUST_ID" } },
          { name: "CUST_NAME", display_name: "客户名称", type: "string", comment: "集团客户名称", mapped_field: { name: "CUST_NAME" } },
          { name: "FEE_MON", display_name: "当月收入", type: "decimal", comment: "当月收入", mapped_field: { name: "FEE_MON" } },
          { name: "UNKNOWN_TYPE", display_name: "", type: "geopoint", comment: "平台不认识的类型", mapped_field: { name: "UNKNOWN_TYPE" } },
        ],
      },
      {
        id: "customer",
        name: "客户",
        comment: "社会实体",
        display_key: "customer_name",
        primary_keys: ["customer_id"],
        data_properties: [
          { name: "customer_id", display_name: "客户编号", type: "string", comment: "客户的唯一编号。" },
          { name: "customer_name", display_name: "客户名称", type: "string", comment: "客户名称。" },
        ],
      },
    ],
    relation_types: [
      {
        id: "link1",
        name: "客户包含集团客户",
        comment: "整体客户包含集团客户",
        source_object_type_id: "customer",
        target_object_type_id: "t1",
        type: "direct",
        mapping_rules: [{ source_property: { name: "customer_id" }, target_property: { name: "CUST_ID" } }],
      },
    ],
  };
}

describe("识别 bkn 知识网络", () => {
  it("看 module_type，其次看 object_types + relation_types 的形状", () => {
    expect(isBknKnowledgeNetwork(knowledgeNetwork())).toBe(true);
    expect(isBknKnowledgeNetwork({ module_type: "knowledge_network" })).toBe(true);
    expect(isBknKnowledgeNetwork({ object_types: [], relation_types: [], name: "x" })).toBe(true);
    expect(isBknKnowledgeNetwork({ format: "ontology.bundle", formatVersion: 1 })).toBe(false);
    expect(isBknKnowledgeNetwork(null)).toBe(false);
  });
});

describe("bkn → 本体包", () => {
  it("产出的是标准本体包，能过本体包的校验", () => {
    const { bundle } = fromBknKnowledgeNetwork(knowledgeNetwork());
    expect(bundle.format).toBe("ontology.bundle");
    expect(ontologyBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.ontology).toEqual({ identifier: "demo_kn", name: "演示知识网络", description: "用来验证转换的最小样本。", color: "#0e5fc5", tags: ["演示"] });
  });

  it("属性能搬的都搬：类型、显示名、说明、主键", () => {
    const { bundle } = fromBknKnowledgeNetwork(knowledgeNetwork());
    const group = bundle.definition.entityTypes.find((item) => item.name === "集团客户")!;
    expect(group.description).toBe("集团客户主体");
    expect(group.displayProperty).toBe("CUST_NAME");
    const byName = new Map(group.properties.map((property) => [property.name, property]));
    // 显示名和机器名一样就不重复存
    expect(byName.get("CUST_ID")).toMatchObject({ dataType: "TEXT", displayName: "", description: "集团客户编码", required: true, unique: true });
    expect(byName.get("CUST_NAME")).toMatchObject({ displayName: "客户名称", description: "集团客户名称" });
    expect(byName.get("FEE_MON")).toMatchObject({ dataType: "DECIMAL" });
    // 不认识的类型退到 TEXT
    expect(byName.get("UNKNOWN_TYPE")).toMatchObject({ dataType: "TEXT" });
    // 有表的类：主键落在来源绑定上，属性映射到列
    expect(group.sources).toEqual([{ id: "primary", dataSourceId: "", schema: "GISTOOLS", view: "TB_MK_GRP_SERV_LEVEL_DAY", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" }]);
    expect(byName.get("CUST_ID")).toMatchObject({ sourceField: "CUST_ID", sourceId: "primary" });
  });

  it("没有表的类：主键改记在属性上，来源留空且不硬造映射", () => {
    const { bundle } = fromBknKnowledgeNetwork(knowledgeNetwork());
    const customer = bundle.definition.entityTypes.find((item) => item.name === "客户")!;
    expect(customer.sources).toEqual([]);
    expect(customer.properties.find((property) => property.name === "customer_id")).toMatchObject({ required: true, unique: true, sourceField: "", sourceId: "" });
    expect(customer.properties.find((property) => property.name === "customer_id")?.displayName).toBe("客户编号");
  });

  it("关系类型的端点指向新 id，说明也带过来", () => {
    const { bundle } = fromBknKnowledgeNetwork(knowledgeNetwork());
    const [link] = bundle.definition.relationshipTypes;
    const ids = new Set(bundle.definition.entityTypes.map((item) => item.id));
    expect(link.name).toBe("客户包含集团客户");
    expect(link.description).toBe("整体客户包含集团客户");
    expect(ids.has(link.sourceEntityTypeId)).toBe(true);
    expect(ids.has(link.targetEntityTypeId)).toBe(true);
    // 原 id 不该漏进结果
    expect(JSON.stringify(bundle.definition)).not.toContain('"customer"');
  });

  it("装不下的东西逐条报出来，不静默丢", () => {
    const { warnings } = fromBknKnowledgeNetwork(knowledgeNetwork());
    const joined = warnings.join("\n");
    expect(joined).toContain("geopoint");
    expect(joined).toContain("mapping_rules");
    expect(joined).toContain("概念域分组");
    expect(joined).toContain("指标");
    expect(joined).toContain("请在类型编辑里为它选一次数据资源");
    expect(joined).toContain("主键（customer_id）改记在属性上");
  });

  it("空文件与坏输入给得出话", () => {
    expect(() => fromBknKnowledgeNetwork(null)).toThrow("应该是一个 JSON 对象");
    expect(() => fromBknKnowledgeNetwork({ object_types: [], relation_types: [] })).toThrow("没有 object_types");
  });
});