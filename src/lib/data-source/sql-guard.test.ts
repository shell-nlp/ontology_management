import { describe, expect, it } from "vitest";
import { assertReadOnlySql, beginReadOnlyStatement, boundedStatement, leadingKeyword, stripSqlNoise } from "@/lib/data-source/sql-guard";

describe("leadingKeyword", () => {
  it("取语句开头的动词", () => {
    expect(leadingKeyword("  select 1")).toBe("SELECT");
    expect(leadingKeyword("WITH x AS (SELECT 1) SELECT 1")).toBe("WITH");
    expect(leadingKeyword("")).toBe("");
  });
});

describe("stripSqlNoise", () => {
  it("去掉注释与字符串字面量，保留语句形状", () => {
    // 行注释连换行一起吃掉，补一个空格 —— 不能把上下两行粘成一个词。
    expect(stripSqlNoise("SELECT a -- 注释\nFROM t")).toBe("SELECT a  FROM t");
    expect(stripSqlNoise("SELECT /* x */ a FROM t")).toBe("SELECT   a FROM t");
    expect(stripSqlNoise("SELECT 'DROP TABLE t' FROM dual")).toBe("SELECT '' FROM dual");
    expect(stripSqlNoise("SELECT 'it''s' FROM dual")).toBe("SELECT '' FROM dual");
  });
});

describe("assertReadOnlySql", () => {
  it("放行只读语句，并去掉尾分号", () => {
    expect(assertReadOnlySql("SELECT * FROM t")).toBe("SELECT * FROM t");
    expect(assertReadOnlySql("  select 1 from dual;  ")).toBe("select 1 from dual");
    expect(assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toContain("WITH");
    expect(assertReadOnlySql("SHOW TABLES")).toBe("SHOW TABLES");
    expect(assertReadOnlySql("EXPLAIN SELECT 1")).toBe("EXPLAIN SELECT 1");
  });

  it("拦下所有写操作", () => {
    const writes = [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET a = 1",
      "delete from t",
      "DROP TABLE t",
      "ALTER TABLE t ADD c INT",
      "TRUNCATE TABLE t",
      "CREATE TABLE t (a INT)",
      "GRANT SELECT ON t TO someone",
      "REVOKE SELECT ON t FROM someone",
      "MERGE INTO t USING s ON (1 = 1)",
      "CALL do_something()",
      "SELECT * INTO backup FROM t",
    ];
    for (const sql of writes) expect(() => assertReadOnlySql(sql)).toThrow();
  });

  it("拦下多条语句 —— 只允许一条", () => {
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE t")).toThrow(/多条/);
    expect(() => assertReadOnlySql("SELECT 1; SELECT 2")).toThrow(/多条/);
    expect(() => assertReadOnlySql("SELECT 1 -- x\n; DELETE FROM t")).toThrow(/多条/);
  });

  it("注释里藏的写操作照样看得见", () => {
    expect(() => assertReadOnlySql("/* x */ DROP TABLE t")).toThrow();
    // 反过来，写在注释里的词不是语义：这一条要放行。
    expect(assertReadOnlySql("/* DROP */ SELECT 1")).toBe("/* DROP */ SELECT 1");
  });

  it("字符串字面量里的词不算语义", () => {
    expect(assertReadOnlySql("SELECT 'DROP TABLE t' AS note FROM dual")).toContain("DROP TABLE");
    expect(() => assertReadOnlySql("SELECT '删库跑路' FROM dual")).not.toThrow();
  });

  it("空语句直接拒绝，错误信息说得出是哪种问题", () => {
    expect(() => assertReadOnlySql("   ")).toThrow(/不能为空/);
    expect(() => assertReadOnlySql("DELETE FROM t")).toThrow(/只能执行只读查询/);
  });
});

describe("boundedStatement", () => {
  it("给 SELECT / WITH 套一层行数上限", () => {
    expect(boundedStatement("ORACLE", "SELECT 1 FROM dual", 10)).toBe("SELECT * FROM (SELECT 1 FROM dual) WHERE ROWNUM <= 10");
    expect(boundedStatement("POSTGRES", "SELECT 1", 10)).toBe("SELECT * FROM (SELECT 1) AS bkn_query LIMIT 10");
    expect(boundedStatement("MYSQL", "WITH x AS (SELECT 1) SELECT * FROM x", 5)).toContain("LIMIT 5");
  });

  it("套不上的语句原样执行，上限夹在 1000 以内", () => {
    expect(boundedStatement("MYSQL", "SHOW TABLES", 10)).toBe("SHOW TABLES");
    expect(boundedStatement("POSTGRES", "EXPLAIN SELECT 1", 10)).toBe("EXPLAIN SELECT 1");
    expect(boundedStatement("POSTGRES", "SELECT 1", 99_999)).toContain("LIMIT 1000");
    expect(boundedStatement("POSTGRES", "SELECT 1", 0)).toContain("LIMIT 1");
  });
});

describe("beginReadOnlyStatement", () => {
  it("三种库各自的标准写法", () => {
    expect(beginReadOnlyStatement("POSTGRES")).toBe("BEGIN READ ONLY");
    expect(beginReadOnlyStatement("MYSQL")).toBe("START TRANSACTION READ ONLY");
    expect(beginReadOnlyStatement("ORACLE")).toBe("SET TRANSACTION READ ONLY");
  });
});
