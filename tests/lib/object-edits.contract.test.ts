import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { createSnapshotEntity, updateSnapshotEntity, deleteSnapshotEntity, resetSnapshotObjectEdit } from "@/lib/instance/snapshot-editing";
import { readVersionSnapshot } from "@/lib/versioning/snapshot";
import { insertVersionRecordRow, deleteTargetVersionRecords } from "@/lib/platform/version-records";

it.skipIf(!process.env.DATABASE_URL)("源基线、字段编辑、删除与恢复在真实 PG 版本中持久保存", async () => {
  const targetId = randomUUID(); const versionId = randomUUID();
  const definition = ontologyDefinitionSchema.parse({ entityTypes: [{ id: randomUUID(), name: "客户", properties: [{ name: "编号", sourceField: "ID", dataType: "TEXT" }, { name: "地区", sourceField: "AREA", dataType: "TEXT" }, { name: "名称", dataType: "TEXT" }, { name: "金额", dataType: "DECIMAL" }], sources: [{ id: "main", view: "T", primaryKey: ["ID", "AREA"] }] }] });
  const original = { 编号: "A", 地区: "371", 名称: "旧名", 金额: 10 };
  try {
    await insertVersionRecordRow({ id: versionId, targetId, versionNumber: 1, createdBy: "contract", definition, snapshot: { nodes: [], relationships: [] } });
    const node = await createSnapshotEntity(versionId, "客户", original, { sourceBase: original });
    await updateSnapshotEntity(versionId, node.id, { ...original, 名称: "新名", 金额: 99 }, { ...original, 金额: 99 });
    const stored = await readVersionSnapshot(versionId);
    expect(stored.objectEdits?.[node.id].base).toEqual(original);
    expect(stored.nodes[0].properties).toMatchObject({ 名称: "新名", 金额: 10 });
    await expect(updateSnapshotEntity(versionId, node.id, { ...original, 编号: "B" })).rejects.toThrow(/主键/);
    await deleteSnapshotEntity(versionId, node.id);
    expect((await readVersionSnapshot(versionId)).objectEdits?.[node.id].deleted).toBe(true);
    await resetSnapshotObjectEdit(versionId, node.id);
    expect((await readVersionSnapshot(versionId)).objectEdits?.[node.id]).toBeUndefined();
  } finally { await deleteTargetVersionRecords(targetId); }
}, 30_000);
