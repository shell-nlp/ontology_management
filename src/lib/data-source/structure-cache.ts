import { clearDataSourceCatalogCache, readDataSourceCatalogCache, writeDataSourceCatalogCache, type DataSourceCatalogCache } from "@/lib/platform-db";

/**
 * 数据资源的结构缓存：**查一次就存进平台库**（`data_sources.catalog`），之后从平台库取。
 *
 * 2026-09-19 用户口径：「不用每次点都真查，建议将这部分保存到数据库中，这样从数据库中取，
 * 只有手动点击刷新的时候才再次去查」。
 *
 * 所以这一层没有 TTL：`refresh=false` 且库里有，就直接返回那一份，**不回源库**；
 * 只有点「刷新结构 / 重新取数」（`refresh=1`）或库里还没有时才真的连过去读。
 * 远端 Oracle 扫一次数据字典要几秒，而结构一天也未必变一次 —— 代价是源库改了结构，
 * 得点一下刷新才看得到，界面上要把"读取于什么时候"写出来。
 */

export type StructureBucket = keyof DataSourceCatalogCache;

export type CachedStructure<T> = { value: T; fetchedAt: string; fromCache: boolean };

/** 读缓存用的最小依赖，默认是平台库；单测里换成假的，就不必连数据库。 */
export type StructureCacheStore = {
  read: (sourceId: string) => Promise<DataSourceCatalogCache>;
  write: (sourceId: string, patch: { catalog?: NonNullable<DataSourceCatalogCache["catalog"]>; views?: NonNullable<DataSourceCatalogCache["views"]> }) => Promise<void>;
};

const platformStore: StructureCacheStore = { read: readDataSourceCatalogCache, write: writeDataSourceCatalogCache };

/**
 * 取结构：命中平台库就拿库里的，否则回源库读一次并写回库里。
 * `fetch` 抛错时**不写缓存**，也不会把上一次的旧值当成新值返回。
 */
export async function cachedStructure<T>(
  input: { sourceId: string; bucket: StructureBucket; key: string; refresh?: boolean; fetch: () => Promise<T>; store?: StructureCacheStore },
): Promise<CachedStructure<T>> {
  const store = input.store ?? platformStore;
  if (!input.refresh) {
    const cache = await store.read(input.sourceId);
    const hit = cache[input.bucket]?.[input.key];
    if (hit) {
      return { value: hit as unknown as T, fetchedAt: hit.fetchedAt, fromCache: true };
    }
  }
  const value = await input.fetch();
  const fetchedAt = new Date().toISOString();
  const entry = input.bucket === "catalog"
    ? { catalog: { [input.key]: { fetchedAt, ...(value as object) } } }
    : { views: { [input.key]: { fetchedAt, ...(value as object) } } };
  await store.write(input.sourceId, entry);
  return { value, fetchedAt, fromCache: false };
}

/** 改了连接信息就把这个数据资源的结构缓存清掉：换了库还拿旧结构就是错的。 */
export async function clearStructureCache(sourceId: string, store: Pick<StructureCacheStore, "write"> = platformStore) {
  if (store === platformStore) return clearDataSourceCatalogCache(sourceId);
  await store.write(sourceId, { catalog: {}, views: {} });
}
