import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { buildIndexEntries, resolveObjectTitle } from "@/lib/instance/object-index/entries";
import { normalizeSearchQuery } from "@/lib/infrastructure/object-index/query";
import { planClickHouseSearch } from "@/lib/infrastructure/object-index/clickhouse/plan";

const USER_CLASS_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_CLASS_ID = "22222222-2222-4222-8222-222222222222";
const NODE_ID = "33333333-3333-4333-8333-333333333333";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [
    {
      id: USER_CLASS_ID,
      name: "用户",
      displayProperty: "姓名",
      properties: [
        { name: "user_id", dataType: "TEXT", sourceField: "user_id" },
        { name: "姓名", dataType: "TEXT", sourceField: "name" },
        { name: "状态", dataType: "TEXT", sourceField: "status" },
      ],
      sources: [{ id: "primary", schema: "public", view: "dim_user", primaryKey: ["user_id"], titleField: "name" }],
    },
    { id: ORDER_CLASS_ID, name: "订单", properties: [{ name: "order_no", dataType: "TEXT" }] },
  ],
  relationshipTypes: [],
});

describe("buildIndexEntries", () => {
  it("用展示属性取标题，并按主来源主键列收集业务主键", () => {
    const [entry] = buildIndexEntries(definition, [
      { id: NODE_ID, labels: ["用户"], properties: { user_id: "10001", 姓名: "张三", 状态: "正常" } },
    ]);
    expect(entry.title).toBe("张三");
    expect(entry.primaryKey).toEqual({ user_id: "10001" });
    expect(entry.searchText).toContain("张三");
    expect(entry.searchText).toContain("10001");
    expect(entry.searchText).toContain("正常");
  });

  it("没有绑定来源的类不产生业务主键", () => {
    const [entry] = buildIndexEntries(definition, [{ id: NODE_ID, labels: ["订单"], properties: { order_no: "SO-1" } }]);
    expect(entry.primaryKey).toEqual({});
    // 订单类没配展示属性，退回第一个字符串属性值。
    expect(entry.title).toBe("SO-1");
  });

  it("标题依次退回 name、任意字符串属性、对象 id", () => {
    const meta = new Map<string, { displayProperty: string; keyMapping: { column: string; property: string }[] }>();
    expect(resolveObjectTitle({ id: NODE_ID, labels: ["未知类"], properties: { name: "李四" } }, meta)).toBe("李四");
    expect(resolveObjectTitle({ id: NODE_ID, labels: ["未知类"], properties: { 备注: "随手备注" } }, meta)).toBe("随手备注");
    expect(resolveObjectTitle({ id: NODE_ID, labels: ["未知类"], properties: { 数字: 42 } }, meta)).toBe("42");
    expect(resolveObjectTitle({ id: NODE_ID, labels: ["未知类"], properties: {} }, meta)).toBe(NODE_ID.slice(0, 8));
  });
});

describe("normalizeSearchQuery", () => {
  it("夹取 limit / offset，去重 labels，丢掉没有值的过滤条件", () => {
    const normalized = normalizeSearchQuery({
      targetId: "t",
      labels: ["用户", "用户", " 订单 "],
      limit: 9999,
      offset: -5,
      filters: [
        { property: "状态", operator: "EQ", value: "正常" },
        { property: "缺失值", operator: "EQ" },
        { property: "存在", operator: "EXISTS" },
      ],
    });
    expect(normalized.labels).toEqual(["用户", "订单"]);
    expect(normalized.limit).toBe(200);
    expect(normalized.offset).toBe(0);
    expect(normalized.filters.map((filter) => filter.property)).toEqual(["状态", "存在"]);
  });
});

describe("planClickHouseSearch", () => {
  it("属性排序按下推的数据类型生成表达式，数字列不会按字符串排", () => {
    const plan = planClickHouseSearch({
      targetId: "t",
      labels: ["客户"],
      sort: [
        { property: "信用分", direction: "DESC", dataType: "INTEGER" },
        { property: "客户名称", direction: "ASC", dataType: "TEXT" },
      ],
    }, { vector: true }, DB);
    expect(plan.hits.sql).toContain("ORDER BY toFloat64OrNull(JSONExtractString(properties, {sort_key");
    expect(plan.hits.sql).toMatch(/DESC, JSONExtractString\(properties/);
    expect(plan.hits.sql).toContain("}) ASC, title ASC");
    expect(plan.hits.params).toMatchObject({ sort_key3: "信用分", sort_key4: "客户名称" });
  });

  const DB = "ontology_index";

  it("关键字走子串 + 分词双通道，关键字本身是参数、不进 SQL 文本", () => {
    const plan = planClickHouseSearch({ targetId: "t", text: "郑州客户" }, { vector: true }, DB);
    expect(plan.textMode).toBe("fulltext+trigram");
    expect(plan.hits.sql).toContain("positionCaseInsensitive");
    expect(plan.hits.sql).toContain("hasTokenCaseInsensitive");
    expect(plan.hits.sql).not.toContain("郑州客户");
    expect(Object.values(plan.hits.params)).toContain("郑州客户");
    // 总数查询只带 WHERE 用到的参数：分页参数混进去 CH 会直接报"参数未使用"。
    expect(plan.count.sql).not.toContain("LIMIT");
    expect(Object.values(plan.count.params)).toEqual(["t", "郑州客户"]);
  });

  it("两个字的短关键字只走子串通道（CH 的分词通道至少要 3 个字符）", () => {
    const plan = planClickHouseSearch({ targetId: "t", text: "张三" }, { vector: true }, DB);
    expect(plan.hits.sql).toContain("positionCaseInsensitive");
    expect(plan.hits.sql).not.toContain("hasTokenCaseInsensitive");
  });

  it("类过滤与属性过滤都走占位符，属性名不当字符串拼接", () => {
    const plan = planClickHouseSearch(
      {
        targetId: "t",
        labels: ["用户"],
        filters: [
          { property: "状态", operator: "EQ", value: "正常" },
          { property: "等级", operator: "GT", value: "3" },
        ],
      },
      { vector: true },
      DB,
    );
    expect(plan.hits.sql).toMatch(/hasAny\(labels, \{\w+:Array\(String\)\}\)/);
    expect(plan.hits.sql).toMatch(/JSONExtractString\(properties, \{\w+:String\}\) = \{\w+:String\}/);
    // 大小比较先确认属性值是数字再比，脏数据不会让整条查询报错。
    expect(plan.hits.sql).toContain("match(JSONExtractString(properties,");
    expect(plan.hits.sql).toContain("Float64");
    expect(plan.hits.sql).not.toContain("状态");
    expect(Object.values(plan.hits.params)).toContain("状态");
  });

  it("大小比较的边界值不是数字时丢掉这条过滤，而不是让 ClickHouse 报错", () => {
    const plan = planClickHouseSearch(
      { targetId: "t", filters: [{ property: "消费额", operator: "GT", value: "不是数字" }] },
      { vector: true },
      DB,
    );
    expect(plan.hits.sql).not.toContain("Float64");
    expect(Object.values(plan.count.params)).toEqual(["t"]);
  });

  it("文本检索把相关度回传，前端拿到的 score 才是真的", () => {
    const plan = planClickHouseSearch({ targetId: "t", text: "张三" }, { vector: true }, DB);
    expect(plan.hits.sql).toContain("AS score");
    expect(plan.hits.sql).not.toContain("0.0 AS score");
  });

  it("给向量时以向量距离为主排序，且向量条件与参数不进入总数查询", () => {
    const plan = planClickHouseSearch({ targetId: "t", vector: [0.1, 0.2] }, { vector: true }, DB);
    expect(plan.vectorUsed).toBe(true);
    expect(plan.hits.sql).toContain("cosineDistance(embedding, [0.1,0.2])");
    expect(plan.hits.sql).toContain("notEmpty(embedding)");
    expect(plan.count.sql).toContain("notEmpty(embedding)");
    expect(Object.values(plan.count.params)).toEqual(["t"]);
  });

  it("没有向量能力时不生成向量相关 SQL", () => {
    const plan = planClickHouseSearch({ targetId: "t", vector: [0.1, 0.2] }, { vector: false }, DB);
    expect(plan.vectorUsed).toBe(false);
    expect(plan.hits.sql).not.toContain("cosineDistance");
  });
});
