import { describe, expect, it } from "vitest";
import { dedupeSql, orderCandidateColumns } from "@/lib/ontology/dedupe-sql";

/**
 * 「按规则生成取数口径」：生成出来的 SQL 必须是**确定的**（带 ORDER BY、列名走转义），
 * 并且要能从表结构里挑出能当"取哪一行"依据的列。
 */
const field = (name: string, dataType = "VARCHAR2") => ({ name, dataType, nullable: true, primaryKey: false, unique: false, comment: "" });

describe("候选列：哪些列能当「取哪一行」的依据", () => {
  it("类型是日期/时间的算，名字像日期/时间的也算（Oracle 很多日期是字符串存的）", () => {
    const picked = orderCandidateColumns([
      field("USER_ID"),
      field("STATIS_DATE", "VARCHAR2"),
      field("ORDER_DATE", "VARCHAR2"),
      field("CREATE_TIME", "VARCHAR2"),
      field("SNAPSHOT_DAY", "VARCHAR2"),
      field("PACT_START_DT", "VARCHAR2"),
      field("UPDATED_AT", "TIMESTAMP(6)"),
      field("FEE_MON", "NUMBER"),
      field("REMARK"),
      field("STATS"),
    ]).map((item) => item.name);
    expect(picked).toEqual(["STATIS_DATE", "ORDER_DATE", "CREATE_TIME", "SNAPSHOT_DAY", "PACT_START_DT", "UPDATED_AT"]);
  });

  it("名字只以 TS 结尾的状态列不算候选（STATS 是状态，不是时间）", () => {
    expect(orderCandidateColumns([field("STATS", "VARCHAR2")])).toEqual([]);
  });

  it("一个候选都没有时返回空数组（界面据此提示：这张表不能按日期取最新）", () => {
    expect(orderCandidateColumns([field("USER_ID"), field("FEE_MON", "NUMBER")])).toEqual([]);
  });
});

describe("生成去重口径", () => {
  const rule = { keyColumns: ["USER_ID"], orderColumn: "STATIS_DATE" };

  it("PostgreSQL / Oracle：双引号转义，表名带模式，固定取 ROW_NUMBER = 1", () => {
    const sql = dedupeSql({ kind: "POSTGRES", schema: "GISTOOLS", view: "TB_MK_GRP_LINE_LIST_DAY", rule });
    expect(sql).toContain('PARTITION BY "USER_ID" ORDER BY "STATIS_DATE" DESC');
    expect(sql).toContain('FROM "GISTOOLS"."TB_MK_GRP_LINE_LIST_DAY" t');
    expect(sql).toContain("WHERE BKN_RN = 1");
    // 一定是"套一层子查询 + 外层全选"：属性映射照旧按列名对上，多出来的 BKN_RN 会被忽略。
    expect(sql.startsWith("SELECT * FROM (")).toBe(true);
  });

  it("MySQL：反引号转义", () => {
    const sql = dedupeSql({ kind: "MYSQL", schema: "", view: "t_user", rule });
    expect(sql).toContain("PARTITION BY `USER_ID` ORDER BY `STATIS_DATE` DESC");
    expect(sql).toContain("FROM `t_user` t");
  });

  it("取最早：ASC", () => {
    expect(dedupeSql({ kind: "ORACLE", schema: "", view: "T", rule: { ...rule, direction: "ASC" } })).toContain('ORDER BY "STATIS_DATE" ASC');
  });

  it("复合分组键按顺序进 PARTITION BY", () => {
    const sql = dedupeSql({ kind: "POSTGRES", schema: "", view: "T", rule: { keyColumns: ["USER_ID", "SALE_ID"], orderColumn: "ORDER_DATE" } });
    expect(sql).toContain('PARTITION BY "USER_ID", "SALE_ID" ORDER BY "ORDER_DATE" DESC');
  });

  it("缺分组键 / 缺排序列 / 缺表名：直接报错，不生成一段「看着像对」的 SQL", () => {
    expect(() => dedupeSql({ kind: "POSTGRES", schema: "", view: "T", rule: { keyColumns: [], orderColumn: "STATIS_DATE" } })).toThrow(/分组键/);
    expect(() => dedupeSql({ kind: "POSTGRES", schema: "", view: "T", rule: { keyColumns: ["USER_ID"], orderColumn: "  " } })).toThrow(/取值依据/);
    expect(() => dedupeSql({ kind: "POSTGRES", schema: "", view: " ", rule })).toThrow(/表/);
  });
});
