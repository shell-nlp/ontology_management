import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getOdsStore } from "@/lib/infrastructure/ods";

const clickHouseUrl = process.env.CLICKHOUSE_URL;

describe("ODS 发布版本变更集契约", () => {
  it.skipIf(!clickHouseUrl)("按版本替换、读取和删除对象/关系稀疏变更", async () => {
    const versionId = `version-${randomUUID()}`;
    const store = getOdsStore();
    try {
      await store.replaceVersionChanges(versionId, {
        objects: [
          {
            versionId,
            entityTypeId: "type-1",
            entityType: "客户",
            objectId: "object-1",
            primaryKey: { CUST_ID: "A" },
            operation: "UPDATE",
            base: { CUST_ID: "A", NAME: "旧名称", AREA: "371" },
            properties: { CUST_ID: "A", NAME: "新名称", AREA: "371" },
            changedProperties: ["NAME"],
          },
          {
            versionId,
            entityTypeId: "type-1",
            entityType: "客户",
            objectId: "object-2",
            primaryKey: { CUST_ID: "B" },
            operation: "CREATE",
            base: null,
            properties: { CUST_ID: "B", NAME: "本地新建" },
            changedProperties: ["CUST_ID", "NAME"],
          },
          {
            versionId,
            entityTypeId: "type-1",
            entityType: "客户",
            objectId: "object-3",
            primaryKey: { CUST_ID: "C" },
            operation: "DELETE",
            base: { CUST_ID: "C", NAME: "已删除" },
            properties: {},
            changedProperties: [],
          },
        ],
        relationships: [
          {
            versionId,
            relationshipTypeId: "rel-1",
            relationshipType: "拥有",
            relationshipId: "link-1",
            sourceEntityTypeId: "type-1",
            targetEntityTypeId: "type-2",
            sourceObjectId: "object-1",
            targetObjectId: "target-1",
            sourcePrimaryKey: { CUST_ID: "A" },
            targetPrimaryKey: { ID: "T1" },
            operation: "CREATE",
            properties: { ROLE: "OWNER" },
          },
        ],
      });

      const first = await store.readVersionChanges(versionId);
      expect(first.objects).toHaveLength(3);
      expect(first.objects.find((item) => item.objectId === "object-1")).toMatchObject({
        operation: "UPDATE",
        primaryKey: { CUST_ID: "A" },
        changedProperties: ["NAME"],
      });
      expect(first.objects.find((item) => item.objectId === "object-3")?.operation).toBe("DELETE");
      expect(first.relationships).toHaveLength(1);
      expect(first.relationships[0].properties).toEqual({ ROLE: "OWNER" });

      await store.replaceVersionChanges(versionId, {
        objects: [{
          versionId,
          entityTypeId: "type-1",
          entityType: "客户",
          objectId: "object-1",
          primaryKey: { CUST_ID: "A" },
          operation: "UPDATE",
          base: { CUST_ID: "A", NAME: "旧名称" },
          properties: { CUST_ID: "A", NAME: "再次修改" },
          changedProperties: ["NAME"],
        }],
        relationships: [],
      });
      const replaced = await store.readVersionChanges(versionId);
      expect(replaced.objects.map((item) => item.objectId)).toEqual(["object-1"]);
      expect(replaced.relationships).toEqual([]);

      await store.deleteVersionChanges(versionId);
      await expect(store.readVersionChanges(versionId)).resolves.toEqual({ objects: [], relationships: [] });
    } finally {
      await store.deleteVersionChanges(versionId).catch(() => undefined);
    }
  }, 30_000);
});
