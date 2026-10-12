import {
  clickHouseArrayParam,
  clickHouseExecute,
  clickHouseQuery,
  type ClickHouseParams,
} from "@/lib/framework/object-index/clickhouse/client";
import { clickHouseConfig, CLICKHOUSE_EMBEDDING_DIM } from "@/lib/framework/object-index/clickhouse/config";
import { planClickHouseSearch, tableName } from "@/lib/framework/object-index/clickhouse/plan";
import { chunked } from "@/lib/framework/object-index/query";
import type {
  ObjectIndex,
  ObjectIndexCapabilities,
  ObjectIndexEntry,
  ObjectIndexMaterialization,
  ObjectIndexOrigin,
  ObjectIndexStats,
  ObjectIndexSyncResult,
  ObjectSearchHit,
  ObjectSearchQuery,
  ObjectSearchResult,
} from "@/lib/framework/object-index/types";

/**
 * 对象检索索引的 ClickHouse 实现（列存）。
 *
 * 三个关键取舍，改之前先读：
 * 1. **索引是派生数据**：任何时刻可以从数据源与已发布快照重建，所以 `replaceTargetObjects`
 *    是"先删后插"而不是事务 —— ClickHouse 本来也没有跨语句事务。删到一半失败只影响这次发布，
 *    重新发布或重建索引即可（调用方拿到的错误里会说清是索引层的问题）。
 * 2. **读一律带 `FINAL`**：表引擎是 `ReplacingMergeTree(version)`，同一对象键多次写入靠
 *    "版本更大的赢"去重，而 CH 的合并是后台异步的 —— 不加 `FINAL` 就会读到旧行或重复行。
 *    `version` 由列默认值 `now64(9)` 生成，纳秒级，连续两次同步不会撞上同一个版本。
 * 3. **内容列存 JSON 文本**：`properties` / `primary_key` 存 JSON 字符串，过滤走 `JSONExtract*`。
 *    这样对象类型的属性是"数据"而不是"表结构"—— 加一个属性不需要改 DDL（PG 那版用 jsonb 同理）。
 */
const INSERT_CHUNK = 500;
/**
 * 一次 prune 删除里塞多少个对象键。
 * **键是拼进 URL 参数的**，而 ClickHouse 对表单字段值有上限（Poco 的 Field value too long）：
 * 2026-10-12 物化 `专线产品用户` 1688 条时，一整批 key URL-encode 之后冲破了它、HTTP 500。
 * 200 个键 encode 完约 20KB，离上限很远。
 */
const PRUNE_DELETE_CHUNK = 200;

let schemaPromise: Promise<void> | undefined;

async function ensureSchemaOnce(): Promise<void> {
  const { database } = clickHouseConfig();
  const table = tableName(database);
  // 库由 compose 的 clickhouse 服务建好；这里只兜底（已有库时是空操作，缺权限且有库也不报错）。
  const exists = await clickHouseQuery<{ n: number }>("SELECT count() AS n FROM system.databases WHERE name = {name:String}", {
    params: { name: database },
  });
  if (!Number(exists[0]?.n ?? 0)) {
    await clickHouseExecute(`CREATE DATABASE IF NOT EXISTS ${database}`);
  }
  await clickHouseExecute(`
    CREATE TABLE IF NOT EXISTS ${table}
    (
      target_id     String,
      object_key    String,
      object_id     String,
      entity_type   String,
      labels        Array(String),
      title         String,
      properties    String,
      primary_key   String,
      search_text   String,
      embedding     Array(Float32),
      version_id    Nullable(String),
      origin        LowCardinality(String) DEFAULT 'SNAPSHOT',
      updated_at    DateTime64(3, 'UTC') DEFAULT now64(3),
      version       DateTime64(9, 'UTC') DEFAULT now64(9),
      INDEX object_entries_labels_idx labels TYPE bloom_filter(0.01) GRANULARITY 4,
      INDEX object_entries_text_idx search_text TYPE tokenbf_v1(4096, 3, 0) GRANULARITY 1,
      INDEX object_entries_title_idx title TYPE tokenbf_v1(4096, 3, 0) GRANULARITY 1
    )
    ENGINE = ReplacingMergeTree(version)
    ORDER BY (target_id, object_key)
  `);
  // 老表补列（origin 是 2026-10-12 加的：手工/动作建的对象与整份物化的对象必须分得清）。
  await clickHouseExecute(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS origin LowCardinality(String) DEFAULT 'SNAPSHOT'`);
  /*
   * 物化清单：**半份必须报数**。每个对象类型最近一次整份物化的结果都记一行（撞上限被截断也要如实写），
   * 对象页与查询警告都读它 —— 不然"只物化了 100 条"会被看成"这个类型只有 100 个对象"。
   */
  await clickHouseExecute(`
    CREATE TABLE IF NOT EXISTS ${database}.materialization_manifests
    (
      target_id    String,
      entity_type  String,
      rows         UInt64,
      scanned      UInt64,
      truncated    UInt8,
      pages        UInt32,
      completed_at DateTime64(3, 'UTC') DEFAULT now64(3),
      version      DateTime64(9, 'UTC') DEFAULT now64(9)
    )
    ENGINE = ReplacingMergeTree(version)
    ORDER BY (target_id, entity_type)
  `);
}

export function ensureClickHouseObjectIndexSchema(): Promise<void> {
  schemaPromise ??= ensureSchemaOnce().catch((error) => {
    // 失败不留在缓存里：一次网络抖动不该让这个进程后续的检索全挂。
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

type EntryRow = {
  object_id: string;
  entity_type: string;
  object_key: string;
  labels: string[];
  title: string;
  properties: string;
  primary_key: string;
  search_text: string;
  score?: number;
};

function parseJsonObject<T extends Record<string, unknown>>(text: string, fallback: T): T {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as T;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function toEntry(row: EntryRow): ObjectIndexEntry {
  return {
    objectId: row.object_id,
    entityType: row.entity_type ?? "",
    objectKey: row.object_key ?? "",
    labels: row.labels ?? [],
    title: row.title ?? "",
    properties: parseJsonObject<Record<string, unknown>>(row.properties, {}),
    primaryKey: parseJsonObject<Record<string, string>>(row.primary_key, {}),
    searchText: row.search_text ?? "",
  };
}

function insertLines(targetId: string, entries: readonly ObjectIndexEntry[], versionId: string | null, origin: ObjectIndexOrigin) {
  return entries
    .map((entry) =>
      JSON.stringify({
        target_id: targetId,
        object_key: entry.objectKey || `id:${entry.objectId}`,
        object_id: entry.objectId,
        entity_type: entry.entityType,
        labels: entry.labels,
        title: entry.title,
        properties: JSON.stringify(entry.properties ?? {}),
        primary_key: JSON.stringify(entry.primaryKey ?? {}),
        search_text: entry.searchText ?? "",
        embedding: entry.embedding ?? [],
        version_id: versionId,
        origin,
      }),
    )
    .join("\n");
}

async function insertEntries(targetId: string, entries: readonly ObjectIndexEntry[], versionId: string | null, origin: ObjectIndexOrigin) {
  if (!entries.length) return 0;
  const { database } = clickHouseConfig();
  for (const chunk of chunked(entries, INSERT_CHUNK)) {
    await clickHouseExecute(
      `INSERT INTO ${tableName(database)}
        (target_id, object_key, object_id, entity_type, labels, title, properties, primary_key, search_text, embedding, version_id, origin)
       FORMAT JSONEachRow
       ${insertLines(targetId, chunk, versionId, origin)}`,
    );
  }
  return entries.length;
}

async function countTarget(targetId: string) {
  const { database } = clickHouseConfig();
  const rows = await clickHouseQuery<{ n: number }>(
    `SELECT count() AS n FROM ${tableName(database)} FINAL WHERE target_id = {target:String}`,
    { params: { target: targetId } },
  );
  return Number(rows[0]?.n ?? 0);
}

/** 只数某一来源（SNAPSHOT / MATERIALIZED）的条数：prune 与替换都以来源为界。 */
async function countOrigin(targetId: string, origin: ObjectIndexOrigin) {
  const { database } = clickHouseConfig();
  const rows = await clickHouseQuery<{ n: number }>(
    `SELECT count() AS n FROM ${tableName(database)} FINAL WHERE target_id = {target:String} AND origin = {origin:String}`,
    { params: { target: targetId, origin } },
  );
  return Number(rows[0]?.n ?? 0);
}

/** 只数某个对象类型 + 某一来源的条数（按类型 prune 时用）。 */
async function countTypeOrigin(targetId: string, entityType: string, origin: ObjectIndexOrigin) {
  const { database } = clickHouseConfig();
  const rows = await clickHouseQuery<{ n: number }>(
    `SELECT count() AS n FROM ${tableName(database)} FINAL
      WHERE target_id = {target:String} AND entity_type = {type:String} AND origin = {origin:String}`,
    { params: { target: targetId, type: entityType, origin } },
  );
  return Number(rows[0]?.n ?? 0);
}

/** 删除（轻量 DELETE）。`mutations_sync=1` 让删除在返回前完成，否则紧接着的统计会读到旧行。 */
async function deleteWhere(targetId: string, objectKeys: string[] | null, origin?: ObjectIndexOrigin, entityType?: string) {
  const { database } = clickHouseConfig();
  const params: ClickHouseParams = { target: targetId };
  let condition = "target_id = {target:String}";
  if (origin) {
    params.origin = origin;
    condition += " AND origin = {origin:String}";
  }
  if (entityType) {
    params.type = entityType;
    condition += " AND entity_type = {type:String}";
  }
  if (objectKeys) {
    if (!objectKeys.length) return;
    params.keys = clickHouseArrayParam(objectKeys);
    condition += " AND object_key IN {keys:Array(String)}";
  }
  await clickHouseExecute(`DELETE FROM ${tableName(database)} WHERE ${condition}`, {
    params,
    settings: { mutations_sync: "1" },
  });
}

async function readObject(targetId: string, objectKey: string): Promise<ObjectIndexEntry | null> {
  await ensureClickHouseObjectIndexSchema();
  const { database } = clickHouseConfig();
  const rows = await clickHouseQuery<EntryRow>(
    `SELECT object_id, entity_type, object_key, labels, title, properties, primary_key, search_text
       FROM ${tableName(database)} FINAL
      WHERE target_id = {target:String} AND object_key = {key:String}
      LIMIT 1`,
    { params: { target: targetId, key: objectKey } },
  );
  return rows[0] ? toEntry(rows[0]) : null;
}

/**
 * 删掉「这一批之外」的对象键（prune），返回删掉的条数。
 *
 * **键绝不进 URL 参数**：以前把整批 key 拼成一个 `param_keys`，几千个键 URL-encode 之后会超过
 * ClickHouse 的表单字段上限（`Field value too long`，2026-10-12 真 500 过）。现在反过来做：
 * 先把现存的键读回来（只读键、不读整行），本地算差集，再分小块按 `object_key IN (…)` 删。
 */
async function pruneNotIn(targetId: string, keepKeys: string[], origin: ObjectIndexOrigin, entityType?: string) {
  const { database } = clickHouseConfig();
  const params: ClickHouseParams = { target: targetId, origin };
  let condition = "target_id = {target:String} AND origin = {origin:String}";
  if (entityType) {
    params.type = entityType;
    condition += " AND entity_type = {type:String}";
  }
  const rows = await clickHouseQuery<{ object_key: string }>(
    `SELECT object_key FROM ${tableName(database)} FINAL WHERE ${condition}`,
    { params },
  );
  const keep = new Set(keepKeys);
  const doomed = rows.map((row) => row.object_key).filter((key) => key && !keep.has(key));
  for (const chunk of chunked(doomed, PRUNE_DELETE_CHUNK)) {
    await deleteWhere(targetId, chunk, origin, entityType);
  }
  return doomed.length;
}

async function searchObjects(query: ObjectSearchQuery): Promise<ObjectSearchResult> {
  await ensureClickHouseObjectIndexSchema();
  const { database } = clickHouseConfig();
  const plan = planClickHouseSearch(query, { vector: true }, database);
  const started = Date.now();
  const [hitRows, countRows] = await Promise.all([
    clickHouseQuery<EntryRow>(plan.hits.sql, { params: plan.hits.params }),
    clickHouseQuery<{ total: number }>(plan.count.sql, { params: plan.count.params }),
  ]);
  const hits: ObjectSearchHit[] = hitRows.map((row) => ({
    objectId: row.object_id,
    entityType: row.entity_type ?? "",
    objectKey: row.object_key ?? "",
    labels: row.labels ?? [],
    title: row.title ?? "",
    properties: parseJsonObject<Record<string, unknown>>(row.properties, {}),
    primaryKey: parseJsonObject<Record<string, string>>(row.primary_key, {}),
    score: Number(row.score ?? 0),
  }));
  return {
    hits,
    total: Number(countRows[0]?.total ?? 0),
    tookMs: Date.now() - started,
    textMode: plan.textMode,
    vectorUsed: plan.vectorUsed,
  };
}

async function stats(targetId: string): Promise<ObjectIndexStats> {
  await ensureClickHouseObjectIndexSchema();
  const { database } = clickHouseConfig();
  const table = tableName(database);
  const [entries, labels, latest] = await Promise.all([
    countTarget(targetId),
    clickHouseQuery<{ label: string; count: number }>(
      `SELECT label, count() AS count FROM (
         SELECT arrayJoin(labels) AS label FROM ${table} FINAL WHERE target_id = {target:String}
       ) GROUP BY label ORDER BY count DESC, label ASC`,
      { params: { target: targetId } },
    ),
    clickHouseQuery<{ updated_at: string }>(
      `SELECT formatDateTime(max(updated_at), '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS updated_at
         FROM ${table} FINAL WHERE target_id = {target:String}`,
      { params: { target: targetId } },
    ),
  ]);
  return {
    entries,
    byLabel: labels.map((row) => ({ label: row.label, count: Number(row.count) })),
    // 空集时 max(updated_at) 是 1970 纪元值：那不是"更新时间"，要当没有。
    updatedAt:
      latest[0]?.updated_at && latest[0].updated_at.length && !latest[0].updated_at.startsWith("1970-01-01T00:00:00")
        ? latest[0].updated_at
        : null,
  };
}

export function createClickHouseObjectIndex(): ObjectIndex {
  return {
    kind: "CLICKHOUSE",
    async syncTargetObjects(targetId, entries, options): Promise<ObjectIndexSyncResult> {
      await ensureClickHouseObjectIndexSchema();
      const versionId = options?.versionId ?? null;
      const origin: ObjectIndexOrigin = options?.origin ?? "SNAPSHOT";
      const upserted = await insertEntries(targetId, entries, versionId, origin);
      let deleted = 0;
      if (options?.prune) {
        /*
         * `pruneLabel` = 只在这个对象类型里 prune。整份物化是「一个类型一批」，不收窄的话
         * 物化 A 会把 B 的物化数据一起删掉（2026-10-12 真踩过：物化 `集团成员` 之后，
         * `专线产品用户` / `个人用户` 的物化数据全没了，对象页与图谱看起来就是空的）。
         */
        const label = options.pruneLabel;
        const keys = entries.map((entry) => entry.objectKey || `id:${entry.objectId}`);
        if (!keys.length) {
          // 这一批是空的 = 这个范围不该有对象了，整段清掉。
          deleted = label ? await countTypeOrigin(targetId, label, origin) : await countOrigin(targetId, origin);
          await deleteWhere(targetId, null, origin, label);
        } else {
          deleted = await pruneNotIn(targetId, keys, origin, label);
        }
      }
      return { upserted, deleted, total: await countTarget(targetId) };
    },
    readObject,
    async deleteObjects(targetId, objectKeys) {
      const keys = [...new Set(objectKeys.map((key) => key?.trim()).filter(Boolean))];
      if (!keys.length) return 0;
      await ensureClickHouseObjectIndexSchema();
      const { database } = clickHouseConfig();
      let deleted = 0;
      for (const chunk of chunked(keys, INSERT_CHUNK)) {
        const rows = await clickHouseQuery<{ n: number }>(
          `SELECT count() AS n FROM ${tableName(database)} FINAL
            WHERE target_id = {target:String} AND object_key IN {keys:Array(String)}`,
          { params: { target: targetId, keys: clickHouseArrayParam(chunk) } },
        );
        deleted += Number(rows[0]?.n ?? 0);
        await deleteWhere(targetId, chunk);
      }
      return deleted;
    },
    async deleteTypeObjects(targetId, entityType, options) {
      await ensureClickHouseObjectIndexSchema();
      const { database } = clickHouseConfig();
      const origin = options?.origin;
      const params: ClickHouseParams = { target: targetId, type: entityType };
      let condition = "target_id = {target:String} AND entity_type = {type:String}";
      if (origin) {
        params.origin = origin;
        condition += " AND origin = {origin:String}";
      }
      const rows = await clickHouseQuery<{ n: number }>(
        `SELECT count() AS n FROM ${tableName(database)} FINAL WHERE ${condition}`,
        { params },
      );
      const deleted = Number(rows[0]?.n ?? 0);
      if (deleted) {
        await clickHouseExecute(`DELETE FROM ${tableName(database)} WHERE ${condition}`, {
          params,
          settings: { mutations_sync: "1" },
        });
      }
      return deleted;
    },
    async deleteOriginObjects(targetId, origin) {
      await ensureClickHouseObjectIndexSchema();
      const deleted = await countOrigin(targetId, origin);
      if (deleted) await deleteWhere(targetId, null, origin);
      return deleted;
    },
    async replaceTargetObjects(targetId, entries, options) {
      await ensureClickHouseObjectIndexSchema();
      const origin: ObjectIndexOrigin = options?.origin ?? "SNAPSHOT";
      // 只替换这一来源的整份：发布 / 重建索引不许把整份物化的数据清掉。
      await deleteWhere(targetId, null, origin);
      const indexed = await insertEntries(targetId, entries, options?.versionId ?? null, origin);
      return { indexed };
    },
    searchObjects,
    async deleteTargetObjects(targetId) {
      await ensureClickHouseObjectIndexSchema();
      await deleteWhere(targetId, null);
      // 清单是"这个本体存储的物化状态"，索引清了它也要清：否则会留着一条"已物化 100 条"的假状态。
      const { database } = clickHouseConfig();
      await clickHouseExecute(`DELETE FROM ${database}.materialization_manifests WHERE target_id = {target:String}`, {
        params: { target: targetId },
        settings: { mutations_sync: "1" },
      });
    },
    stats,
    async listMaterializations(targetId) {
      await ensureClickHouseObjectIndexSchema();
      const { database } = clickHouseConfig();
      const rows = await clickHouseQuery<{
        entity_type: string;
        rows: number;
        scanned: number;
        truncated: number;
        pages: number;
        completed_at: string;
      }>(
        `SELECT entity_type, rows, scanned, truncated, pages,
                formatDateTime(completed_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS completed_at
           FROM ${database}.materialization_manifests FINAL
          WHERE target_id = {target:String}
          ORDER BY entity_type ASC`,
        { params: { target: targetId } },
      );
      return rows.map((row) => ({
        targetId,
        entityType: row.entity_type,
        rows: Number(row.rows ?? 0),
        scanned: Number(row.scanned ?? 0),
        truncated: Boolean(Number(row.truncated ?? 0)),
        pages: Number(row.pages ?? 0),
        completedAt: row.completed_at,
      }));
    },
    async saveMaterialization(record) {
      await ensureClickHouseObjectIndexSchema();
      const { database } = clickHouseConfig();
      await clickHouseExecute(
        `INSERT INTO ${database}.materialization_manifests (target_id, entity_type, rows, scanned, truncated, pages) FORMAT JSONEachRow
         ${JSON.stringify({
           target_id: record.targetId,
           entity_type: record.entityType,
           rows: record.rows,
           scanned: record.scanned,
           truncated: record.truncated ? 1 : 0,
           pages: record.pages,
         })}`,
      );
    },
    async deleteMaterialization(targetId, entityType) {
      await ensureClickHouseObjectIndexSchema();
      const { database } = clickHouseConfig();
      await clickHouseExecute(
        `DELETE FROM ${database}.materialization_manifests WHERE target_id = {target:String} AND entity_type = {type:String}`,
        { params: { target: targetId, type: entityType }, settings: { mutations_sync: "1" } },
      );
    },
    async capabilities(): Promise<ObjectIndexCapabilities> {
      try {
        await ensureClickHouseObjectIndexSchema();
        await clickHouseQuery("SELECT 1");
        return {
          available: true,
          fullText: true,
          trigram: true,
          vector: true,
          embeddingDim: CLICKHOUSE_EMBEDDING_DIM,
        };
      } catch (error) {
        return {
          available: false,
          fullText: false,
          trigram: false,
          vector: false,
          embeddingDim: null,
          reason: error instanceof Error ? error.message : "对象检索索引不可用。",
        };
      }
    },
  };
}
