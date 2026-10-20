import { describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const mocks = vi.hoisted(() => ({
  selectRows: vi.fn(),
  countRows: vi.fn(),
}));

vi.mock("@/lib/datasource/sources", () => ({
  getDataSource: vi.fn(async () => ({ id: "source", name: "测试库", enabled: true })),
  openDataSource: vi.fn(async () => ({
    selectRows: mocks.selectRows,
    countRows: mocks.countRows,
  })),
}));

import { createDataSourceObjectSource } from "@/lib/instance/object-service/data-source";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "客户",
    displayProperty: "客户名称",
    properties: [
      { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
      { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
      { name: "信用分", dataType: "INTEGER", sourceField: "SCORE", sourceId: "score" },
    ],
    sources: [
      { id: "primary", dataSourceId: "a1000000-0000-4000-8000-000000000001", schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"], titleField: "CUST_NAME" },
      { id: "score", dataSourceId: "a1000000-0000-4000-8000-000000000001", schema: "S", view: "CUSTOMER_SCORE", primaryKey: ["CUST_ID"] },
    ],
  }],
  relationshipTypes: [],
});

describe("虚拟查询的数据源下推", () => {
  it("主来源过滤与排序换成真实列，补充来源按本页主键批量补齐", async () => {
    mocks.selectRows.mockReset();
    mocks.countRows.mockReset();
    mocks.selectRows
      .mockResolvedValueOnce({
        columns: ["CUST_ID", "CUST_NAME"],
        rows: [{ CUST_ID: "A", CUST_NAME: "甲公司" }, { CUST_ID: "B", CUST_NAME: "乙公司" }],
        rowLimit: 20,
        truncated: false,
        statement: "main",
      })
      .mockResolvedValueOnce({
        columns: ["CUST_ID", "SCORE"],
        rows: [{ CUST_ID: "A", SCORE: 91 }, { CUST_ID: "B", SCORE: 82 }],
        rowLimit: 20000,
        truncated: false,
        statement: "supplement",
      });
    mocks.countRows.mockResolvedValue(2);

    const result = await createDataSourceObjectSource().query(definition, "客户", {
      entityType: "客户",
      filters: [{ property: "客户名称", operator: "CONTAINS", value: "公司" }],
      sort: [{ property: "客户编号", direction: "DESC" }],
      limit: 20,
    });

    expect(mocks.selectRows).toHaveBeenNthCalledWith(1, expect.objectContaining({
      columns: ["CUST_ID", "CUST_NAME"],
      filters: [{ column: "CUST_NAME", operator: "CONTAINS", value: "公司" }],
      sort: [{ column: "CUST_ID", direction: "DESC" }],
      limit: 20,
      offset: 0,
    }));
    expect(mocks.selectRows).toHaveBeenNthCalledWith(2, expect.objectContaining({
      columns: ["CUST_ID", "SCORE"],
      filters: [{ column: "CUST_ID", operator: "IN", value: ["A", "B"] }],
    }));
    expect(result.rows.map((row) => row.properties)).toEqual([
      { 客户编号: "A", 客户名称: "甲公司", 信用分: 91 },
      { 客户编号: "B", 客户名称: "乙公司", 信用分: 82 },
    ]);
    expect(result.total).toBe(2);
  });

  it("补充来源上的过滤明确拒绝，不把列名错套到主表", async () => {
    await expect(createDataSourceObjectSource().query(definition, "客户", {
      entityType: "客户",
      filters: [{ property: "信用分", operator: "GT", value: 80 }],
    })).rejects.toThrow(/补充来源.*DERIVED SQL/);
  });

  it("批量按复合主键取对象：每个键列都下推，并按完整键精确过滤", async () => {
    const composite = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: "22222222-2222-4222-8222-222222222222",
        name: "网格客户",
        properties: [
          { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
          { name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" },
        ],
        sources: [{ id: "primary", dataSourceId: "a1000000-0000-4000-8000-000000000001", schema: "S", view: "GRID_CUSTOMER", primaryKey: ["CUST_ID", "AREA_CODE"] }],
      }],
      relationshipTypes: [],
    });
    mocks.selectRows.mockReset();
    mocks.selectRows.mockResolvedValue({
      columns: ["CUST_ID", "AREA_CODE"],
      rows: [{ CUST_ID: "A", AREA_CODE: "371" }, { CUST_ID: "A", AREA_CODE: "379" }],
      rowLimit: 20,
      truncated: false,
      statement: "main",
    });
    const result = await createDataSourceObjectSource().query(composite, "网格客户", {
      entityType: "网格客户",
      keys: [{ CUST_ID: "A", AREA_CODE: "371" }],
      limit: 20,
    });
    expect(mocks.selectRows).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ column: "CUST_ID", operator: "EQ", value: "A" }, { column: "AREA_CODE", operator: "EQ", value: "371" }],
    }));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].primaryKey).toEqual({ CUST_ID: "A", AREA_CODE: "371" });
    expect(result.total).toBe(1);
  });
});
