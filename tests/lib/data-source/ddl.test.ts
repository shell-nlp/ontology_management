import { describe, expect, it } from "vitest";
import { ddlFromColumns, inlineDdlComment, typeWithSize } from "@/lib/data-source/ddl";
import type { DataViewField } from "@/lib/data-source/types";

/** 只写关心的那几项，其余按"Oracle 表里的普通可空列"补齐。 */
function column(name: string, patch: Partial<DataViewField> = {}): DataViewField {
  return { name, dataType: "TEXT", nullable: true, primaryKey: false, unique: false, comment: "", position: 1, ...patch };
}

describe("typeWithSize", () => {
  it("Oracle 的裸类型补上长度 / 精度", () => {
    expect(typeWithSize("VARCHAR2", { length: 200 })).toBe("VARCHAR2(200)");
    expect(typeWithSize("CHAR", { length: 12 })).toBe("CHAR(12)");
    expect(typeWithSize("NUMBER", { precision: 15, scale: 2 })).toBe("NUMBER(15,2)");
    expect(typeWithSize("NUMBER", { precision: 10 })).toBe("NUMBER(10)");
  });

  it("DATE 之类不拼长度：data_length 是字节数，拼出来是库里不存在的 DATE(7)", () => {
    expect(typeWithSize("DATE", { length: 7 })).toBe("DATE");
    expect(typeWithSize("BLOB", { length: 4000 })).toBe("BLOB");
  });

  it("已经带括号的类型不动，取不到长度也原样返回", () => {
    expect(typeWithSize("TIMESTAMP(6)", { length: 11 })).toBe("TIMESTAMP(6)");
    expect(typeWithSize("VARCHAR2", {})).toBe("VARCHAR2");
    expect(typeWithSize("", { length: 10 })).toBe("");
  });

  it("ORM 那条路（PG / MySQL 的元数据）同样受益", () => {
    expect(typeWithSize("character varying", { length: "200" })).toBe("character varying(200)");
    expect(typeWithSize("decimal", { precision: 18, scale: 4 })).toBe("decimal(18,4)");
  });
});

describe("inlineDdlComment", () => {
  it("注释块结束标记被拆开、换行压成空格", () => {
    expect(inlineDdlComment("含 */ 的注释")).toBe("含 * / 的注释");
    expect(inlineDdlComment("两行\n注释")).toBe("两行 注释");
  });
});

describe("ddlFromColumns", () => {
  const columns = [
    column("STATIS_DATE", { dataType: "DATE", typeDetail: "DATE", nullable: false, primaryKey: true, comment: "统计日期" }),
    column("CUST_NAME", { dataType: "VARCHAR2", typeDetail: "VARCHAR2(200)", comment: "客户名称" }),
    column("FEE", { dataType: "NUMBER", typeDetail: "NUMBER(15,2)" }),
  ];

  it("注释内联进列定义，不再另发 COMMENT ON（这是省 token 的全部要点）", () => {
    const ddl = ddlFromColumns("ORACLE", "GISTOOLS", "TB_LINE", "table", columns);
    expect(ddl).toBe(
      [
        'CREATE TABLE "GISTOOLS"."TB_LINE" (',
        '  "STATIS_DATE" DATE NOT NULL /* 统计日期 */,',
        '  "CUST_NAME" VARCHAR2(200) /* 客户名称 */,',
        '  "FEE" NUMBER(15,2),',
        '  PRIMARY KEY ("STATIS_DATE")',
        ");",
      ].join("\n"),
    );
    expect(ddl).not.toContain("COMMENT ON COLUMN");
  });

  it("MySQL 天生是列尾 COMMENT，保持原样（它的注释本来就内联）", () => {
    const ddl = ddlFromColumns("MYSQL", "db", "t_line", "table", [
      column("cust_name", { dataType: "varchar", typeDetail: "varchar(200)", comment: "客户名称" }),
    ]);
    expect(ddl).toBe([
      "CREATE TABLE `db`.`t_line` (",
      "  `cust_name` varchar(200) COMMENT '客户名称'",
      ");",
    ].join("\n"));
  });

  it("视图还原不出 SELECT，就把列清单列成注释", () => {
    const ddl = ddlFromColumns("ORACLE", "GISTOOLS", "V_LINE", "view", columns.slice(0, 2));
    expect(ddl).toContain("-- 视图");
    expect(ddl).toContain('--   "CUST_NAME" VARCHAR2(200) /* 客户名称 */');
    expect(ddl).not.toContain("CREATE TABLE");
  });
});
