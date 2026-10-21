import { expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { resolveQueryDsl, toQueryDsl } from "@/lib/query-dsl";

const mocks = vi.hoisted(() => ({ find: vi.fn(), query: vi.fn() }));

vi.mock("@/lib/infrastructure/persistence/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infrastructure/persistence/postgres")>();
  return { ...actual, platformRepo: vi.fn(async () => ({ find: mocks.find })) };
});
vi.mock("@/lib/infrastructure/clickhouse/config", () => ({
  clickHouseConfig: () => ({ database: "ontology_index", url: "http://localhost", user: "admin", password: "admin", timeoutMs: 1000 }),
}));
vi.mock("@/lib/infrastructure/clickhouse/client", () => ({ clickHouseQuery: mocks.query }));

import { createClickHouseOdsQueryExecutor } from "@/lib/infrastructure/ods/logical-query";

const DATA_SOURCE = "a1000000-0000-4000-8000-000000000001";
const definition = ontologyDefinitionSchema.parse({
  entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "客户",
    properties: [
      { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
      { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
      { name: "信用分", dataType: "INTEGER", sourceField: "SCORE" },
    ],
    sources: [{
      id: "primary",
      dataSourceId: DATA_SOURCE,
      readMode: "ODS",
      schema: "S",
      view: "CUSTOMER",
      primaryKey: ["CUST_ID"],
    }],
  }],
  relationshipTypes: [],
});

it("查询 DSL 在完整 READY ODS 上编译过滤、聚合和源分区条件", async () => {
  mocks.find.mockResolvedValue([{
    id: "ods-customer",
    dataSourceId: DATA_SOURCE,
    schemaName: "S",
    tableName: "CUSTOMER",
    chTable: "ods_customer",
    status: "READY",
    enabled: true,
    lastSyncAt: new Date(),
    columns: [{ name: "CUST_ID" }, { name: "CUST_NAME" }, { name: "SCORE" }],
  }]);
  mocks.query.mockResolvedValue([{ 条数: 2 }]);
  const plan = resolveQueryDsl(definition, toQueryDsl("SELECT COUNT(*) AS 条数 FROM 客户 WHERE 信用分 >= 80 AND 客户名称 LIKE '%公司%'", definition));
  const result = await createClickHouseOdsQueryExecutor().executeLogicalQuery(plan);

  expect(result).toMatchObject({
    data_source: "ClickHouse ODS",
    data_source_kind: "CLICKHOUSE",
    columns: ["条数"],
    rows: [[2]],
  });
  expect(result?.statement).toContain('FROM "ontology_index"."ods_customer" FINAL');
  expect(result?.statement).toContain("_source_id = 'ods-customer'");
  expect(result?.statement).toContain('_is_deleted = 0) AS "root"');
  expect(result?.statement).toContain("count() AS");
  expect(mocks.query.mock.calls[0][1].params).toMatchObject({ p1: "80", p2: "公司" });
});

it("任一来源缺少完整 READY ODS 时不抢路由，继续让查询层回退源库", async () => {
  mocks.find.mockResolvedValue([]);
  mocks.query.mockReset();
  const plan = resolveQueryDsl(definition, toQueryDsl("SELECT COUNT(*) AS 条数 FROM 客户", definition));
  await expect(createClickHouseOdsQueryExecutor().executeLogicalQuery(plan)).resolves.toBeNull();
  expect(mocks.query).not.toHaveBeenCalled();
});

it("只要求本次查询引用的列，不要求未用属性也进入 ODS 裁剪", async () => {
  mocks.find.mockResolvedValue([{
    id: "ods-customer",
    dataSourceId: DATA_SOURCE,
    schemaName: "S",
    tableName: "CUSTOMER",
    chTable: "ods_customer",
    status: "READY",
    enabled: true,
    lastSyncAt: new Date(),
    columns: [{ name: "CUST_ID" }, { name: "SCORE" }],
  }]);
  mocks.query.mockReset();
  mocks.query.mockResolvedValue([{ 条数: 2 }]);
  const plan = resolveQueryDsl(definition, toQueryDsl("SELECT COUNT(*) AS 条数 FROM 客户 WHERE 信用分 >= 80", definition));
  await expect(createClickHouseOdsQueryExecutor().executeLogicalQuery(plan)).resolves.toMatchObject({ rows: [[2]] });
});

it("查询真正引用但 ODS 未裁剪的列仍会阻止路由", async () => {
  mocks.find.mockResolvedValue([{
    id: "ods-customer",
    dataSourceId: DATA_SOURCE,
    schemaName: "S",
    tableName: "CUSTOMER",
    chTable: "ods_customer",
    status: "READY",
    enabled: true,
    lastSyncAt: new Date(),
    columns: [{ name: "CUST_ID" }, { name: "SCORE" }],
  }]);
  mocks.query.mockReset();
  const plan = resolveQueryDsl(definition, toQueryDsl("SELECT 客户名称 AS 名称 FROM 客户", definition));
  await expect(createClickHouseOdsQueryExecutor().executeLogicalQuery(plan)).resolves.toBeNull();
  expect(mocks.query).not.toHaveBeenCalled();
});

it("关系 JOIN 使用两端 ODS 表，外键连接仍走本体关系计划", async () => {
  const linked = ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "客户",
        properties: [{ name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" }],
        sources: [{ id: "primary", dataSourceId: DATA_SOURCE, readMode: "ODS", schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"] }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "订单",
        properties: [
          { name: "订单号", dataType: "TEXT", sourceField: "ORDER_ID" },
          { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
        ],
        sources: [{ id: "primary", dataSourceId: DATA_SOURCE, readMode: "ODS", schema: "S", view: "ORDERS", primaryKey: ["ORDER_ID"] }],
      },
    ],
    relationshipTypes: [{
      id: "33333333-3333-4333-8333-333333333333",
      name: "客户拥有订单",
      sourceEntityTypeId: "11111111-1111-4111-8111-111111111111",
      targetEntityTypeId: "22222222-2222-4222-8222-222222222222",
      sourceKeyMappings: [{ entityProperty: "客户编号" }],
      targetKeyMappings: [{ entityProperty: "客户编号" }],
      linkSource: { mode: "FOREIGN_KEY", foreignKeySide: "TARGET" },
    }],
  });
  mocks.find.mockResolvedValue([
    { id: "ods-customer", dataSourceId: DATA_SOURCE, schemaName: "S", tableName: "CUSTOMER", chTable: "ods_customer", status: "READY", enabled: true, lastSyncAt: new Date(), columns: [{ name: "CUST_ID" }] },
    { id: "ods-orders", dataSourceId: DATA_SOURCE, schemaName: "S", tableName: "ORDERS", chTable: "ods_orders", status: "READY", enabled: true, lastSyncAt: new Date(), columns: [{ name: "ORDER_ID" }, { name: "CUST_ID" }] },
  ]);
  mocks.query.mockReset();
  mocks.query.mockResolvedValue([{ 订单号: "O-1" }]);
  const plan = resolveQueryDsl(linked, {
    version: "1.0",
    kind: "records",
    from: { object_type: "客户", alias: "c" },
    relationships: [{ alias: "o", type: "客户拥有订单", from: "c", direction: "forward" }],
    select: [{ field: { alias: "o", property: "订单号" }, as: "订单号" }],
    group_by: [],
    order_by: [],
    parameters: {},
    limit: 10,
  } as never);
  const result = await createClickHouseOdsQueryExecutor().executeLogicalQuery(plan);
  expect(result?.statement).toContain('JOIN (SELECT * FROM "ontology_index"."ods_orders" FINAL');
  expect(result?.statement).toContain('"c"."CUST_ID" = "o"."CUST_ID"');
  expect(result?.rows).toEqual([["O-1"]]);
});

it("发布版本的本地关系会叠加到连接表查询", async () => {
  const relationId = "33333333-3333-4333-8333-333333333333";
  const linked = ontologyDefinitionSchema.parse({
    entityTypes: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "客户",
        properties: [{ name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" }],
        sources: [{ id: "primary", dataSourceId: DATA_SOURCE, readMode: "ODS", schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"] }],
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "地市",
        properties: [{ name: "地市编码", dataType: "TEXT", sourceField: "AREA_CODE" }],
        sources: [{ id: "primary", dataSourceId: DATA_SOURCE, readMode: "ODS", schema: "S", view: "AREA", primaryKey: ["AREA_CODE"] }],
      },
    ],
    relationshipTypes: [{
      id: relationId,
      name: "归属地市",
      sourceEntityTypeId: "11111111-1111-4111-8111-111111111111",
      targetEntityTypeId: "22222222-2222-4222-8222-222222222222",
      sourceKeyMappings: [{ linkProperty: "CUST_ID", entityProperty: "客户编号" }],
      targetKeyMappings: [{ linkProperty: "AREA_CODE", entityProperty: "地市编码" }],
      linkSource: { mode: "JOIN_TABLE", dataSourceId: DATA_SOURCE, schema: "S", view: "CUSTOMER_AREA" },
    }],
  });
  mocks.find.mockResolvedValue([
    { id: "ods-customer", dataSourceId: DATA_SOURCE, schemaName: "S", tableName: "CUSTOMER", chTable: "ods_customer", status: "READY", enabled: true, lastSyncAt: new Date(), columns: [{ name: "CUST_ID" }] },
    { id: "ods-area", dataSourceId: DATA_SOURCE, schemaName: "S", tableName: "AREA", chTable: "ods_area", status: "READY", enabled: true, lastSyncAt: new Date(), columns: [{ name: "AREA_CODE" }] },
    { id: "ods-link", dataSourceId: DATA_SOURCE, schemaName: "S", tableName: "CUSTOMER_AREA", chTable: "ods_link", status: "READY", enabled: true, lastSyncAt: new Date(), columns: [{ name: "CUST_ID" }, { name: "AREA_CODE" }] },
  ]);
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT DISTINCT entity_type_id")) return [];
    if (sql.includes("SELECT DISTINCT relationship_type_id")) return [{ relationship_type_id: relationId }];
    return [{ 地市编码: "371" }];
  });
  const plan = resolveQueryDsl(linked, toQueryDsl("SELECT 地市.地市编码 FROM 客户 JOIN 归属地市 AS 地市", linked));
  const result = await createClickHouseOdsQueryExecutor().executeLogicalQuery(plan, { versionId: "version-1" });
  expect(result?.statement).toContain("ods_version_relationship_changes");
  expect(result?.statement).toContain("UNION ALL");
  expect(result?.rows).toEqual([["371"]]);
});
