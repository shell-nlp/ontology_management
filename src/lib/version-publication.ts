import { reconcileStrongRules } from "@/lib/ontology";
import { replaceGraphWithSnapshot } from "@/lib/neo4j";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, validateVersionSnapshot } from "@/lib/version-snapshot";

type PublicationVersion = {
  id: string;
  target_id: string;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

export async function publishVersionSnapshot(versionId: string, user: { id: string }, allowedStatuses: PublicationVersion["status"][]) {
  const result = await platformQuery<PublicationVersion>(
    "SELECT id, target_id, status FROM ontology_platform.ontology_versions WHERE id = $1",
    [versionId],
  );
  const version = result.rows[0];
  if (!version) throw new Error("本体版本不存在。");
  if (!allowedStatuses.includes(version.status)) throw new Error("该版本当前状态不允许发布或激活。");
  if (version.status === "ARCHIVED") {
    const draft = await platformQuery<{ id: string }>(
      "SELECT id FROM ontology_platform.ontology_versions WHERE target_id = $1 AND status = 'DRAFT' LIMIT 1",
      [version.target_id],
    );
    if (draft.rows[0]) throw new Error("当前目标存在草稿，请先发布草稿后再激活历史版本。");
  }
  const target = await getTarget(version.target_id);
  if (!target) throw new Error("目标不存在。");
  const snapshot = await ensureVersionSnapshot(version.id, target);
  const violations = validateVersionSnapshot(snapshot);
  if (violations.length) return { published: false as const, violations };

  await replaceGraphWithSnapshot(target, version.id, snapshot);
  const canEnforceRequired = await reconcileStrongRules(target, snapshot.definition);
  await platformQuery(
    "UPDATE ontology_platform.ontology_versions SET status = 'ARCHIVED' WHERE target_id = $1 AND status = 'PUBLISHED' AND id <> $2",
    [version.target_id, version.id],
  );
  await platformQuery(
    "UPDATE ontology_platform.ontology_versions SET status = 'PUBLISHED', published_at = NOW() WHERE id = $1",
    [version.id],
  );
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
}
