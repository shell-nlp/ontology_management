import { reconcileStrongRules } from "@/lib/ontology";
import { replaceGraphWithSnapshot } from "@/lib/neo4j";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, getVersionRecord, listVersionRecords, updateVersionRecord, validateVersionSnapshot, withTargetLock, type VersionStatus } from "@/lib/version-snapshot";

export async function publishVersionSnapshot(versionId: string, user: { id: string }, allowedStatuses: VersionStatus[]) {
  const initial = await getVersionRecord(versionId);
  if (!initial) throw new Error("本体版本不存在。");
  return withTargetLock(initial.target_id, async () => {
    const version = await getVersionRecord(versionId);
    if (!version) throw new Error("本体版本不存在。");
    if (!allowedStatuses.includes(version.status)) throw new Error("该版本当前状态不允许发布或激活。");
    if (version.status === "ARCHIVED") {
      const records = await listVersionRecords(version.target_id);
      if (records.some((record) => record.status === "DRAFT")) throw new Error("当前目标存在草稿，请先发布草稿后再激活历史版本。");
    }
    const target = await getTarget(version.target_id);
    if (!target) throw new Error("目标不存在。");
    const snapshot = await ensureVersionSnapshot(version.id, target);
    const violations = validateVersionSnapshot(snapshot);
    if (violations.length) return { published: false as const, violations };

    await replaceGraphWithSnapshot(target, version.id, snapshot);
    const canEnforceRequired = await reconcileStrongRules(target, snapshot.definition);
    for (const record of await listVersionRecords(version.target_id)) {
      if (record.id !== version.id && record.status === "PUBLISHED") await updateVersionRecord(record.id, { status: "ARCHIVED" });
    }
    await updateVersionRecord(version.id, { status: "PUBLISHED", publishedAt: new Date().toISOString() });
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: version.status === "DRAFT" ? "VERSION_PUBLISHED" : "VERSION_ACTIVATED",
      details: { versionId: version.id, entityCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length, communityEdition: !canEnforceRequired },
    });
    return {
      published: true as const,
      versionId: version.id,
      entityCount: snapshot.nodes.length,
      relationshipCount: snapshot.relationships.length,
      communityEdition: !canEnforceRequired,
    };
  });
}
