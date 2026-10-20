import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OdsSourceEntity, OdsSyncJobEntity, jsonValue, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import { cancelOdsSync, deleteOdsSource, listOdsJobs } from "@/lib/instance/ods/service";

const enabled = Boolean(process.env.DATABASE_URL);

describe("ODS 同步任务状态契约", () => {
  it.skipIf(!enabled)("重启遗留任务标为 INTERRUPTED，排队任务可立即取消", async () => {
    const sourceId = randomUUID();
    const dataSourceId = randomUUID();
    const sourceRepo = await platformRepo(OdsSourceEntity);
    const jobRepo = await platformRepo(OdsSyncJobEntity);
    const now = new Date();
    await sourceRepo.save(sourceRepo.create({
      id: sourceId,
      dataSourceId,
      schemaName: "S",
      tableName: "T",
      tableKind: "table",
      columns: jsonValue([{ name: "ID", sourceType: "TEXT", clickhouseType: "String", nullable: false, primaryKey: true }]),
      primaryKeyColumns: jsonValue(["ID"]),
      watermarkColumn: "",
      syncMode: "FULL",
      enabled: true,
      chTable: `ods_${sourceId.replace(/-/g, "").slice(0, 16)}`,
      status: "RUNNING",
      lastSyncAt: now,
      lastSyncJobId: null,
      rowCount: "1",
      lastError: null,
      lastWatermark: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    }));
    const staleJobId = randomUUID();
    await jobRepo.save(jobRepo.create({
      id: staleJobId,
      sourceId,
      status: "RUNNING",
      mode: "FULL",
      scanned: "1",
      rows: "0",
      pages: 1,
      total: null,
      truncated: false,
      message: null,
      queuedAt: now,
      startedAt: now,
      finishedAt: null,
      createdBy: null,
      checkpoint: null,
    }));
    try {
      const recovered = await listOdsJobs(sourceId);
      expect(recovered.find((job) => job.id === staleJobId)?.status).toBe("INTERRUPTED");
      expect((await sourceRepo.findOne({ where: { id: sourceId } }))?.status).toBe("STALE");

      const queuedId = randomUUID();
      await jobRepo.save(jobRepo.create({
        id: queuedId,
        sourceId,
        status: "QUEUED",
        mode: "INCREMENTAL",
        scanned: "0",
        rows: "0",
        pages: 0,
        total: null,
        truncated: false,
        message: null,
        queuedAt: new Date(),
        startedAt: null,
        finishedAt: null,
        createdBy: null,
        checkpoint: null,
      }));
      await expect(deleteOdsSource(sourceId)).rejects.toThrow(/正在同步或排队中/);
      const cancelled = await cancelOdsSync(queuedId);
      expect(cancelled.status).toBe("CANCELLED");
    } finally {
      await jobRepo.delete({ sourceId });
      await sourceRepo.delete({ id: sourceId });
    }
  }, 20_000);
});
