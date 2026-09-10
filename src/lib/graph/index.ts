import { createJenaStore } from "@/lib/graph/jena";
import { createNeo4jStore } from "@/lib/graph/neo4j";
import { isGraphTargetKind, type GraphStore, type GraphTarget } from "@/lib/graph/types";

export * from "@/lib/graph/types";

/**
 * 图数据库后端注册表。
 *
 * 上层只调用 getGraphStore(target)，不关心底层是 Cypher 还是 SPARQL。
 * 接入新后端（NetworkX、Elasticsearch 等）时在这里加一个分支即可。
 * 注意：本模块会引入具体驱动，只能在服务端使用；客户端请直接引用
 * @/lib/graph/types 里的纯类型与元数据。
 */
export function getGraphStore(target: GraphTarget): GraphStore {
  const kind = isGraphTargetKind(target.kind) ? target.kind : "NEO4J";
  if (kind === "JENA") return createJenaStore({ ...target, kind });
  return createNeo4jStore({ ...target, kind });
}
