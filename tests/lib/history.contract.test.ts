import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { getHistoryStore } from "@/lib/infrastructure/history";
import { InstanceHistoryEntity, platformRepo, jsonValue } from "@/lib/infrastructure/persistence/postgres";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { readInstanceHistory, deleteOrCancelInstanceHistory } from "@/lib/instance/history";

it.skipIf(!process.env.DATABASE_URL)("压缩历史跨缓存重读，定义冻结且按本体隔离", async () => {
  const id = randomUUID(); const targetId = randomUUID(); const store = getHistoryStore();
  const repo = await platformRepo(InstanceHistoryEntity);
  const definition = ontologyDefinitionSchema.parse({ entityTypes: [{ id: randomUUID(), name: "客户", properties: [{ name: "名称", dataType: "TEXT" }] }] });
  try {
    await repo.save({ id, targetId, versionId: randomUUID(), definition: jsonValue(definition), entityTypes: jsonValue(["客户"]), status: "DONE", rows: "2", pages: 1, message: null, createdAt: new Date(), finishedAt: new Date() });
    await store.write(id, 0, "客户", [{ objectId: randomUUID(), entityType: "客户", properties: { 名称: "冻结原文" }, primaryKey: { ID: "A", AREA: "371" }, title: "甲", objectRef: "客户/A" }, { objectId: randomUUID(), entityType: "客户", properties: { 名称: "乙" }, primaryKey: { ID: "B", AREA: "379" }, title: "乙", objectRef: "客户/B" }]);
    const first = await readInstanceHistory(id, targetId, { limit: 1, warm: true });
    expect(first.rows[0].properties.名称).toBe("冻结原文");
    first.rows[0].properties.名称 = "外部修改";
    expect((await readInstanceHistory(id, targetId, { limit: 1 })).rows[0].properties.名称).toBe("冻结原文");
    store.evict(id);
    const next = await readInstanceHistory(id, targetId, { offset: 1, limit: 1 });
    expect(next.total).toBe(2); expect(next.rows[0].primaryKey).toEqual({ ID: "B", AREA: "379" });
    await expect(readInstanceHistory(id, randomUUID())).rejects.toThrow(/不存在或不属于/);
  } finally { await deleteOrCancelInstanceHistory(id, targetId).catch(() => undefined); }
}, 30_000);
