import type { EmbeddedGraphRepository } from "@/lib/infrastructure/graph/embedded/repository";
import type { GraphWriteSnapshot } from "@/lib/infrastructure/graph/types";
import { EmbeddedGraphEntity, ensurePlatformSchema, jsonValue, platformRepo } from "@/lib/platform/db";

/** Embedded Store 在平台里的持久化实现：每个本体存储一行快照。 */
export function createPlatformEmbeddedGraphRepository(): EmbeddedGraphRepository {
  return {
    ensureReady: ensurePlatformSchema,
    async load(targetId) {
      const repo = await platformRepo(EmbeddedGraphEntity);
      const row = await repo.findOne({ where: { targetId } });
      return (row?.snapshot as GraphWriteSnapshot | undefined) ?? null;
    },
    async replace(targetId, snapshot) {
      const repo = await platformRepo(EmbeddedGraphEntity);
      await repo.upsert({ targetId, snapshot: jsonValue(snapshot), updatedAt: new Date() }, ["targetId"]);
    },
    async clear(targetId) {
      const repo = await platformRepo(EmbeddedGraphEntity);
      await repo.delete({ targetId });
    },
  };
}
