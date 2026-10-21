import { describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { jsonValue } from "@/lib/infrastructure/persistence/postgres";
import { assertOdsReadyForPublishedChanges, OdsPublishBlockedError } from "@/lib/instance/ods/publish-readiness";

const mocks = vi.hoisted(() => ({ find: vi.fn() }));

vi.mock("@/lib/infrastructure/persistence/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infrastructure/persistence/postgres")>();
  return { ...actual, platformRepo: vi.fn(async () => ({ find: mocks.find })) };
});

const dataSourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const entityTypeId = "11111111-1111-4111-8111-111111111111";

function definition(readMode: "AUTO" | "DIRECT" = "AUTO") {
  return ontologyDefinitionSchema.parse({
    entityTypes: [{
      id: entityTypeId,
      name: "客户",
      properties: [
        { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID", primaryKey: true },
        { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
      ],
      sources: [{ id: "primary", dataSourceId, schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"], readMode }],
    }],
    relationshipTypes: [],
  });
}

function changes() {
  return {
    objects: [{
      versionId: "version-1",
      entityTypeId,
      entityType: "客户",
      objectId: "object-1",
      primaryKey: { CUST_ID: "A" },
      operation: "UPDATE" as const,
      base: { 客户编号: "A", 客户名称: "旧名称" },
      properties: { 客户编号: "A", 客户名称: "新名称" },
      changedProperties: ["客户名称"],
    }],
    relationships: [],
  };
}

describe("发布 ODS 就绪校验", () => {
  it("缺少 READY ODS 时给出可跳转阻塞项", async () => {
    mocks.find.mockResolvedValue([]);
    await expect(assertOdsReadyForPublishedChanges(definition(), changes())).rejects.toMatchObject({
      name: "OdsPublishBlockedError",
      blockers: [expect.objectContaining({ entityType: "客户", dataSourceId, schema: "S", table: "CUSTOMER" })],
    });
  });

  it("READY 且列完整时通过", async () => {
    mocks.find.mockResolvedValue([{
      dataSourceId,
      schemaName: "S",
      tableName: "CUSTOMER",
      enabled: true,
      status: "READY",
      columns: jsonValue([
        { name: "CUST_ID" },
        { name: "CUST_NAME" },
      ]),
    }]);
    await expect(assertOdsReadyForPublishedChanges(definition(), changes())).resolves.toBeUndefined();
  });

  it("DIRECT 读取路径会绕过版本变更集，发布必须阻止", async () => {
    mocks.find.mockResolvedValue([{
      dataSourceId,
      schemaName: "S",
      tableName: "CUSTOMER",
      enabled: true,
      status: "READY",
      columns: jsonValue([{ name: "CUST_ID" }, { name: "CUST_NAME" }]),
    }]);
    await expect(assertOdsReadyForPublishedChanges(definition("DIRECT"), changes())).rejects.toBeInstanceOf(OdsPublishBlockedError);
  });
});
