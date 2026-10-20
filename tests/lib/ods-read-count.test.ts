import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/infrastructure/object-index/clickhouse/client", () => ({ clickHouseQuery: mocks.query, clickHouseExecute: vi.fn() }));
import { createClickHouseOdsStore } from "@/lib/infrastructure/ods/clickhouse";
beforeEach(() => { vi.clearAllMocks(); mocks.query.mockImplementation(async (sql: string) => sql.includes("count()") ? [{ total: 3 }] : [{ ID: "A" }, { ID: "B" }, { ID: "C" }]); });
const query = { sourceId: "source", tableName: "ods_test", columns: ["ID"], filters: [], limit: 2 };
it("交互页可跳过 ODS 全表 COUNT，分页截断仍准确", async () => {
  const result = await createClickHouseOdsStore().read({ ...query, count: false });
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(result.total).toBeNull();
  expect(result.rows).toEqual([{ ID: "A" }, { ID: "B" }]);
  expect(result.truncated).toBe(true);
});
it("显式或默认请求计数时仍返回精确总数", async () => {
  const result = await createClickHouseOdsStore().read(query);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(result.total).toBe(3);
});
