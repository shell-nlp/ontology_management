import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { createClickHouseObjectIndex } from "@/lib/framework/object-index/clickhouse";
import { runObjectIndexContract } from "./contract";

/**
 * 拿真 ClickHouse 跑一遍对象索引的后端契约。
 *
 * **为什么默认会被跳过**：`pnpm test` 不该依赖外部服务（那一批用例是纯的）。
 * vitest 不会把 `.env.local` 灌进 `process.env`，所以没有 `CLICKHOUSE_URL` 时这里只留一条显式跳过的说明；
 * 要真跑就用仓库脚本（先起库：`docker compose up -d clickhouse`）：
 *
 *   pnpm test:object-index       # = node --env-file=.env.local vitest run 这个文件
 *
 * 用例只写随机 target id 的索引行，跑完自己清干净，不会碰你正在用的本体。
 */
const clickHouseUrl = process.env.CLICKHOUSE_URL;

describe("对象索引后端契约（ClickHouse）", () => {
  it.skipIf(!clickHouseUrl)("需要 CLICKHOUSE_URL：用 `pnpm test:object-index` 跑完整契约", () => {
    // 真正的用例由下面的 runObjectIndexContract 注册；这条只是"为什么没跑"的说明。
  });
});

if (clickHouseUrl) {
  runObjectIndexContract({
    label: "ClickHouse",
    kind: "CLICKHOUSE",
    createIndex: () => createClickHouseObjectIndex(),
    targetId: () => `contract-${randomUUID()}`,
  });
}
