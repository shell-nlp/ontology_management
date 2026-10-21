import { getGraphStore } from "@/lib/platform/graph-store";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { getTarget } from "@/lib/platform/targets";
import { listDataSources } from "@/lib/datasource/sources";
import { validateVersionSnapshot } from "@/lib/instance/version-validation";
import { clearVersionOverlay, ensureVersionSnapshot, getVersionRecord, listVersionRecords, updateVersionRecord, withTargetLock, type VersionStatus } from "@/lib/versioning/snapshot";
import { getOdsStore } from "@/lib/infrastructure/ods";
import { versionChangesFromSnapshot } from "@/lib/instance/ods/published-changes";
import { assertOdsReadyForPublishedChanges } from "@/lib/instance/ods/publish-readiness";

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
    const publishingDraft = version.status === "DRAFT";
    // 把本机登记的资源 id 传进去：来源「有表名、没资源」时才知道该不该提示补齐绑定（见 validateEntitySources）。
    const knownSourceIds = await listDataSources().then((rows) => rows.map((row) => row.id)).catch(() => []);
    const violations = validateVersionSnapshot(snapshot, knownSourceIds);
    // 只拦自相矛盾的配置；「还没配完」的提示留在 warnings 里，不挡发布。
    const blockers = violations.filter((violation) => violation.severity !== "WARN");
    const warnings = violations.filter((violation) => violation.severity === "WARN");
    if (blockers.length) return { published: false as const, violations: blockers };

    const publishedChanges = publishingDraft ? versionChangesFromSnapshot(snapshot, version.id) : null;
    if (publishedChanges) {
      await assertOdsReadyForPublishedChanges(snapshot.definition, publishedChanges);
      await getOdsStore().replaceVersionChanges(version.id, publishedChanges);
    }

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
    try {
      await store.replaceGraph(snapshot);
      graphReplaced = true;
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
        details: { versionId: version.id, kind: target.kind, atomicReplace, graphReplaced, error: message },
      });
      // 原子替换的后端失败时图数据没动，可以明确告诉用户；非原子后端只能说“可能已改动”。
      throw new Error(graphReplaced
        ? `图数据已替换，但版本状态未更新：${message}。请重新发布该版本以恢复一致。`
        : atomicReplace
          ? `发布失败，图数据未改动：${message}`
          : `发布失败，且 ${store.info.label} 不支持事务替换，图数据可能已被部分修改：${message}`);
    }
    const clearedOverlay = publishingDraft ? await clearVersionOverlay(version.id).catch((error) => {
      console.warn(`[version-publish] 版本 ${version.id} 已发布，但活跃覆盖层清理失败：`, error);
      return null;
    }) : null;
    if (publishingDraft && clearedOverlay === null) {
      warnings.push({
        rule: "ODS_OVERLAY_CLEANUP_FAILED",
        message: "版本已发布并写入 ODS，但 PostgreSQL 活跃覆盖层清理失败；查询不会重复叠加，后台可安全重试清理。",
        count: 1,
        severity: "WARN",
      });
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
        // Jena 侧不落地必填约束（capabilities.strongRules 为 false），如实记录为未强制。
        strongRulesEnforced: canEnforceRequired,
        publishedObjectChanges: publishedChanges?.objects.length ?? 0,
        publishedRelationshipChanges: publishedChanges?.relationships.length ?? 0,
        clearedOverlay,
      },
    });
    return {
      published: true as const,
      versionId: version.id,
      entityCount: snapshot.nodes.length,
      relationshipCount: snapshot.relationships.length,
      strongRulesEnforced: canEnforceRequired,
      atomicReplace,
      publishedObjectChanges: publishedChanges?.objects.length ?? 0,
      publishedRelationshipChanges: publishedChanges?.relationships.length ?? 0,
      clearedOverlay,
      warnings,
    };
  });
}
