import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { buildIndexEntries, resolveObjectTitle } from "@/lib/object-index/entries";
import { escapeLike, normalizeSearchQuery, planObjectSearch } from "@/lib/object-index/sql";

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

describe("escapeLike", () => {
  it("转义 ILIKE 通配符，避免用户输入的 % 变成匹配一切", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("c\\d")).toBe("c\\\\d");
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

describe("planObjectSearch", () => {
  it("关键字同时走全文与模糊，参数全部占位化", () => {
    const plan = planObjectSearch({ targetId: "t", text: "张三" }, { trigram: true, vector: false });
    expect(plan.textMode).toBe("fulltext+trigram");
    expect(plan.hits.text).toContain("plainto_tsquery('simple', $3)");
    expect(plan.hits.text).toContain("similarity(e.search_text, $3)");
    expect(plan.hits.values).toEqual(["t", "张三", "张三", 20, 0]);
    // 总数查询只带 WHERE 用到的参数，排序与分页参数不能混进去。
    expect(plan.count.values).toEqual(["t", "张三", "张三"]);
    expect(plan.count.text).not.toContain("LIMIT");
  });

  it("没有 pg_trgm 时退回只用全文与子串匹配", () => {
    const plan = planObjectSearch({ targetId: "t", text: "张三" }, { trigram: false, vector: false });
    expect(plan.textMode).toBe("fulltext");
    expect(plan.hits.text).not.toContain("similarity(");
  });

  it("类过滤与属性过滤都走占位符，属性名不当字符串拼接", () => {
    const plan = planObjectSearch(
      {
        targetId: "t",
        labels: ["用户"],
        filters: [
          { property: "状态", operator: "EQ", value: "正常" },
          { property: "等级", operator: "GT", value: "3" },
        ],
      },
      { trigram: true, vector: false },
    );
    expect(plan.hits.text).toContain("e.labels && $2::text[]");
    expect(plan.hits.text).toContain("e.properties @> $3::jsonb");
    expect(plan.hits.text).toContain("::numeric > $5::numeric");
    // 数字比较前先做正则校验，避免一条脏数据让整条查询报错。
    expect(plan.hits.text).toContain("~ '^-?[0-9]+(\\.[0-9]+)?$'");
    expect(plan.hits.text).not.toContain("状态");
  });

  it("大小比较的边界值不是数字时丢掉这条过滤，而不是让数据库报错", () => {
    const plan = planObjectSearch(
      { targetId: "t", filters: [{ property: "消费额", operator: "GT", value: "不是数字" }] },
      { trigram: true, vector: false },
    );
    expect(plan.hits.text).not.toContain("::numeric");
    expect(plan.hits.values).toEqual(["t", 20, 0]);
  });

  it("文本检索把相关度回传，前端拿到的 score 才是真的", () => {
    const plan = planObjectSearch({ targetId: "t", text: "张三" }, { trigram: true, vector: false });
    expect(plan.hits.text).toContain("AS score");
    expect(plan.hits.text).not.toContain("0::real AS score");
  });

  it("给向量时以向量相似度为主排序，且向量参数不进入总数查询", () => {
    const plan = planObjectSearch({ targetId: "t", vector: [0.1, 0.2] }, { trigram: true, vector: true });
    expect(plan.vectorUsed).toBe(true);
    expect(plan.hits.text).toContain("<=> $2::vector");
    expect(plan.hits.text).toContain("e.embedding IS NOT NULL");
    expect(plan.count.values).toEqual(["t"]);
    expect(plan.count.text).toContain("e.embedding IS NOT NULL");
  });

  it("没有向量能力时不生成向量相关 SQL", () => {
    const plan = planObjectSearch({ targetId: "t", vector: [0.1, 0.2] }, { trigram: true, vector: false });
    expect(plan.vectorUsed).toBe(false);
    expect(plan.hits.text).not.toContain("<=>");
  });
});
