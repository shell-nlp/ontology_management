import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { InstanceHistoryChunkEntity, platformRepo } from "@/lib/infrastructure/persistence/postgres";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export type HistoryObject = { objectId: string; entityType: string; primaryKey: Record<string, string>; properties: Record<string, unknown>; title: string; objectRef: string };
export interface HistoryStore {
  write(snapshotId: string, page: number, entityType: string, rows: HistoryObject[]): Promise<void>;
  read(snapshotId: string, page: number): Promise<HistoryObject[]>;
  evict(snapshotId: string): void;
}
const cache = new Map<string, { rows: HistoryObject[]; bytes: number; expires: number }>();
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

function remember(key: string, rows: HistoryObject[], bytes: number) {
  cache.delete(key);
  if (bytes > MAX_CACHE_BYTES) return;
  const size = () => [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (cache.size && size() + bytes > MAX_CACHE_BYTES) cache.delete(cache.keys().next().value!);
  cache.set(key, { rows, bytes, expires: Date.now() + 600_000 });
}

export function getHistoryStore(): HistoryStore {
  return {
    async write(snapshotId, page, entityType, rows) {
      const payload = await compress(Buffer.from(JSON.stringify(rows)));
      const repo = await platformRepo(InstanceHistoryChunkEntity);
      await repo.save({ snapshotId, page, entityType, rows: rows.length, payload, checksum: createHash("sha256").update(payload).digest("hex") });
    },
    async read(snapshotId, page) {
      const key = `${snapshotId}:${page}`;
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return structuredClone(cached.rows);
      cache.delete(key);
      const repo = await platformRepo(InstanceHistoryChunkEntity);
      const chunk = await repo.findOne({ where: { snapshotId, page } });
      if (!chunk) throw new Error("历史快照数据页缺失。");
      if (createHash("sha256").update(chunk.payload).digest("hex") !== chunk.checksum) throw new Error("历史快照数据页校验失败。");
      const raw = await decompress(chunk.payload, { maxOutputLength: 32 * 1024 * 1024 });
      const rows = JSON.parse(raw.toString("utf8")) as HistoryObject[];
      remember(key, rows, raw.length);
      return structuredClone(rows);
    },
    evict(snapshotId) { for (const key of cache.keys()) if (key.startsWith(`${snapshotId}:`)) cache.delete(key); },
  };
}
