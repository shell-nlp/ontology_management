# 0018 对象检索层走 PostgreSQL 索引

记录时间：2026-09-12。状态：已实施（第一层）。

## 背景

平台原先让图库同时承担三件事：对象的权威存储、关系遍历、属性检索。对照 Palantir 的
Ontology 架构（元数据服务 OMS + 对象存储/搜索索引 + 查询编排，图只是其上的应用层 Vertex），
这三件事应当拆开，因为它们的瓶颈和最优存储都不同：

- 权威存储要的是事务、约束、稳定身份、细粒度权限；
- 关系遍历要的是邻接存储与多跳查询；
- 属性检索要的是倒排索引、聚合、全文与模糊匹配。

图数据库把这三件事合在一起，短期最好上手，规模上去后三项都会被拖住。

## 决定

引入**对象检索层**，作为派生索引存在，第一版落在 PostgreSQL：

- 表 `ontology_platform.object_entries`，主键 `(target_id, object_id)`；
- 全文用 `tsvector`（`simple` 配置）+ GIN；
- 模糊与中文子串用 `pg_trgm` + GIN（中文没有词边界，trigram 是这里的主力）；
- 属性过滤用 `jsonb` 与 `jsonb_path_ops` GIN；
- 向量用 `pgvector`，列维度 1536，HNSW 余弦索引；
- 类过滤用 `text[]` + GIN。

索引是**派生数据**：任何时刻都能从已发布快照重建（`POST /api/object-search/reindex`），
所以它坏了不影响本体正确性，重建永远是安全操作。

## 为什么不是 Elasticsearch

Elastic 官方许可 FAQ 明确：7.11 起 Elasticsearch 的源码改为 SSPL 1.0 + Elastic License 2.0 双许可，
2024 年 9 月增加 AGPLv3 作为第三个选项，**但官方发行版仍是 ELv2**。SSPL 不是 OSI 认可的开源许可，
ELv2 禁止把功能作为托管服务对外提供，AGPLv3 对闭源产品的网络使用有传染性。对一个要随闭源产品
交付的平台，这三条都构成分发风险。

可用的替代（Apache-2.0）是 OpenSearch、Apache Solr、Vespa；GPL 系的 Typesense、Manticore，
以及 AGPL 的 ParadeDB 同样有分发风险。

在**当前规模**（对象数在百万以内、且暂时不需要词级中文分词）下，PostgreSQL 自带的全文 + trigram +
jsonb + pgvector 已经覆盖检索需求，同时省掉一整个集群和「PG ↔ 搜索索引」的双写一致性问题。

## 分层职责（本次之后的形态）

| 层 | 存什么 | 现在落在哪 |
| --- | --- | --- |
| 定义层 | 类、关系类型、动作、规则 | 版本快照（`definition.json` + 平台库的版本记录） |
| 实例层 | 对象、关系 | 图库（Neo4j / Apache Jena） |
| 检索层 | 对象的检索副本 | PostgreSQL `object_entries` |

## 能力与降级

- `pg_trgm` 缺失：模糊检索退回 `ILIKE` 全表扫描，全文仍可用（`textMode=fulltext`）。
- `pgvector` 缺失：向量检索直接报错，不静默降级；`capabilities.vector` 如实上报。
- 文本检索的相关度会回传给前端；没有文本通道时 `score` 为 0。
- 大小比较的边界值先校验是数字再进 SQL：非数字的 `GT`/`LT` 会被丢掉，而不是让参数绑定报错。

## 本次没有做的部分

1. **PostgreSQL 还不是对象的权威存储**。对象仍然写在图库，PG 只拿派生副本。要真正换过来，
   前置是 M1（对象身份 = 类 + 主键）与 P1（增量发布）。
2. **前端还没有接检索接口**。接口已可用，对象页的搜索与筛选仍走图库。
3. **没有 embedding 提供方**。向量列、HNSW 索引与向量检索都已就绪并验证过，
   但生成向量需要一个模型服务，目前留空。

## 触发条件：什么时候再往下走

- 对象数到百万级，或发布耗时开始影响使用 → 做 P1 增量发布；
- 开始需要「按属性筛选取数」的批量场景 → 前端接检索接口；
- 需要词级中文分词或千万级聚合 → 评估 OpenSearch（Apache-2.0）作为可重建的派生索引。
