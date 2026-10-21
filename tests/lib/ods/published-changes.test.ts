import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { snapshotFromVersionChanges, versionChangesFromSnapshot } from "@/lib/instance/ods/published-changes";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "客户",
    properties: [
      { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID", primaryKey: true },
      { name: "客户名称", dataType: "TEXT", sourceField: "CUST_NAME" },
    ],
    sources: [{ id: "primary", dataSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"] }],
  }, {
    id: "22222222-2222-4222-8222-222222222222",
    name: "账户",
    properties: [{ name: "账户号", dataType: "TEXT", sourceField: "ACCT_ID", primaryKey: true }],
    sources: [{ id: "primary", dataSourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", schema: "S", view: "ACCOUNT", primaryKey: ["ACCT_ID"] }],
  }],
  relationshipTypes: [{
    id: "33333333-3333-4333-8333-333333333333",
    name: "拥有",
    sourceEntityTypeId: "11111111-1111-4111-8111-111111111111",
    targetEntityTypeId: "22222222-2222-4222-8222-222222222222",
    properties: [],
  }],
});

describe("发布版本稀疏变更投影", () => {
  it("把对象 CRUD 与本地关系转换为版本累计变更", () => {
    const snapshot = {
      definition,
      nodes: [
        { id: "customer-a", labels: ["客户"], properties: { 客户编号: "A", 客户名称: "新名称" } },
        { id: "customer-b", labels: ["客户"], properties: { 客户编号: "B", 客户名称: "本地客户" } },
        { id: "account-1", labels: ["账户"], properties: { 账户号: "ACCT-1" } },
      ],
      relationships: [{ id: "rel-instance", type: "拥有", sourceId: "customer-b", targetId: "account-1", properties: { ROLE: "OWNER" } }],
      objectEdits: {
        "customer-a": { entityTypeId: "11111111-1111-4111-8111-111111111111", primaryKey: { CUST_ID: "A" }, base: { 客户编号: "A", 客户名称: "旧名称" } },
        "customer-b": { entityTypeId: "11111111-1111-4111-8111-111111111111", primaryKey: { CUST_ID: "B" }, base: null },
        "customer-c": { entityTypeId: "11111111-1111-4111-8111-111111111111", primaryKey: { CUST_ID: "C" }, base: { 客户编号: "C", 客户名称: "已删除" }, deleted: true },
      },
    };
    const changes = versionChangesFromSnapshot(snapshot, "v2");
    expect(changes.objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ objectId: "customer-a", operation: "UPDATE", changedProperties: ["客户名称"] }),
      expect.objectContaining({ objectId: "customer-b", operation: "CREATE", base: null }),
      expect.objectContaining({ objectId: "customer-c", operation: "DELETE" }),
    ]));
    expect(changes.relationships[0]).toMatchObject({
      relationshipId: "rel-instance",
      sourcePrimaryKey: { CUST_ID: "B" },
      targetPrimaryKey: { ACCT_ID: "ACCT-1" },
    });
  });

  it("从版本变更集还原查询覆盖快照", () => {
    const snapshot = snapshotFromVersionChanges(definition, {
      objects: [{
        versionId: "v2",
        entityTypeId: "11111111-1111-4111-8111-111111111111",
        entityType: "客户",
        objectId: "customer-a",
        primaryKey: { CUST_ID: "A" },
        operation: "UPDATE",
        base: { 客户编号: "A", 客户名称: "旧名称" },
        properties: { 客户编号: "A", 客户名称: "新名称" },
        changedProperties: ["客户名称"],
      }, {
        versionId: "v2",
        entityTypeId: "11111111-1111-4111-8111-111111111111",
        entityType: "客户",
        objectId: "customer-c",
        primaryKey: { CUST_ID: "C" },
        operation: "DELETE",
        base: { 客户编号: "C", 客户名称: "已删除" },
        properties: {},
        changedProperties: [],
      }],
      relationships: [{
        versionId: "v2",
        relationshipTypeId: "33333333-3333-4333-8333-333333333333",
        relationshipType: "拥有",
        relationshipId: "link-1",
        sourceEntityTypeId: "11111111-1111-4111-8111-111111111111",
        targetEntityTypeId: "22222222-2222-4222-8222-222222222222",
        sourceObjectId: "customer-a",
        targetObjectId: "account-1",
        sourcePrimaryKey: { CUST_ID: "A" },
        targetPrimaryKey: { ACCT_ID: "ACCT-1" },
        operation: "CREATE",
        properties: {},
      }],
    });
    expect(snapshot.nodes.find((node) => node.id === "customer-a")?.properties.客户名称).toBe("新名称");
    expect(snapshot.objectEdits?.["customer-c"].deleted).toBe(true);
    expect(snapshot.relationships[0]).toMatchObject({ sourceId: "customer-a", targetId: "account-1" });
  });
});
