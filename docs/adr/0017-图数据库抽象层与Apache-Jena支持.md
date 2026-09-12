# ADR 0017：图数据库抽象层与 Apache Jena 支持

## 状态

已采纳。

## 背景

平台原先直接依赖 `neo4j-driver`：本体存储表叫 `neo4j_targets`，Cypher 字符串散布在 API 路由里，
发布流程、运行时类型推断和查询工作台都写死了 Neo4j 语义。业务上还需要接入 Apache Jena
（RDF / OWL / SPARQL 1.1），后续还可能接入其它图查询或推理引擎（例如 NetworkX、Elasticsearch）。

如果继续在路由里判断 `if (neo4j)`，每接一个后端都要改一遍上层代码。

## 决策

引入 `src/lib/graph` 作为唯一的图数据库访问层：

- `types.ts` 定义公共契约：`GraphTargetKind`、`GraphTarget`、`GraphData`、`QueryResult`、
  `RuntimeTypeSet`、`GraphStore`，以及各后端的连接表单元数据 `GRAPH_TARGET_KINDS`。
- 每个后端一个适配器实现 `GraphStore`：`neo4j.ts`（Cypher）与 `jena.ts`（SPARQL 1.1）。
- `index.ts` 的 `getGraphStore(target)` 按 `target.kind` 分派。

上层（API 路由、`version-snapshot`、`version-publication`、React 组件）只调用 `GraphStore` 的
语义化方法，不再出现 Cypher 字符串，也不知道底层是属性图还是 RDF。

`GraphStore` 的方法面：

```text
testConnection / containsWriteStatement / execute / queryTemplate
readSchemaGraph / readMeta / readRuntimeTypes / readGraph / readNeighborhood
listEntities / readEntity / searchEntities / listRelationships
exportGraph / replaceGraph / validateDefinition / reconcileStrongRules
```

## 本体存储记录

`ontology_platform.neo4j_targets` 演进为后端无关的 `ontology_platform.graph_targets`，
启动时按 `information_schema` 幂等重命名并补齐 `kind` 与 `options` 列，历史数据保留。

字段划分：`uri`、`database_name`、`username`、`credential_secret` 为所有后端共用；
后端专属配置放 `options`（例如 Jena 的 `namedGraph`、`queryEndpoint`、`updateEndpoint`）。

## Apache Jena 适配

Jena 生产部署通常以 Fuseki 暴露 SPARQL 1.1 HTTP 协议，因此适配器实现为一个 Fuseki 客户端：

- 查询端点执行 SELECT / ASK / CONSTRUCT / DESCRIBE；更新端点执行 SPARQL Update。
- RDF 与属性图映射：`?s rdf:type ?t` → 节点标签；字面量三元组 → 节点属性；
  资源三元组 → 关系；关系属性用 `urn:bkn:Relationship` 具体化表达，并保留直接三元组，
  保证外部 SPARQL 工具仍可按常规方式查询。
- 实体稳定 ID 编码在 IRI 中（`urn:bkn:node:<uuid>`），发布/导出往返时保持不变。
- 工作台的 SELECT 结果按 `?s / ?p / ?o` 约定抽取子图，并补一次补水查询以拿到标签与属性。

能力差异如实上报，不做假装：

- `capabilities.strongRules` 为 `false`：Fuseki 不落地唯一/必填约束，`reconcileStrongRules`
  返回 `{ enforced: false }`；RDF 侧表达这类规则应导出 SHACL 形状，另行校验。
- `capabilities.atomicReplace` 为 `true`：整图替换保证原子（实现见下）。新增后端若做不到，
  必须声明为 `false`，发布流程会据此把失败提示改成「图数据可能已被部分修改」。
- 关系属性无法用三元组直接承载，只能具体化，这是 RDF 数据模型的固有约束。

## 发布原子性与并发

版本管理的状态机、编号、快照格式与哈希都放在平台层，与图库无关；**只有「把快照落到图库」这一步是后端相关的**，
并由 `GraphStore.replaceGraph()` 承担硬性契约：失败时图数据必须保持替换前的状态。

Jena 的落地方式经过实测后确定（Fuseki 5.1 / TDB2）：

- 单个 SPARQL Update 请求是事务性的：请求体里 `CLEAR` 后面出现语法错误时返回 400，且已有的三元组原样未动。
- 因此小快照用「`CLEAR` + `INSERT DATA`」的单请求提交，天然原子；`ADD <影子图> TO DEFAULT` 与
  `MOVE ... TO DEFAULT` 均可用于命名图/默认图的切换。
- 三元组超过 5000 条时，先把数据写进 `urn:bkn:staging:<uuid>` 影子图（这批写入对读取不可见），
  再用一个请求 `CLEAR 目标 ; ADD 影子图 TO 目标 ; DROP 影子图` 原子切换；失败时兜底删除影子图。
  阈值可用目标 `options.singleReplaceLimit` 调整。

并发控制分两层：进程内的按本体存储的 Promise 队列，加上 PostgreSQL 会话级 advisory lock
（`ontology:target:<id>`），保证多实例部署时同一个本体存储不会并发替换。

发布过程写三条审计，便于事后还原现场：`VERSION_PUBLISH_STARTED`（后端类型 + `atomicReplace` + 数量）、
`VERSION_PUBLISHED` / `VERSION_ACTIVATED`、失败时的 `VERSION_PUBLISH_FAILED`（含 `graphReplaced`）。

实测证据：同一次 Jena 发布在 Fuseki 日志里恰好产生 1 个 `POST /ds/update` 请求；把
`singleReplaceLimit` 压到 1 强制走影子图路径时为 2 个请求（1 批写入 + 1 次切换），切换后无残留命名图。
故意用错凭据发布时，接口返回「发布失败，图数据未改动」，Fuseki 三元组数量不变，审计记录 `graphReplaced: false`。

## 影响

- 接入新后端只需：登记 `GraphTargetKind`、补 `GRAPH_TARGET_KINDS` 元数据、新增适配器并在
  `getGraphStore` 注册；API 与界面无需改动。
- 前端「本体存储」按数据库类型分组，连接表单字段由 `GRAPH_TARGET_KINDS` 驱动。
- 查询工作台按本体存储后端切换 Cypher / SPARQL，写入仍然一律禁止，必须走草稿快照 + 发布。
- 本体存储记录写入 PostgreSQL 时统一使用 `graph_targets`，`kind` 列带 `CHECK` 约束。
