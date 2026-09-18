import { createJenaStore } from "@/lib/graph/jena";
import { createEmbeddedStore } from "@/lib/graph/embedded";
import { isGraphTargetKind, type GraphStore, type GraphTarget } from "@/lib/graph/types";

export * from "@/lib/graph/types";

/**
 * 本体存储后端注册表。
 *
 * 上层只调用 getGraphStore(target)，不关心底层的查询语言与存储模型。
 * 接入新后端时在这里加一个分支即可。
 * 注意：本模块会引入具体驱动，只能在服务端使用；客户端请直接引用
 * @/lib/graph/types 里的纯类型与元数据。
 */
export function getGraphStore(target: GraphTarget): GraphStore {
  if (!isGraphTargetKind(target.kind)) throw new Error(`不支持的本体存储后端：${target.kind}`);
  return target.kind === "EMBEDDED" ? createEmbeddedStore(target) : createJenaStore(target);
}
