# 0019 整体移除 Neo4j，只保留 Apache Jena

记录时间：2026-09-14。状态：已实施。取代 0017 里"两个后端并列"的部分。

## 背景

0017 把图数据访问抽象成 `GraphStore`，并实现了 Neo4j 与 Apache Jena 两个适配器，当时是并列关系。
2026-09-13 先把 Neo4j 从**前端**下线（不再出现在「选择图数据库类型」与新建本体的存储下拉里），
适配器与已登记记录继续保留，理由是"等实际用量或维护成本给出信号再定"。

信号已经出现，而且指向同一个方向：

- **能力对不上。** 本平台的核心是类层级、元模型与推理——Jena 侧发布时写 `rdfs:subClassOf`、
  读路径做类型传播（M3），Neo4j 侧没有等价实现，要补就得自建 `(:Class)` 节点并解决元模型与实例的隔离。
- **隔离方式对不上。** Neo4j 社区版一个库只能装一个本体，多本体要靠"多起一套实例"；
  而 Jena 用命名图就能在一个 Fuseki 上并存任意多个本体，直接匹配平台「本体是一等公民」的形态。
- **许可。** Apache Jena 是 Apache-2.0；Neo4j Community 是 GPL-3.0（企业版为商业许可），
  随闭源产品分发要额外履行 GPLv3 义务。
- **维护成本。** 两个后端意味着每条读路径、每次发布、每个新特性都要写两遍并各测一遍，
  而 Neo4j 这一侧在实际使用中已经不出现在界面上。

## 决定

**整体移除 Neo4j**，平台只保留 Apache Jena 一个图后端。

具体做法：

- 删掉适配器与测试 `src/lib/graph/neo4j.ts`、`src/lib/graph/neo4j.test.ts`，
  以及为多实例方案写的 `scripts/neo4j-instance.ps1`。
- 从 `package.json` 移除 `neo4j-driver`，`next.config.ts` 的 `serverExternalPackages` 同步去掉它。
- 类型收窄：`GraphTargetKind = "JENA"`、`QueryLanguage = "sparql"`、`GRAPH_TARGET_KINDS` 只剩 Jena 一项。
  `getGraphStore` 只有一个分支；`FRONTEND_GRAPH_TARGET_KINDS` 保留为 `GRAPH_TARGET_KINDS` 的别名，
  让调用点的语义不变。`retiredGraphTargetKinds()` 与「已下线」分组删除。
- 界面：存储资源页只剩 Jena 分组；新建本体存储因为只有一个引擎，直接进连接表单；
  图谱页的查询工作台固定 SPARQL；本体草稿页的「复制显示样式」（Neo4j Browser GraSS）按钮删除。
- 行为：`createOntology` 不再需要「资源被占用」的判断——隔离由每个本体独占的命名图承担
  （`urn:ontology:<本体 id>`）。`/api/query` 去掉遗留的 `cypher` 入参别名。

## 两条有意保留的东西

1. **`neo4j_targets` → `graph_targets` 的改名迁移留着。** 它服务的是老部署升级，和历史引擎无关；
   删掉会让升级上来的库找不到本体存储表。
2. **不认识 `kind` 的记录直接跳过，不回退。** `getTarget` / `listTargets` 只返回受支持引擎的行，
   避免拿错后端去连（旧行为是回退成默认引擎）。要清理残留行就手写
   `DELETE FROM ontology_platform.graph_targets WHERE kind NOT IN ('JENA');`。

## 对 0017 的影响

0017 的抽象层结论仍然成立，且正是这次移除能干净落地的前提：适配器契约（`GraphStore`）、
连接表单元数据（`GRAPH_TARGET_KINDS`）、发布流程的原子替换契约都没有因为移除而改动，
只是"两个实现"变成"一个实现"。将来接入别的后端（NetworkX、Elasticsearch 等）仍然是在
`GRAPH_TARGET_KINDS` 登记 + 写一个适配器 + 在 `getGraphStore` 注册三步。

0017 里描述 Neo4j 的段落（适配器实现、Cypher 工作台、`neo4j-instance.ps1`）以本文为准。