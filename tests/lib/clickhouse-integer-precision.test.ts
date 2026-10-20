import { expect, it, vi } from "vitest";
import { clickHouseQuery } from "@/lib/infrastructure/clickhouse/client";

it("ClickHouse 大整数标识不丢精度，普通计数保持 number", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    meta: [{ name: "ID", type: "Nullable(Int64)" }, { name: "total", type: "UInt64" }],
    data: [{ ID: "9007199254740993", total: "23" }],
  }))));
  try {
    const rows = await clickHouseQuery<{ ID: string; total: number }>("SELECT ID, total");
    expect(rows).toEqual([{ ID: "9007199254740993", total: 23 }]);
  } finally {
    vi.unstubAllGlobals();
  }
});
