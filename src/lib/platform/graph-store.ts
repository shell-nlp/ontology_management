import { createGraphStore } from "@/lib/infrastructure/graph";
import type { GraphStore, GraphTarget } from "@/lib/infrastructure/graph/types";
import { createPlatformEmbeddedGraphRepository } from "@/lib/platform/embedded-graph-repository";

const embeddedRepository = createPlatformEmbeddedGraphRepository();

/**
 * 平台组合层：决定图存储适配器使用的具体持久化与连接实现。
 *
 * 业务代码只调用 `getGraphStore(target)`；基础设施层不反向引用平台数据库。
 */
export function getGraphStore(target: GraphTarget): GraphStore {
  return createGraphStore(target, embeddedRepository);
}

export * from "@/lib/infrastructure/graph/types";
