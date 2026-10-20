import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema, type OntologyDefinition } from "@/lib/ontology";
import { compileQuerySql, executeOntologySql, parseOntologySql, resolveQueryDsl, toQueryDsl } from "@/lib/query-dsl";
import { REASONING_TOOLS } from "@/lib/reasoning/tools/registry";
import { runReasoningTool } from "@/lib/reasoning/tools";
import { toolGuide } from "@/lib/reasoning/prompt";
import { ONTOLOGY_SQL_DIALECT_GUIDE } from "@/lib/query-dsl/sql-surface/dialect";

/**
 * 本体 SQL（SQL 形状的查询表层）。
 *
 * 这里验的是"表层换成 SQL 之后，**保证一条没丢**"：解析出来的东西是同一份 `QueryDsl`，
 * 于是编译结果与 JSON DSL 完全等价（同一张物理表、同一套绑定参数、同一套基数校验）。
 */

const 专线类 = "22222222-2222-4222-8222-222222222222";
const 地市类 = "33333333-3333-4333-8333-333333333333";
const 归属关系 = "44444444-4444-4444-8444-444444444444";
const 数据资源 = "99999999-9999-4999-8999-999999999999";
const 专线条数指标 = "66666666-6666-4666-8666-666666666666";

function 定义(): OntologyDefinition {
  return ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: 专线类,
        name: "专线产品用户",
        description: "开通了专线产品的用户",
        properties: [
          { name: "统计日期", dataType: "DATE", sourceField: "STATIS_DATE" },
          { name: "业务状态", dataType: "TEXT", sourceField: "STATS", enumValues: [{ value: "A", label: "状态正常" }] },
          { name: "产品名称", dataType: "TEXT", sourceField: "OFFER_NAME" },
          { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
        ],
        sources: [{
          id: "primary",
          dataSourceId: 数据资源,
          schema: "GISTOOLS",
          view: "TB_MK_GRP_LINE_LIST_DAY",
          primaryKey: ["AREA_CODE"],
          titleField: "",
        }],
      },
      {
        id: 地市类,
        name: "地市",
        properties: [
          { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
          { name: "地市名称", dataType: "TEXT", sourceField: "AREA_NAME" },
        ],
        sources: [{
          id: "primary",
          dataSourceId: 数据资源,
          schema: "GISTOOLS",
          view: "TB_DIC_AREA_CODE",
          primaryKey: ["AREA_CODE"],
          titleField: "地市名称",
        }],
      },
    ],
    relationshipTypes: [{
      id: 归属关系,
      name: "归属地市",
      sourceEntityTypeId: 专线类,
      targetEntityTypeId: 地市类,
      cardinality: "MANY_TO_ONE",
      linkSource: { mode: "FOREIGN_KEY", dataSourceId: 数据资源, schema: "GISTOOLS", view: "", foreignKeySide: "SOURCE" },
      sourceKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
      targetKeyMappings: [{ linkProperty: "", entityProperty: "地市编码" }],
    }],
    metrics: [{
      id: 专线条数指标,
      name: "专线条数",
      description: "专线产品用户行数",
      entityTypeId: 专线类,
      aggregation: "COUNT",
      property: "",
      filters: [],
      dimensions: ["地市编码"],
      status: "verified",
    }],
  });
}

const 编译 = (sql: string, kind: "ORACLE" | "POSTGRES" = "ORACLE") => {
  const definition = 定义();
  return compileQuerySql(resolveQueryDsl(definition, toQueryDsl(sql, definition)), kind);
};

describe("本体 SQL：语法与语义绑定", () => {
  it("最朴素的 SELECT：属性、WHERE、ORDER BY、LIMIT 都落到同一份 QueryDsl", () => {
    const definition = 定义();
    const query = toQueryDsl(
      "SELECT 统计日期, 地市编码 FROM 专线产品用户 WHERE 业务状态 = 'A' ORDER BY 统计日期 DESC LIMIT 10",
      definition,
    );
    expect(query.kind).toBe("records");
    expect(query.from).toEqual({ object_type: "专线产品用户", alias: "root" });
    expect(query.select).toEqual([
      { field: { alias: "root", property: "统计日期" }, as: "统计日期" },
      { field: { alias: "root", property: "地市编码" }, as: "地市编码" },
    ]);
    expect(query.where).toEqual({ field: { alias: "root", property: "业务状态" }, op: "eq", value: "A" });
    expect(query.order_by).toEqual([{ ref: "统计日期", direction: "desc" }]);
    expect(query.limit).toBe(10);

    const compiled = 编译("SELECT 统计日期, 地市编码 FROM 专线产品用户 WHERE 业务状态 = 'A' ORDER BY 统计日期 DESC LIMIT 10");
    expect(compiled.statement).toContain('FROM "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY" "root"');
    expect(compiled.statement).toContain('"root"."STATIS_DATE"');
    expect(compiled.statement).toContain('"root"."STATS"');
    expect(compiled.statement).toContain("= :p1");
  });

  it("聚合查询：kind 自动判定成 aggregate，GROUP BY 与 COUNT(*) 都进同一个 select", () => {
    const query = toQueryDsl("SELECT 地市编码 AS 地市, COUNT(*) AS 条数 FROM 专线产品用户 GROUP BY 地市编码 ORDER BY 条数 DESC", 定义());
    expect(query.kind).toBe("aggregate");
    expect(query.select).toEqual([
      { field: { alias: "root", property: "地市编码" }, as: "地市" },
      { aggregate: "COUNT", as: "条数" },
    ]);
    expect(query.group_by).toEqual([{ alias: "root", property: "地市编码" }]);
    expect(query.order_by).toEqual([{ ref: "条数", direction: "desc" }]);
  });

  it("裸名字是属性还是指标，由本体判定；命中指标就按指标走", () => {
    const query = toQueryDsl("SELECT 专线条数 AS 条数 FROM 专线产品用户", 定义());
    expect(query.kind).toBe("aggregate");
    expect(query.select).toEqual([{ metric: "专线条数", as: "条数" }]);
  });

  it("COUNT(DISTINCT …) 映射到 COUNT_DISTINCT，SUM/AVG/MIN/MAX 带属性", () => {
    const query = toQueryDsl("SELECT COUNT(DISTINCT 地市编码) AS 地市数, MIN(统计日期) AS 最早 FROM 专线产品用户", 定义());
    expect(query.select).toEqual([
      { aggregate: "COUNT_DISTINCT", property: "地市编码", as: "地市数" },
      { aggregate: "MIN", property: "统计日期", as: "最早" },
    ]);
  });
});

describe("本体 SQL：LABEL 当输出 / 分组维度", () => {
  it("LABEL(属性) AS 列名：编译成 CASE，把码值翻成中文标签", () => {
    const compiled = 编译("SELECT LABEL(业务状态) AS 状态 FROM 专线产品用户 LIMIT 5");
    expect(compiled.statement).toMatch(/CASE WHEN TRIM\("root"\.\"STATS"\) = :p\d+ THEN :p\d+ END AS "状态"/);
  });

  it("聚合查询按标签分组：输出是标签，GROUP BY 走它下面那一列", () => {
    const compiled = 编译("SELECT LABEL(业务状态) AS 状态, COUNT(*) AS 条数 FROM 专线产品用户 GROUP BY LABEL(业务状态)");
    expect(compiled.statement).toMatch(/CASE WHEN TRIM\("root"\.\"STATS"\) = :p\d+ THEN :p\d+ END AS "状态"/);
    expect(compiled.statement).toMatch(/GROUP BY "root"\."STATS"/);
  });

  it("标签列没进 GROUP BY 一样被拦住（与普通字段同一条规则）", () => {
    expect(() => 编译("SELECT LABEL(业务状态) AS 状态, COUNT(*) AS 条数 FROM 专线产品用户")).toThrowError(/必须出现在 group_by 中/);
  });

  it("属性没配 enumValues 时如实拒绝（码值提示由工具层按列画像补）", () => {
    expect(() => 编译("SELECT LABEL(统计日期) AS 日期 FROM 专线产品用户")).toThrowError(/没有定义 enumValues/);
  });
});

describe("本体 SQL：比较与运算符", () => {
  const where = (sql: string) => toQueryDsl(`SELECT 地市编码 FROM 专线产品用户 WHERE ${sql}`, 定义()).where;

  it("= <> > >= < <= 六个比较符", () => {
    expect(where("统计日期 >= '2026-09-01'")).toEqual({ field: { alias: "root", property: "统计日期" }, op: "gte", value: "2026-09-01" });
    expect(where("地市编码 <> '371'")).toEqual({ field: { alias: "root", property: "地市编码" }, op: "ne", value: "371" });
    expect(where("地市编码 != '371'")).toEqual({ field: { alias: "root", property: "地市编码" }, op: "ne", value: "371" });
  });

  it("IN / NOT IN / BETWEEN / IS NULL / IS NOT NULL", () => {
    expect(where("地市编码 IN ('371', '379')")).toEqual({ field: { alias: "root", property: "地市编码" }, op: "in", value: ["371", "379"] });
    expect(where("地市编码 NOT IN ('371')")).toEqual({ field: { alias: "root", property: "地市编码" }, op: "not_in", value: ["371"] });
    expect(where("统计日期 BETWEEN '2026-01-01' AND '2026-09-30'")).toEqual({ field: { alias: "root", property: "统计日期" }, op: "in_range", value: ["2026-01-01", "2026-09-30"] });
    expect(where("产品名称 IS NULL")).toEqual({ field: { alias: "root", property: "产品名称" }, op: "is_null" });
    expect(where("产品名称 IS NOT NULL")).toEqual({ field: { alias: "root", property: "产品名称" }, op: "is_not_null" });
  });

  it("LIKE 三种模式；没有 % 的 LIKE 直接拒绝并给出路（要精确相等用 =）", () => {
    expect(where("产品名称 LIKE '%互联网%'")).toEqual({ field: { alias: "root", property: "产品名称" }, op: "contains", value: "互联网" });
    expect(where("产品名称 LIKE '互联网%'")).toEqual({ field: { alias: "root", property: "产品名称" }, op: "starts_with", value: "互联网" });
    expect(where("产品名称 LIKE '%专线'")).toEqual({ field: { alias: "root", property: "产品名称" }, op: "ends_with", value: "专线" });
    expect(() => where("产品名称 LIKE '互联网'")).toThrowError(/LIKE 只支持/);
  });

  it("LIKE 用在日期属性上：错误不只说「不支持」，还把按天 / 区间的正确写法给出来", () => {
    expect(() => 编译("SELECT 地市编码 FROM 专线产品用户 WHERE 统计日期 LIKE '2026-09-13%'")).toThrowError(/日期不能用 LIKE 取「某一天」/);
    expect(() => 编译("SELECT 地市编码 FROM 专线产品用户 WHERE 统计日期 LIKE '2026-09-13%'")).toThrowError(/统计日期 >= '2026-09-13' AND 统计日期 < '2026-09-14'/);
  });

  it("LABEL(属性) 按枚举标签过滤；取反要走 NOT (...)", () => {
    expect(where("LABEL(业务状态) = '状态正常'")).toEqual({ field: { alias: "root", property: "业务状态" }, op: "enum_label", value: "状态正常" });
    expect(() => where("LABEL(业务状态) <> '状态正常'")).toThrowError(/LABEL\(\.\.\.\) 只支持 =/);
  });

  it("AND / OR / NOT / 括号按 SQL 的优先级成树", () => {
    expect(where("地市编码 = '371' AND 产品名称 LIKE '%互联网%' OR 统计日期 IS NULL")).toEqual({
      or: [
        { and: [
          { field: { alias: "root", property: "地市编码" }, op: "eq", value: "371" },
          { field: { alias: "root", property: "产品名称" }, op: "contains", value: "互联网" },
        ] },
        { field: { alias: "root", property: "统计日期" }, op: "is_null" },
      ],
    });
    expect(where("NOT (地市编码 = '371')")).toEqual({ not: { field: { alias: "root", property: "地市编码" }, op: "eq", value: "371" } });
  });

  it(":参数 与 DSL 的 parameters 是同一套机制", () => {
    const query = toQueryDsl("SELECT 地市编码 FROM 专线产品用户 WHERE 业务状态 = :state", 定义(), { state: "A" });
    expect(query.where).toEqual({ field: { alias: "root", property: "业务状态" }, op: "eq", value: { param: "state" } });
    expect(query.parameters).toEqual({ state: "A" });
  });
});

describe("本体 SQL：别名与关系遍历", () => {
  it("JOIN 关系类型：编到受控 JOIN 上，不给写 ON 条件", () => {
    const sql = "SELECT line.地市编码, area.地市名称 AS 地市 FROM 专线产品用户 AS line JOIN 归属地市 AS area WHERE area.地市名称 = '郑州'";
    const query = toQueryDsl(sql, 定义());
    expect(query.relationships).toEqual([{ from: "line", alias: "area", type: "归属地市", direction: "forward", optional: false }]);
    const compiled = 编译(sql);
    expect(compiled.statement).toContain('FROM "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY" "line"');
    expect(compiled.statement).toContain('JOIN "GISTOOLS"."TB_DIC_AREA_CODE" "area"');
  });

  it("LEFT JOIN → optional（对不上也保留左边这一行）；BACKWARD 表方向", () => {
    const query = toQueryDsl("SELECT line.地市编码 FROM 专线产品用户 AS line LEFT JOIN 归属地市 AS area BACKWARD", 定义());
    expect(query.relationships).toEqual([{ from: "line", alias: "area", type: "归属地市", direction: "backward", optional: true }]);
  });

  it("对象类型名本身也能当别名用（`FROM 专线产品用户` 后写 `专线产品用户.地市编码`）", () => {
    const query = toQueryDsl("SELECT 专线产品用户.地市编码 FROM 专线产品用户", 定义());
    expect(query.select).toEqual([{ field: { alias: "root", property: "地市编码" }, as: "地市编码" }]);
  });

  it("认不出的别名把可用的名字列出来", () => {
    expect(() => toQueryDsl("SELECT nope.地市编码 FROM 专线产品用户", 定义())).toThrowError(/认不出别名「nope」/);
  });
});

describe("本体 SQL：错误必须带路", () => {
  it("对象类型 / 属性 / 指标都不存在时给出建议", () => {
    expect(() => toQueryDsl("SELECT 地市编码 FROM 专线用户", 定义())).toThrowError(/本体里没有对象类型「专线用户」/);
    expect(() => toQueryDsl("SELECT 地市编码 FROM 专线产品用户 WHERE 地市 = '371'", 定义())).toThrowError(/没有属性「地市」/);
    expect(() => toQueryDsl("SELECT 地市编码 FROM 专线产品用户 ORDER BY 地市", 定义())).toThrowError(/ORDER BY 的「地市」不在输出里/);
  });

  it("属性名一个都不沾边时，把该对象类型的属性清单摊开（不让模型再猜一次）", () => {
    expect(() => toQueryDsl("SELECT MAX(tot) AS 合计 FROM 专线产品用户", 定义()))
      .toThrowError(/属性是：统计日期、业务状态、产品名称、地市编码（共 4 个/);
  });

  it("写的是列名时直接说属性叫什么（属性名与列名不同的本体最需要这条）", () => {
    expect(() => toQueryDsl("SELECT MAX(STATIS_DATE) AS 最新日期 FROM 专线产品用户", 定义()))
      .toThrowError(/「STATIS_DATE」是这一列的列名，属性名是「统计日期」/);
  });
  it("不支持的语法如实拒绝：SELECT * / 子查询 / 尾部多余内容", () => {
    expect(() => toQueryDsl("SELECT * FROM 专线产品用户", 定义())).toThrow(/SELECT \* 不接受/);
    expect(() => toQueryDsl("SELECT 地市编码 FROM (SELECT 1) t", 定义())).toThrow(/本体 SQL 解析失败/);
    expect(() => toQueryDsl("SELECT 地市编码 FROM 专线产品用户 LIMIT 10 OFFSET 5", 定义())).toThrow(/只支持 SELECT/);
    expect(toQueryDsl("SELECT 地市编码 FROM 专线产品用户", 定义()).select.length).toBe(1);
  });

  it("聚合查询里没进 GROUP BY 的字段由既有校验拦住（换表层不换保证）", () => {
    expect(() => 编译("SELECT 地市编码, COUNT(*) AS 条数 FROM 专线产品用户")).toThrowError(/group_by|GROUP BY|分组/);
  });

  it("语法树是独立的一层：parseOntologySql 不认识本体，也能把语句拆开", () => {
    const ast = parseOntologySql("select 地市编码 from 专线产品用户 limit 5");
    expect(ast.objectType).toBe("专线产品用户");
    expect(ast.limit).toBe(5);
    expect(ast.select).toEqual([{ kind: "name", name: "地市编码", as: "地市编码", position: 0 }]);
  });
});

describe("本体 SQL：一路走到执行（假连接器，不连库）", () => {
  it("绑定参数、行数上限、物理语句与结果形状都按同一套口径", async () => {
    const seen: { statement: string; limit?: number; parameters?: Record<string, unknown> } = { statement: "" };
    const 假资源 = { id: 数据资源, kind: "ORACLE", name: "Oracle 测试", enabled: true } as never;
    const result = await executeOntologySql(
      定义(),
      "SELECT 地市编码 FROM 专线产品用户 WHERE 业务状态 = :state LIMIT 5",
      {
        parameters: { state: "A" },
        getDataSource: async () => 假资源,
        listDataSources: async () => [],
        openConnector: async () => ({
          runReadOnlyQuery: async (statement: string, options: { limit?: number; parameters?: Record<string, unknown> } = {}) => {
            seen.statement = statement;
            seen.limit = options.limit;
            seen.parameters = options.parameters;
            return { statement, columns: ["地市编码"], rows: [{ 地市编码: "371" }], rowLimit: options.limit ?? 100, truncated: false, readOnlyTransaction: true };
          },
        } as never),
      },
    );

    expect(seen.limit).toBe(5);
    expect(seen.parameters).toEqual({ p1: "A" });
    expect(seen.statement).toContain('"GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY"');
    expect(result.rows).toEqual([["371"]]);
    expect(result.columns).toEqual(["地市编码"]);
    expect(result.data_source).toBe("Oracle 测试");
    expect(result.statement).toBe(seen.statement);
  });
});

describe("本体 SQL：主来源是取数口径（DERIVED）时编成子查询", () => {
  const 口径定义 = (): OntologyDefinition => {
    const base = 定义();
    return ontologyDefinitionSchema.parse({
      ...base,
      entityTypes: [{
        ...base.entityTypes[0],
        sources: [{
          id: "primary",
          kind: "DERIVED",
          sql: "SELECT * FROM (SELECT t.*, ROW_NUMBER() OVER (PARTITION BY USER_ID ORDER BY STATIS_DATE DESC) AS BKN_RN FROM GISTOOLS.TB_MK_GRP_LINE_LIST_DAY t) WHERE BKN_RN = 1",
          rule: null,
          dataSourceId: 数据资源,
          schema: "",
          view: "",
          primaryKey: ["USER_ID"],
          titleField: "USER_ID",
        }],
      }],
    });
  };

  it("口径的来源不是表，编出来是（口径）子查询，不再报没有绑定表", () => {
    const compiled = compileQuerySql(resolveQueryDsl(口径定义(), toQueryDsl("SELECT 地市编码 FROM 专线产品用户 LIMIT 5", 口径定义())), "ORACLE");
    expect(compiled.statement).toContain('FROM (SELECT * FROM (SELECT t.*, ROW_NUMBER()');
    expect(compiled.statement).toContain(') "root"');
    expect(compiled.statement).toContain('"root"."AREA_CODE"');
    expect(compiled.statement).not.toContain('TB_MK_GRP_LINE_LIST_DAY" "root"');
  });

  it("补充来源是口径：明确拒绝（MDO 合并算出来的结果没有定义）", () => {
    const base = 口径定义();
    const definition: OntologyDefinition = ontologyDefinitionSchema.parse({
      ...base,
      entityTypes: [{
        ...base.entityTypes[0],
        sources: [
          { ...base.entityTypes[0].sources![0], kind: "PHYSICAL", sql: "", schema: "GISTOOLS", view: "TB_MK_GRP_LINE_LIST_DAY" },
          { id: "secondary", kind: "DERIVED", sql: "SELECT 1 AS X", rule: null, dataSourceId: 数据资源, schema: "", view: "", primaryKey: ["USER_ID"], titleField: "" },
        ],
      }],
    });
    expect(() => compileQuerySql(resolveQueryDsl(definition, toQueryDsl("SELECT 地市编码 FROM 专线产品用户", definition)), "ORACLE"))
      .toThrowError(/补充来源是取数口径/);
  });
});

describe("run_query 工具：只暴露一种表层", () => {
  it("报错把 hint 与「这一列有哪些值」一起送到模型（列画像拿不到就指路）", async () => {
    const context = { store: { target: { id: "target-1" } } as never, definition: 定义(), runtimeTypes: null };
    const message = await runReasoningTool("run_query", { sql: "SELECT LABEL(统计日期) AS 日期 FROM 专线产品用户" }, context)
      .then(() => "")
      .catch((error: unknown) => (error as Error).message);

    expect(message).toContain("没有定义 enumValues");
    expect(message).toContain("先按码值输出（统计日期）");
    // 有列画像就给真实取值，没有就说去哪儿看 —— 两条路都要有下一步。
    expect(message).toMatch(/列画像采样|get_table_ddl/);
  });

  it("入参只有 sql（必填）与 parameters —— 不再有 query（JSON DSL）", () => {
    const tool = REASONING_TOOLS.find((item) => item.name === "run_query")!;
    expect(tool.name).toBe("run_query");
    expect(Object.keys(tool.parameters.properties ?? {}).sort()).toEqual(["parameters", "sql"]);
    expect(tool.parameters.required).toEqual(["sql"]);
    // 描述里要把本体 SQL 的写法与边界讲清楚，且不许再提"本体查询 DSL"这个旧说法。
    expect(tool.description).toContain("本体 SQL");
    expect(tool.description).toContain("不接受");
    expect(tool.description).not.toContain("本体查询 DSL");
    expect(tool.description).toContain(ONTOLOGY_SQL_DIALECT_GUIDE);
    expect(toolGuide(["run_query"])).toContain(ONTOLOGY_SQL_DIALECT_GUIDE);
    expect(toolGuide(["search_schema"])).not.toContain(ONTOLOGY_SQL_DIALECT_GUIDE);
  });

  it("CASE 条件聚合已经支持，普通 CASE 位置仍明确拒绝", () => {
    for (const expression of ["COUNT(DISTINCT CASE WHEN ZX_FLAG = '1' THEN USER_ID END)", "SUM(CASE WHEN ZX_FLAG = '1' THEN ZX_COUNT ELSE 0 END)"]) {
      expect(parseOntologySql(`SELECT ${expression} AS 数量 FROM 专线产品用户`).select[0]).toMatchObject({ kind: "aggregate", case: { branches: [{ when: { kind: "compare" } }] } });
    }
    expect(parseOntologySql('SELECT COUNT("CASE") AS 数量 FROM 专线产品用户').select).toHaveLength(1);
    expect(() => parseOntologySql("SELECT CASE WHEN ZX_FLAG = '1' THEN 1 END FROM 专线产品用户")).toThrow(/只允许.*聚合参数/);
  });
});
