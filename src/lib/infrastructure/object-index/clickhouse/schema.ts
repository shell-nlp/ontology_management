import { clickHouseExecute, clickHouseQuery } from "@/lib/infrastructure/object-index/clickhouse/client";
import { clickHouseConfig } from "@/lib/infrastructure/object-index/clickhouse/config";
import { tableName } from "@/lib/infrastructure/object-index/clickhouse/plan";

let schemaPromise: Promise<void> | undefined;

export function linksTable(database: string) {
  return `${database}.object_links`;
}

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
  /*
   * **关系（边）索引**。对象表只存节点，边必须单独一张表：
   * 一条边 = (关系类型, 起点对象键, 终点对象键) + 属性，`link_key` 是这三者的规范化串（唯一键）。
   * 关系类型是双向的，**一条边只存一行**，读的时候两个方向都查（source_key / target_key）。
   * ORDER BY 用 link_key 是为了 ReplacingMergeTree 能按「一条边」去重；
   * 按节点展开靠 source_key / target_key 上的 bloom 跳数索引。
   */
  await clickHouseExecute(`
    CREATE TABLE IF NOT EXISTS ${linksTable(database)}
    (
      target_id            String,
      link_key             String,
      relationship_type    String,
      relationship_type_id String,
      source_key           String,
      target_key           String,
      source_entity_type   String,
      target_entity_type   String,
      source_object_id     String,
      target_object_id     String,
      properties           String,
      version_id           Nullable(String),
      origin               LowCardinality(String) DEFAULT 'SNAPSHOT',
      updated_at           DateTime64(3, 'UTC') DEFAULT now64(3),
      version              DateTime64(9, 'UTC') DEFAULT now64(9),
      INDEX object_links_source_idx source_key TYPE bloom_filter(0.01) GRANULARITY 4,
      INDEX object_links_target_idx target_key TYPE bloom_filter(0.01) GRANULARITY 4,
      INDEX object_links_rel_idx relationship_type TYPE bloom_filter(0.01) GRANULARITY 4
    )
    ENGINE = ReplacingMergeTree(version)
    ORDER BY (target_id, link_key)
  `);
  await clickHouseExecute(`
    CREATE TABLE IF NOT EXISTS ${database}.materialization_manifests
    (
      target_id    String,
      entity_type  String,
      rows         UInt64,
      source_rows  UInt64 DEFAULT 0,
      scanned      UInt64,
      folded       UInt64 DEFAULT 0,
      truncated    UInt8,
      pages        UInt32,
      completed_at DateTime64(3, 'UTC') DEFAULT now64(3),
      version      DateTime64(9, 'UTC') DEFAULT now64(9)
    )
    ENGINE = ReplacingMergeTree(version)
    ORDER BY (target_id, entity_type)
  `);
  // 老表补列（folded 是加"主键折叠必须报数"时加的：1000 行折成 800 个对象要看得见）。
  await clickHouseExecute(`ALTER TABLE ${database}.materialization_manifests ADD COLUMN IF NOT EXISTS folded UInt64 DEFAULT 0`);
  await clickHouseExecute(`ALTER TABLE ${database}.materialization_manifests ADD COLUMN IF NOT EXISTS source_rows UInt64 DEFAULT 0`);
  /*
   * 整份物化的"运行号"：流式物化每页都盖一个标记，收尾凭它清掉"这次没读到的旧行"。
   *
   * **刻意用整数（毫秒时间戳）而不是时间列**：DateTime64 的参数比较要过时区解析 ——
   * 实测 CH 服务器是 `Asia/Shanghai`，而写入用的是 UTC 文本，两边差了 8 小时，
   * prune 一条都没删掉（真踩过）。整数比较没有时区这回事。
   * 默认 0 = 这次改造之前写进去的行，所以第一次整份物化就会把它们清掉。
   */
  await clickHouseExecute(`ALTER TABLE ${tableName(database)} ADD COLUMN IF NOT EXISTS materialized_run UInt64 DEFAULT 0`);
  await clickHouseExecute(`ALTER TABLE ${linksTable(database)} ADD COLUMN IF NOT EXISTS materialized_run UInt64 DEFAULT 0`);
}

export function ensureClickHouseObjectIndexSchema(): Promise<void> {
  schemaPromise ??= ensureSchemaOnce().catch((error) => {
    // 失败不留在缓存里：一次网络抖动不该让这个进程后续的检索全挂。
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}
