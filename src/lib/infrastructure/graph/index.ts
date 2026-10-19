import { createJenaStore } from "@/lib/infrastructure/graph/jena";
import { createEmbeddedStore } from "@/lib/infrastructure/graph/embedded";
import type { EmbeddedGraphRepository } from "@/lib/infrastructure/graph/embedded/repository";
import { isGraphTargetKind, type GraphStore, type GraphTarget } from "@/lib/infrastructure/graph/types";

export * from "@/lib/infrastructure/graph/types";

/**
 * 本体存储后端注册表。
 *
 * 平台组合层调用 `createGraphStore(target, embeddedRepository)`；业务代码继续通过
 * `@/lib/platform/graph-store` 使用，不关心底层查询语言与存储模型。
 * 注意：本模块会引入具体驱动，只能在服务端使用；客户端请直接引用
 * `./types` 里的纯类型与元数据。
 */
export function createGraphStore(target: GraphTarget, embeddedRepository: EmbeddedGraphRepository): GraphStore {
  if (!isGraphTargetKind(target.kind)) throw new Error(`不支持的本体存储后端：${target.kind}`);
  return target.kind === "EMBEDDED" ? createEmbeddedStore(target, embeddedRepository) : createJenaStore(target);
}
