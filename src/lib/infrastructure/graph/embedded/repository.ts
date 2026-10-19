import type { GraphWriteSnapshot } from "@/lib/infrastructure/graph/types";

/**
 * 内置图的快照仓储契约。
 *
 * Embedded Store 只负责把快照变成图并执行查询；快照存在哪里由平台组合层注入，
 * 因此这个适配器不再直接依赖 PostgreSQL 实体。
 */
export interface EmbeddedGraphRepository {
  ensureReady(): Promise<void>;
  load(targetId: string): Promise<GraphWriteSnapshot | null>;
  replace(targetId: string, snapshot: GraphWriteSnapshot): Promise<void>;
  clear(targetId: string): Promise<void>;
}
