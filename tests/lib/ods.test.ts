import { describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { clickHouseTypeFor, odsCreateTableStatement, odsTableName } from "@/lib/infrastructure/ods/clickhouse";

const mocks = vi.hoisted(() => ({ find: vi.fn(), read: vi.fn() }));

vi.mock("@/lib/infrastructure/persistence/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infrastructure/persistence/postgres")>();
  return { ...actual, platformRepo: vi.fn(async () => ({ find: mocks.find })) };
});

vi.mock("@/lib/infrastructure/ods", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infrastructure/ods")>();
  return { ...actual, getOdsStore: vi.fn(() => ({ read: mocks.read })) };
});

import { createOdsFirstObjectSource } from "@/lib/instance/object-service/ods-source";
import { isOdsReconcileDue } from "@/lib/instance/ods/service";

describe("ClickHouse ODS 表规格", () => {
  it("同源表得到稳定且带隔离的表名", () => {
    const name = odsTableName("a", "GISTOOLS", "TB_MK_GRP_LINE_LIST_DAY");
    expect(name).toBe(odsTableName("a", "GISTOOLS", "TB_MK_GRP_LINE_LIST_DAY"));
    expect(name).toMatch(/^ods_gistools_tb_mk_grp_line_list_day_[a-f0-9]{12}$/);
    expect(odsTableName("a", "S", "T")).not.toBe(odsTableName("b", "S", "T"));
  });

  it("原表名超长或含特殊字符时仍得到稳定、可读的安全标识", () => {
    const name = odsTableName("source", "Very-Long Schema", `${"表名".repeat(30)} END`);
    expect(name.startsWith("ods_very_long_schema_")).toBe(true);
    expect(name).toMatch(/_[a-f0-9]{12}$/);
    expect(name.length).toBeLessThanOrEqual(61);
    expect(name).not.toMatch(/[^a-z0-9_]/);
  });

  it("源类型收敛成可比较的 ClickHouse 类型", () => {
    expect(clickHouseTypeFor("VARCHAR2(200)")).toBe("String");
    expect(clickHouseTypeFor("NUMBER(18)")).toBe("Int64");
    expect(clickHouseTypeFor("NUMBER(18,2)")).toBe("Decimal(18, 2)");
    expect(clickHouseTypeFor("DATE", "ORACLE")).toBe("DateTime64(3, 'UTC')");
    expect(clickHouseTypeFor("TIMESTAMP(6)")).toBe("DateTime64(3, 'UTC')");
  });

  it("每张 ODS 表带批次、删除标记和可重建引擎", () => {
    const sql = odsCreateTableStatement("ontology_index.ods_x", [
      { name: "CUST_ID", sourceType: "VARCHAR2(20)", clickhouseType: "String", nullable: false, primaryKey: true },
    ]);
    expect(sql).toContain("_source_id");
    expect(sql).toContain("_sync_batch");
    expect(sql).toContain("_is_deleted");
    expect(sql).toContain("ReplacingMergeTree");
    expect(sql).toContain("`CUST_ID` Nullable(String)");
  });

  it("表注释带出原始 schema 和表名", () => {
    const sql = odsCreateTableStatement("ontology_index.ods_x", [
      { name: "CUST_ID", sourceType: "VARCHAR2(20)", clickhouseType: "String", nullable: false, primaryKey: true },
    ], "LIVE", { sourceSchema: "GISTOOLS", sourceTable: "TB_MK_GRP_LINE_LIST_DAY" });
    expect(sql).toContain("GISTOOLS.TB_MK_GRP_LINE_LIST_DAY 的 ODS 派生镜像");
  });
});

describe("ODS 自动校准判定", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("启用、周期大于 0 且到期才校准", () => {
    expect(isOdsReconcileDue({ enabled: true, autoReconcileHours: 24, nextReconcileAt: new Date("2026-10-20T11:00:00Z") }, now)).toBe(true);
    expect(isOdsReconcileDue({ enabled: false, autoReconcileHours: 24, nextReconcileAt: null }, now)).toBe(false);
    expect(isOdsReconcileDue({ enabled: true, autoReconcileHours: 0, nextReconcileAt: null }, now)).toBe(false);
    expect(isOdsReconcileDue({ enabled: true, autoReconcileHours: 24, nextReconcileAt: new Date("2026-10-20T13:00:00Z") }, now)).toBe(false);
  });
});

describe("ODS_FIRST 对象来源", () => {
  const definition = ontologyDefinitionSchema.parse({
    entityTypes: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "客户",
      displayProperty: "客户名称",
      properties: [
        { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
        { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
      ],
      sources: [{
        id: "primary",
        dataSourceId: "a1000000-0000-4000-8000-000000000001",
        readMode: "ODS",
        schema: "S",
        view: "CUSTOMER",
        primaryKey: ["CUST_ID"],
      }],
    }],
    relationshipTypes: [],
  });

  it("READY 镜像覆盖全部映射列时，过滤和排序直接查询 ODS", async () => {
    mocks.find.mockResolvedValue([{
      id: "ods-1",
      dataSourceId: "a1000000-0000-4000-8000-000000000001",
      schemaName: "S",
      tableName: "CUSTOMER",
      chTable: "ods_customer",
      status: "READY",
      enabled: true,
      columns: [{ name: "CUST_ID" }, { name: "CUST_NAME" }],
    }]);
    mocks.read.mockResolvedValue({
      columns: ["CUST_ID", "CUST_NAME"],
      rows: [{ CUST_ID: "A", CUST_NAME: "甲公司" }],
      total: 1,
      truncated: false,
      statement: "SELECT",
    });
    const result = await createOdsFirstObjectSource().query(definition, "客户", {
      entityType: "客户",
      filters: [{ property: "客户名称", operator: "CONTAINS", value: "甲" }],
      sort: [{ property: "客户编号", direction: "DESC" }],
      limit: 20,
    });
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "ods-1",
      tableName: "ods_customer",
      filters: [{ column: "CUST_NAME", operator: "CONTAINS", value: "甲" }],
      sort: [{ column: "CUST_ID", direction: "DESC" }],
    }));
    expect(result.rows[0].properties).toEqual({ 客户编号: "A", 客户名称: "甲公司" });
    expect(result.total).toBe(1);
  });

  it("来源明确要求 ODS 但镜像不存在时拒绝静默回源", async () => {
    mocks.find.mockResolvedValue([]);
    await expect(createOdsFirstObjectSource().query(definition, "客户", { entityType: "客户" }))
      .rejects.toThrow(/要求读取 ODS/);
  });
});
