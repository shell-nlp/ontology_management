# 0020 对象索引从 PostgreSQL 换到 ClickHouse

记录时间：2026-10-11。状态：已实施（第一版）。

## 背景

- ADR 0018 把对象检索层落在 PostgreSQL（`ontology_platform.object_entries`：`tsvector` + `pg_trgm` + `jsonb` + `pgvector`），定位从第一天就是**派生索引、可重建**。
- 对象实例的数量级会远大于本体定义：行存在这个用途上写放大、聚合与过滤会先顶住。Palantir 的做法是把对象索引放进**专用对象数据库**（OSv1 = Phonograph → OSv2 = Funnel + 专用对象数据库），并明确“索引数据是 ephemeral、权威在数据源”。
- 2026-10-11 用户决定：对象索引用 **ClickHouse**，且 PostgreSQL 里那张索引表可以删掉。

## 决定

1. 对象索引的唯一实现落在 **ClickHouse**（列存表 `<库>.object_entries`，默认库 `ontology_index`）：`ReplacingMergeTree(version)` 按对象键幂等 upsert，读一律带 `FINAL`（同一对象键取最新，发布与增量同步共用一套语义）。
2. 契约与注册表搬到 `src/lib/infrastructure/object-index/`（与 `infrastructure/graph` 同构：契约 + 注册表 + 按后端分目录的适配器）；领域侧只留“快照节点 → 索引条目”的映射（`src/lib/instance/object-index/entries.ts`）。
3. 删掉 PostgreSQL 实现与 `ontology_platform.object_entries`（迁移 `0007-drop-object-entries` 负责 `DROP`），并摘掉对应的 TypeORM 实体与表/字段注释。
4. 上层只认 `ObjectIndex` 契约：换后端 = 新增适配器目录 + 注册表登记一行，域代码 / API / 界面 / AI 工具不动。

## 为什么不选别的

- **Elasticsearch / OpenSearch**：ADR 0018 的许可证顾虑（SSPL / ELv2 / AGPLv3 对闭源分发）仍在；相关性排序、高亮、facets 是它的强项 —— 等出现搜索型需求时再作为**附属**后端加一个适配器。
- **Neo4j 当对象主存**：属性过滤与聚合弱、集群贵。**MongoDB**：聚合与全文两头不讨好。
- **Doris / StarRocks** 与 ClickHouse 同档：国产化或运维偏好不同时可以换，代价只是再写一个适配器。

## 代价与边界

- ClickHouse 没有跨语句事务：`replaceTargetObjects` 是“先删后插”。失败只影响本次发布 —— 索引是派生数据，重新发布或重建索引即可（调用方拿到的错误里会说清是索引层的问题）。
- 向量是**暴力余弦**（`cosineDistance`），没有 ANN 索引；embedding 提供方本身也还没接（见 `docs/待办事项.md` 的 R2）。
- 平台因此**强依赖一个 ClickHouse** 才能做对象检索：没有它时 `capabilities.available=false` 并带原因，对象页检索不可用，但本体定义、版本、图谱不受影响。

## 影响范围

- 新增：`src/lib/infrastructure/object-index/{types,query,index}.ts`、`src/lib/infrastructure/object-index/clickhouse/{config,client,plan,index}.ts`、`tests/lib/object-index/clickhouse.contract.test.ts`、迁移 `0007-drop-object-entries`。
- 移除：`src/lib/instance/object-index/{postgres,sql}.ts`、`ObjectEntryEntity`、`object_entries` 的表 / 列注释、PG 契约测试。
- 环境与部署：`CLICKHOUSE_URL` / `CLICKHOUSE_DATABASE` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`；`docker-compose.yml` 新增 `clickhouse` 服务（`clickhouse:26.9.8.3`，默认 `admin/admin`）。
