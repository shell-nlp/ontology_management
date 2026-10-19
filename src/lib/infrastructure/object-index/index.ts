import { createClickHouseObjectIndex } from "@/lib/infrastructure/object-index/clickhouse";
import { createClickHouseMaterializedQueryExecutor } from "@/lib/infrastructure/object-index/clickhouse/logical-query";
import type { ObjectIndex, ObjectIndexKind } from "@/lib/infrastructure/object-index/types";
import type { MaterializedQueryExecutor } from "@/lib/query-dsl/contract";

export * from "@/lib/infrastructure/object-index/types";

/**
 * **对象索引的中间层**：契约（`./types`）+ 归一化（`./query`）+ 后端注册表（本文件）+ 各存储实现（`./clickhouse`）。
 *
 * 分层口径（2026-10-11 用户要求「不要直链，需要一个中间层」）：
 * - **本体侧只认 `ObjectIndex` 契约**：发布、对象服务、`/api/object-search`、AI 工具、MCP 都只调
 *   `getObjectIndex()`，永远不 import 某个具体存储（`clickhouse/client` 这种）。
 * - **换存储 = 加一个适配器目录 + 在这里登记一行**：域代码、API、界面、AI 工具一行都不用改。
   *   这和 `infrastructure/graph` 是同一套做法（那边也是「契约 + 注册表 + jena/ / embedded/」）。
 * - **做法不是"抽象掉数据库"，而是"只让一个地方知道数据库长什么样"**：SQL 文本、参数格式、
 *   引擎能力这些只允许出现在 `clickhouse/` 里；出了这个目录就只剩契约里的名词。
 *
 * 现在只有 ClickHouse（列存表 `<库>.object_entries`：ReplacingMergeTree + JSONExtract 过滤）。
 */
const factories = new Map<ObjectIndexKind, () => ObjectIndex>([["CLICKHOUSE", () => createClickHouseObjectIndex()]]);
const materializedQueryFactories = new Map<ObjectIndexKind, (index: ObjectIndex) => MaterializedQueryExecutor>([
  ["CLICKHOUSE", createClickHouseMaterializedQueryExecutor],
]);

/**
 * 实例缓存挂 `globalThis`：dev 下模块会被反复求值，模块级变量会漏掉上一份实例 ——
 * 和 `@/lib/datasource/sql` 的连接池同一个道理（同一件事只留一份）。
 */
const instances = (() => {
  const holder = globalThis as typeof globalThis & { __ontologyObjectIndexes?: Map<ObjectIndexKind, ObjectIndex> };
  holder.__ontologyObjectIndexes ??= new Map();
  return holder.__ontologyObjectIndexes;
})();

/**
 * 对象索引的入口。**只能服务端使用**（实现里会发 HTTP 到 ClickHouse）；
 * 客户端组件要类型就引用 `@/lib/infrastructure/object-index/types` 里的纯类型。
 */
export function getObjectIndex(kind: ObjectIndexKind = "CLICKHOUSE"): ObjectIndex {
  const cached = instances.get(kind);
  if (cached) return cached;
  const factory = factories.get(kind);
  if (!factory) throw new Error(`还没有 ${kind} 的对象索引实现：实现 ObjectIndex 之后在 @/lib/infrastructure/object-index 的 factories 里登记。`);
  const created = factory();
  instances.set(kind, created);
  return created;
}

/** 查询层注入用的物化查询执行器；上层只认 `MaterializedQueryExecutor` 契约。 */
export function getMaterializedQueryExecutor(kind: ObjectIndexKind = "CLICKHOUSE"): MaterializedQueryExecutor {
  const factory = materializedQueryFactories.get(kind);
  if (!factory) throw new Error(`还没有 ${kind} 的物化查询执行器：实现 MaterializedQueryExecutor 后在 factories 里登记。`);
  return factory(getObjectIndex(kind));
}
