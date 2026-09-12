import { getGraphStore } from "@/lib/graph";
import { getObjectIndex } from "@/lib/object-index";
import { buildIndexEntries } from "@/lib/object-index/entries";
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
      if (records.some((record) => record.status === "DRAFT")) throw new Error("当前本体存储存在草稿，请先发布草稿后再激活历史版本。");
    }
    const target = await getTarget(version.target_id);
    if (!target) throw new Error("本体存储不存在。");
    const snapshot = await ensureVersionSnapshot(version.id, target);
    const violations = validateVersionSnapshot(snapshot);
    // 只拦自相矛盾的配置；「还没配完」的提示留在 warnings 里，不挡发布。
    const blockers = violations.filter((violation) => violation.severity !== "WARN");
    const warnings = violations.filter((violation) => violation.severity === "WARN");
    if (blockers.length) return { published: false as const, violations: blockers };

    const store = getGraphStore(target);
    const { atomicReplace } = store.info.capabilities;
    // 先落一条“已开始”的审计：发布跨越图库写入与版本状态两处，出问题时需要能从审计还原现场。
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: "VERSION_PUBLISH_STARTED",
      details: {
        versionId: version.id,
        kind: target.kind,
        atomicReplace,
        entityCount: snapshot.nodes.length,
        relationshipCount: snapshot.relationships.length,
      },
    });

    let canEnforceRequired = false;
    let graphReplaced = false;
    let indexSynced = false;
    try {
      await store.replaceGraph(snapshot);
      graphReplaced = true;
      // 检索索引是派生数据，但必须和发布同时成立：索引落后会让搜索结果指向不存在的对象，比发布失败更难排查。
      // 索引写失败时图数据已替换、版本仍是 DRAFT，走下面同一条「重新发布以恢复一致」的路径。
      await getObjectIndex().replaceTargetObjects(target.id, buildIndexEntries(snapshot.definition, snapshot.nodes), { versionId: version.id });
      indexSynced = true;
      canEnforceRequired = (await store.reconcileStrongRules(snapshot.definition)).enforced;
      for (const record of await listVersionRecords(version.target_id)) {
        if (record.id !== version.id && record.status === "PUBLISHED") await updateVersionRecord(record.id, { status: "ARCHIVED" });
      }
      await updateVersionRecord(version.id, { status: "PUBLISHED", publishedAt: new Date().toISOString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      await writeAuditEntry({
        actorId: user.id,
        targetId: version.target_id,
        action: "VERSION_PUBLISH_FAILED",
        details: { versionId: version.id, kind: target.kind, atomicReplace, graphReplaced, indexSynced, error: message },
      });
      // 原子替换的后端失败时图数据没动，可以明确告诉用户；非原子后端只能说“可能已改动”。
      throw new Error(graphReplaced
        ? `图数据已替换，但版本状态未更新：${message}。请重新发布该版本以恢复一致。`
        : atomicReplace
          ? `发布失败，图数据未改动：${message}`
          : `发布失败，且 ${store.info.label} 不支持事务替换，图数据可能已被部分修改：${message}`);
    }
    await writeAuditEntry({
      actorId: user.id,
      targetId: version.target_id,
      action: version.status === "DRAFT" ? "VERSION_PUBLISHED" : "VERSION_ACTIVATED",
      details: {
        versionId: version.id,
        kind: target.kind,
        atomicReplace,
        entityCount: snapshot.nodes.length,
        relationshipCount: snapshot.relationships.length,
        // 只有 Neo4j 企业版能落地必填约束；其余后端如实记录为未强制。
        strongRulesEnforced: canEnforceRequired,
      },
    });
    return {
      published: true as const,
      versionId: version.id,
      entityCount: snapshot.nodes.length,
      relationshipCount: snapshot.relationships.length,
      strongRulesEnforced: canEnforceRequired,
      atomicReplace,
      warnings,
    };
  });
}
