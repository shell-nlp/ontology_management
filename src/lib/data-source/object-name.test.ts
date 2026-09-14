import { describe, expect, it } from "vitest";
import { candidateOwners, pickNamedObject, qualifiedName, quoteIdentifier, splitObjectName } from "@/lib/data-source/object-name";

describe("splitObjectName", () => {
  it("把「模式.表」拆成两段", () => {
    expect(splitObjectName("GISTOOLS.TB_DIC_AREA_CODE")).toEqual({ schema: "GISTOOLS", name: "TB_DIC_AREA_CODE" });
  });

  it("认双引号、反引号、方括号三种引用写法", () => {
    expect(splitObjectName('"GISTOOLS"."TB_X"')).toEqual({ schema: "GISTOOLS", name: "TB_X" });
    expect(splitObjectName("`sk_ws`.`tb_x`")).toEqual({ schema: "sk_ws", name: "tb_x" });
    expect(splitObjectName("[dbo].[TB_X]")).toEqual({ schema: "dbo", name: "TB_X" });
  });

  it("裸名字只有 name，没有 schema", () => {
    expect(splitObjectName("TB_X")).toEqual({ name: "TB_X" });
    expect(splitObjectName("  TB_X  ")).toEqual({ name: "TB_X" });
  });

  it("前后空白与多余的点不影响结果", () => {
    expect(splitObjectName(" GISTOOLS . TB_X ")).toEqual({ schema: "GISTOOLS", name: "TB_X" });
  });

  it("段数超过两段时取最后两段", () => {
    expect(splitObjectName("orcldb.GISTOOLS.TB_X")).toEqual({ schema: "GISTOOLS", name: "TB_X" });
  });

  it("空串原样回一个空名，交给调用方报错", () => {
    expect(splitObjectName("")).toEqual({ name: "" });
    expect(splitObjectName("   ")).toEqual({ name: "" });
  });
});

describe("quoteIdentifier / qualifiedName", () => {
  it("候选模式按优先级去重，空值不算数", () => {
    expect(candidateOwners("GISTOOLS", undefined, "gistools", "SK", "")).toEqual(["GISTOOLS", "SK"]);
    expect(candidateOwners(undefined, "  ", undefined)).toEqual([]);
  });

  it("按候选模式挑同名对象；模式都对不上时退回同名的那条", () => {
    const catalog = [
      { schema: "A", name: "T1" },
      { schema: "B", name: "T1" },
      { schema: "A", name: "T2" },
    ];
    expect(pickNamedObject(catalog, { owners: ["B", "A"], name: "T1" })?.schema).toBe("B");
    expect(pickNamedObject(catalog, { owners: [], name: "t1" })?.schema).toBe("A");
    // 名字里写的模式与实际不符时也认，返回库里的真实模式。
    expect(pickNamedObject(catalog, { owners: ["OTHER"], name: "T1" })?.schema).toBe("A");
    // schema 只有一个候选时不必再比模式。
    expect(pickNamedObject(catalog, { owners: ["OTHER"], name: "T2" })?.schema).toBe("A");
    expect(pickNamedObject(catalog, { owners: [], name: "T9" })).toBeNull();
  });

  it("按库种选引用符，内部同类引号翻倍", () => {
    expect(quoteIdentifier("ORACLE", "TB_X")).toBe('"TB_X"');
    expect(quoteIdentifier("MYSQL", "TB_X")).toBe("`TB_X`");
    expect(quoteIdentifier("POSTGRES", 'we"ird')).toBe('"we""ird"');
  });

  it("限定名；schema 为空时只写对象名", () => {
    expect(qualifiedName("ORACLE", "GISTOOLS", "TB_X")).toBe('"GISTOOLS"."TB_X"');
    expect(qualifiedName("ORACLE", "", "TB_X")).toBe('"TB_X"');
    expect(qualifiedName("ORACLE", undefined, "TB_X")).toBe('"TB_X"');
  });
});
