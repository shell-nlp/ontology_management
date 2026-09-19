import { describe, expect, it, vi } from "vitest";
import { cachedStructure, type StructureCacheStore } from "@/lib/data-source/structure-cache";
import type { DataSourceCatalogCache } from "@/lib/platform-db";

/** 假的平台库：只在内存里，用来验证"什么时候回源、什么时候回写"。 */
function fakeStore(initial: DataSourceCatalogCache = {}) {
  const state: DataSourceCatalogCache = structuredClone(initial);
  const store: StructureCacheStore = {
    read: async () => structuredClone(state),
    write: async (_sourceId, patch) => {
      state.catalog = { ...state.catalog, ...(patch.catalog ?? {}) };
      state.views = { ...state.views, ...(patch.views ?? {}) };
    },
  };
  return { state, store };
}

describe("cachedStructure", () => {
  it("平台库里有就直接用，不回源库", async () => {
    const { store } = fakeStore({ catalog: { GISTOOLS: { fetchedAt: "2026-09-19T02:00:00.000Z", objects: [{ name: "TB_A" }] } } });
    const fetch = vi.fn(async () => ({ objects: [{ name: "TB_B" }] }));
    const hit = await cachedStructure({ sourceId: "s1", bucket: "catalog", key: "GISTOOLS", fetch, store });
    expect(fetch).not.toHaveBeenCalled();
    expect(hit.fromCache).toBe(true);
    expect(hit.fetchedAt).toBe("2026-09-19T02:00:00.000Z");
    expect((hit.value as { objects: { name: string }[] }).objects).toEqual([{ name: "TB_A" }]);
  });

  it("库里还没有就读一次源库，并把结果写进去（下次不用再读）", async () => {
    const { state, store } = fakeStore();
    const hit = await cachedStructure({ sourceId: "s1", bucket: "catalog", key: "GISTOOLS", fetch: async () => ({ objects: [{ name: "TB_A" }] }), store });
    expect(hit.fromCache).toBe(false);
    expect(state.catalog?.GISTOOLS.objects).toEqual([{ name: "TB_A" }]);
    // 第二次：命中刚写进去的那一份。
    const again = await cachedStructure({ sourceId: "s1", bucket: "catalog", key: "GISTOOLS", fetch: async () => { throw new Error("不该再回源库"); }, store });
    expect(again.fromCache).toBe(true);
  });

  it("refresh=1 一定回源库，并用新结果覆盖旧的那一份", async () => {
    const { state, store } = fakeStore({ catalog: { GISTOOLS: { fetchedAt: "2026-09-19T02:00:00.000Z", objects: [{ name: "TB_A" }] } } });
    const hit = await cachedStructure({ sourceId: "s1", bucket: "catalog", key: "GISTOOLS", refresh: true, fetch: async () => ({ objects: [{ name: "TB_A" }, { name: "TB_B" }] }), store });
    expect(hit.fromCache).toBe(false);
    expect(state.catalog?.GISTOOLS.objects).toHaveLength(2);
  });

  it("字段与样本行走 views 桶，互不干扰：一张表的缓存不会顶掉另一张", async () => {
    const { state, store } = fakeStore();
    await cachedStructure({ sourceId: "s1", bucket: "views", key: "GISTOOLS.TB_A@20", fetch: async () => ({ fields: [{ name: "ID" }], preview: { rows: [] } }), store });
    await cachedStructure({ sourceId: "s1", bucket: "views", key: "GISTOOLS.TB_B@20", fetch: async () => ({ fields: [{ name: "CODE" }], preview: { rows: [] } }), store });
    expect(Object.keys(state.views ?? {}).sort()).toEqual(["GISTOOLS.TB_A@20", "GISTOOLS.TB_B@20"]);
    const a = await cachedStructure<{ fields: { name: string }[] }>({ sourceId: "s1", bucket: "views", key: "GISTOOLS.TB_A@20", fetch: async () => { throw new Error("不该再回源库"); }, store });
    expect(a.value.fields[0].name).toBe("ID");
  });

  it("回源库失败时不写缓存：不能把失败当成新结果存下来", async () => {
    const { state, store } = fakeStore();
    await expect(cachedStructure({ sourceId: "s1", bucket: "catalog", key: "GISTOOLS", fetch: async () => { throw new Error("连不上"); }, store })).rejects.toThrow("连不上");
    expect(state.catalog?.GISTOOLS).toBeUndefined();
  });
});
