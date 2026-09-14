import { createJenaStore } from "@/lib/graph/jena";
import { isGraphTargetKind, type GraphStore, type GraphTarget } from "@/lib/graph/types";

export * from "@/lib/graph/types";

/**
 * 图数据库后端注册表。
 *
 * 上层只调用 getGraphStore(target)，不关心底层的查询语言与存储模型。
 * 接入新后端（NetworkX、Elasticsearch 等）时在这里加一个分支即可。
 * 注意：本模块会引入具体驱动，只能在服务端使用；客户端请直接引用
 * @/lib/graph/types 里的纯类型与元数据。
 */
export function getGraphStore(target: GraphTarget): GraphStore {
  // 目前只有 Jena 一个后端；kind 不认识时也按它处理，让错误在「测试连接」里明确暴露出来。
  const kind = isGraphTargetKind(target.kind) ? target.kind : "JENA";
  return createJenaStore({ ...target, kind });
}
