# AGENTS.md

## Git 约定
- 禁止使用 `git worktree`（含 `git worktree add/list/remove`）。不要创建多余的工作目录或把分支检出到别处。
- 所有分支变更（新建、切换、合并）都在本仓库目录 `D:\project\ontology_management` 内通过常规 `git checkout` / `git branch` / `git merge` 完成。
- 不要替用户提交：改动实现并验证后留在工作区，提交由用户自己执行（2026-09-11 明确要求）。

## 依赖与实现原则
- 优先直接使用知名、成熟的库或现成组件，非必要不重复造轮子。只有现有库/组件确实不满足业务需求时，才自行实现，并在代码中说明理由。

## 术语约定

**界面文本用 Palantir 的全称，两层结构各一套词，不混用。**

- **类型层**：**对象类型**（= Palantir 的 Object Type）、**关系类型**（= Link Type）
- **实例层**：**对象**（= Object）、**关系**（= Link）
- **「类」= 对象类型，只是口头简称**：对话和代码注释里可以写「类」，但**界面上不写「类」**，一律写「对象类型」。
  例外是复合词——父类 / 子类 / 分类 / 类型 等，按汉语习惯保留。
- 「关系」**不是**「关系类型」的短称——指类型时必须写全「关系类型」，因为「关系」已经是实例层的词。
- 与 Palantir 文档对齐时写成「对象类型（Object Type）」，不要在同一处来回切换两种叫法。

记录时间：2026-09-13。界面上的并列名词是 **对象类型 · 对象 · 关系类型 · 关系 · 动作**：

| 主术语 | 同义写法 / 出处 | 代码里的名字 | 含义 |
| --- | --- | --- | --- |
| 对象类型 | 口语简称「类」；Palantir 的 Object Type | `entityTypes` | 一组对象的定义：属性、主键、展示属性、父类、数据来源 |
| 对象 | 实例；Palantir 的 Object / object instance | 图里的节点 | 类的一个具体实例，例如「张三」 |
| 关系类型 | 链接类型；Palantir 的 Link Type | `relationshipTypes` | 两个对象类型之间的关系的定义 |
| 关系 | 链接；Palantir 的 Link | 图里的边 | 两个具体对象之间的一条关系 |
| 动作 | 行动；Palantir 的 Action Type | `actionTypes` | 定义在某个类上的一组写操作 |
| 规则 | Palantir 的 submission criteria | `rules` | 挂在动作上的拦截与提示 |
| 数据资源 | 数据源；Palantir 的 datasource | `data_sources` | 业务数据在哪（Oracle / PostgreSQL / …）；与「本体存储」是两件事 |
| 本体存储 | 图数据库连接 | `graph_targets` | 本体（实例层）存在哪个图库里 |

两点提醒：

1. `entityTypes` 这个字段名是历史原因，读代码时一律理解成「类」，不要因为它叫 entity 就把它当成「实体」另一个概念。
2. 「对象类型」不等于「标签」。它在 Neo4j 里落成节点标签、在 Jena 里落成 `rdf:type` 的宾语，那只是它在图库里的形态；
   它本身是带属性、主键、父类与数据来源的定义（见「本体核心模型」一节）。

## 验证约定
- 日常验证统一使用 `pnpm dev` 启动开发服务，在开发服务上进行页面与交互测试。
- 不运行 `pnpm build`；只有明确要求时才执行生产构建验证。

## 待办计划（Backlog）

**执行约定：本清单默认只是记录，不主动实施。** 只有用户在对话中明确点名某一项（或明确说“按待办计划做”）时才动手；动手前先确认该项范围与验收方式。完成后从本清单移除，并在提交信息里写清对应编号。

记录时间：2026-09-11。编号只作引用，不代表优先级排序。

### 发布与版本管理

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| P1 | 增量发布 | 每次发布都是整图替换：Neo4j `DETACH DELETE` + 重建，Jena 清空 + 重写 | 快照与当前图做 diff，只写增删改；`GraphStore` 增加 `applyDelta` 能力，版本里记录基线版本 |
| P2 | 大图导出流式化 | `exportGraph()` 全量进内存（Jena 单条 `SELECT ?s ?p ?o`，Neo4j `MATCH (n)`），快照写入也一次性构造 | 分页/游标导出（Jena 按主语分页、Neo4j 用分批 `LIMIT`），快照写入改流式 |
| P3 | 版本状态机补 `PUBLISHING` | 图库替换成功而版本状态更新失败时，只能靠审计 `VERSION_PUBLISH_FAILED` 事后诊断 | 发布前写 `PUBLISHING`，成功后转 `PUBLISHED`；失败态在前端提供“重新发布以恢复一致” |
| P4 | 本体存储 `kind` 变更的历史版本策略 | 快照后端无关，改 `kind` 后老版本仍能发布，目前没有任何提示 | 明确产品决定：允许（加提示并记录审计）或禁止（有版本时锁定 kind） |
| P5 | `/api/ontology/:versionId` 的 GET / DELETE | README 接口表写了 `GET/PATCH/DELETE`，路由只实现了 `PATCH` | 补 GET/DELETE（已发布版本禁止删除）或改 README 对齐实现 |

### 图数据库适配层

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| G1 | Jena 强约束（SHACL） | `capabilities.strongRules` 为 `false`，唯一/必填不落地，只如实上报 | 发布时按本体定义导出 SHACL 形状并校验，校验结果并入发布前检查 |
| G2 | 关系属性在 RDF 侧的存储放大 | 每条关系固定 5 条结构三元组，属性另计；数据量大时体积明显 | 评估 RDF-star（`<<s p o>>`）或只对带属性的关系具体化 |
| G3 | Jena 读路径请求数 | `hydrateNodes` / `readEdges` 每 200 个主语一次往返，大子图多轮请求 | 调大批次或改为一次 `CONSTRUCT` / 大 `VALUES` 取子图 |
| G4 | 新增后端的契约测试模板 | 目前只有 ADR 0017 的文字说明；Jena 有单测，但没有通用的适配器契约用例 | 抽出契约测试（连接、读写、导出、原子替换、失败后图不变），新后端按模板补齐 |

| G5 | 后端定位与许可 | 两个后端功能对等、界面上并列；但 Apache Jena 是 Apache-2.0，Neo4j Community 是 **GPL-3.0**（企业版为商业许可）——随产品分发 Neo4j 需要履行 GPLv3 义务（平台只是客户端，连接方式本身不传染） | Jena 作为**推理、元模型、多本体隔离**的默认推荐后端（Fuseki 用命名图/多数据集隔离，不必像 Neo4j 那样起多个实例）；Neo4j 定位为「实例存储 + 高性能遍历」，适合已有环境与深链场景（Fuseki/TDB2 是单机，SPARQL 深链慢）。**暂不删除**，等实际用量或维护成本给出信号再定。2026-09-13 决定：**Neo4j 已从前端下线**——不再出现在「选择图数据库类型」与「新建本体」的存储下拉里（`FRONTEND_GRAPH_TARGET_KINDS` / `isFrontendGraphTargetKind`，见 `src/lib/graph/types.ts`）；后端适配器 `src/lib/graph/neo4j.ts` 与接口保留，已登记的 Neo4j 记录在「存储资源」页单独归到「已下线」组，仍可查看 / 测试 / 编辑 / 删除 |

| G6 | Neo4j 侧的类层级 | Jena 已落地「发布写 `rdfs:subClassOf` + 读路径类型传播」，Neo4j 没有等价实现 | 若 Neo4j 重新上架才做：自建 `(:Class)` 节点保存层级并让读路径按层级展开；难点是元模型节点与实例节点的隔离（同 G5）。当前已从前端下线，暂不投入 |

### 本体核心模型

记录时间：2026-09-12。对照的是 Palantir Ontology 的 object type / object 关系：
object type 是 schema 定义（属性、主键、标题、backing datasource），object 是它的一个实例，
对象身份是 (object type, primary key)，用户的编辑、对象间的链接、权限都挂在这个身份上。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| M1 | 对象身份 = (类, 主键) | 发布时对象身份取快照节点 id（临时写成 `__ontology_id`，发布后移除），`sources[].primaryKey` 只用于来源绑定校验与多来源（MDO）按列合并；图上的唯一约束来自属性自己的 `unique` / `indexed` 标志（`neo4j.ts` 的 `applyStrongRules`），不看 `sources[].primaryKey` | 让主键成为对象的真实身份：发布与动作写入都用 `sources[0].primaryKey` 生成稳定 id，按主键建唯一约束，读路径与动作引用改按主键定位。是 D1 的前置依赖 |
| M2 | 接口（interfaces） | 完全没有 | Palantir 用接口表达共享能力与多继承：接口是抽象的、不能被直接实例化，object type 实现接口后按接口被消费，链接与动作也能定义在接口上。工作量在定义层语义（接口定义、类实现、属性/链接/动作的继承与覆盖）加图库落地方式，建议先出 ADR 再实现。参考 https://palantir.com/docs/foundry/interfaces/interface-overview/ |

**M3（类层级与类型传播，第一档推理）已于 2026-09-13 完成（Jena 侧）**，记录如下：

- 发布时按定义写元模型：每个类声明 `owl:Class`，有 `parents` 的写 `rdfs:subClassOf`，关系类型写 `rdfs:domain` / `rdfs:range`（`jena.ts` 的 `schemaStatements`，纯函数、有单测）。
- 元模型与实例隔离：类声明同时盖 `urn:bkn:Class`、关系类型盖 `urn:bkn:Property`，所有实例级查询用 `NOT_META_SUBJECT` 统一排除。没有这一步，类会混进对象数、对象类型分布、标签清单与整图导出。
- 读路径做类型传播：图库侧用 `?s rdf:type ?t . ?t rdfs:subClassOf* <类>`（`selectSubjects`）；快照侧用 `expandLabelFilter`（`class-hierarchy.ts`，界面默认走这条）。两条路径结果一致：按父类筛，子类的对象也出现。
- 继承属性对实例生效：`mergeInheritedProperties` 用于对象写入、发布前校验（必填 / 唯一）、运行时类型清单与对象编辑表单。不补这一层，子类的对象连父类定义的字段都填不了。
- 本体视图（`readSchemaGraph`）改为**始终**画出声明的类与 `subClassOf` 边，不再只在图库为空时才回退到 RDF Schema。
- Neo4j 侧没有等价实现，已作为 G6 记录（Neo4j 已从前端下线，暂不补）。

### 数据资源

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| D1 | 用数据源实例化对象 | 类可以绑到表（`entityTypes[].sources`，多来源已支持按主键合并），但不会把表里的行读成对象 | 按主键去重、按属性映射填值，先把行读成只读对象；写入另算（Palantir 也是写 user edits 层，不回写源表）。依赖 M1 先把对象身份定下来 |
| D2 | 关系类型的数据来源 | 只有类有来源，关系还得手工连 | 参照 Palantir 的 link type backing dataset：用两张表的外键列关联，或绑定中间表 |
| D3 | 连接池与超时 | 结构清单已有 60 秒 TTL 缓存（命中不建连接），但**建连接本身**仍是每次操作 `new DataSource()` + `initialize()` + `destroy()`：试连 ~400ms、点一张表 ~500ms 基本都是这部分开销。2026-09-12 出现过一次 dev server 直接退出（exit 3221225477 / 0xC0000005，崩前最后一条日志是 `POST /data-sources/:id/test 200`），重启后连续 16 次试连 + 2 次 HMR 未复现 | 按来源把连接池缓存到 `globalThis` 复用（凭据/host 变了再重建），加连接超时与并发上限，`options` 里暴露只读开关；顺带把 Oracle 的原生状态也放到 `globalThis` |

| D4 | 非关系来源接入 | `PLANNED_DATA_SOURCES` 只列了 ES / REST / 文件，界面归到「规划中」 | 在 `openDataSourceConnector` 里分流到新实现，实现 `DataSourceConnector` 的四个方法即可 |

### 对象检索层

记录时间：2026-09-12。**决定：引入对象检索层，第一版落在 PostgreSQL**（全文 + `pg_trgm` 模糊 +
`jsonb` 过滤 + `pgvector` 向量），取代原计划的 Elasticsearch——理由是 Elasticsearch 的
SSPL / ELv2 / AGPLv3 三选一对闭源产品分发都有风险（详见 `docs/adr/0018-对象检索层走PostgreSQL索引.md`）。
检索索引是派生数据，可随时从已发布快照重建（`POST /api/object-search/reindex`）。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| R1 | 前端接入对象检索 | 接口 `/api/object-search` 已可用（全文 + 模糊 + 属性过滤 + 向量 + 分页），但对象页的搜索与筛选仍走图库的 `searchEntities` | 对象页搜索与筛选改走检索接口，接口报错时退回图库；图谱页的属性筛选同样接入 |
| R2 | embedding 提供方 | 向量列（维度 1536）、HNSW 索引与向量检索都已实现并验证过，但没有生成向量的能力，`embedding` 目前恒为 NULL | 接入 embedding 模型（本地或远端）后，在发布与重建索引时写入向量；改维度需要 ALTER 列并重建索引 |
| R3 | 大对象集的总数统计 | 每次检索都跑一次 `COUNT(*)`；当前规模无影响 | 命中集超阈值时改为估算行数，或让前端只在需要时请求总数 |

### 界面

| 编号 | 事项 | 现状 |
| --- | --- | --- |
| U2 | 审计记录查看界面 | 发布 / 失败 / 本体存储变更记录只在 PostgreSQL `audit_entries` 里，界面上看不到 |
| U3 | 弹窗层级低于图谱控件 | sigma 的缩放控件 z-index 为 `--sigma-controls-zindex`（100），全局 `.dialog-backdrop` 只有 10，弹窗够高时控件会浮在弹窗上。本次只在类型编辑弹窗用 `.ted-backdrop` 抬到 120 规避，其它弹窗（新建本体存储、新建关系、新建对象）仍有此问题 |

| U4 | 本体骨架从图库反推 | 「本体骨架」读的是 `db.schema.visualization()` / 实例的 `rdf:type`，所以图库一空骨架就空——草稿里定义了类也看不见，而且图里的标签可能与定义漂移 | 骨架改为直接渲染版本快照里的类与关系类型；图库侧只作为「已发布生效结构」的对照 |

### 多本体隔离（Neo4j 社区版）

Neo4j Community 只能有一个库，而平台按「本体存储」登记连接、发布时整库替换
（`neo4j.ts` 的 `replaceGraph` 是 `MATCH (n) DETACH DELETE n`，读路径也是 `MATCH (n)`），
所以同一个库上登记两个本体存储会互相看见、发布时互相清空 —— 需要真正的隔离手段。
记录时间：2026-09-12。**2026-09-12 决定采用 N1（多实例）**，并已落地两件事：
新建 / 编辑本体存储时拦截"同一个库上再登记一个"（HTTP 409 + 说明怎么改），
以及 `scripts/neo4j-instance.ps1`（起 / 停 / 列出实例）。本机已登记 B 实例
`bolt://localhost:7688`（容器 `ontology-neo4j-b`），实测在 B 上发布不影响 A（7687）。

| 编号 | 方案 | 说明 |
| --- | --- | --- |
| N1 | 多实例 | 一台机器跑多个 Neo4j Community（不同端口/容器），各登记一个本体存储。零改动，隔离最彻底，代价是每个实例一份进程与内存 |
| N2 | 用 Fuseki/Jena 承载多本体 | 平台已支持：一个 Fuseki 下配多个 dataset，或同一 dataset 内用「命名图」（`options.namedGraph`）。社区版没有多库限制 |
| N3 | 单实例逻辑隔离 | 给本体存储加 `namespace` 选项，Neo4j 适配器对标签/关系类型统一加前缀并让所有读路径按它过滤，查询工作台自动带上约束。落点：本体存储配置字段、`GraphStore` 读写路径、`/api/query` 与工作台提示 |
| N4 | 升级 Enterprise / Aura | 真多库，`CREATE DATABASE`；现有代码本来就是按 `database_name` 建会话，属于最省事的功能路径 |

### 本体一等公民（对标 bkn-studio）

记录时间：2026-09-13。**用户方向：像 bkn-studio 的「知识网络管理」那样，在平台里直接建立不同的本体来做隔离**，
而不是让用户先去理解「本体存储 / 数据集 / 命名图」。

现状的问题是隔离单位错了：现在隔离粒度是**本体存储**（一个连接 = 一个本体，1:1），
于是用户必须先想清楚"存哪"才能建本体，Neo4j 社区版一个库的限制就直接暴露在界面上。
参照 bkn-studio：`KnowledgeNetworkRecord = { id, identifier, name, description, color, icon, tags,
createTime, creatorName, updateTime, updaterName, statistics, embeddingModelId }`，
对象类型 / 关系类型 / 动作类型全部挂在知识网络 id 下，存储完全不出现在用户面前。

目标形态：

```
本体(ontology) ── 版本(draft/published) ── 对象 / 关系
      └─ 落点：存储(target) + 空间(namespace)
```

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| O1 | 「本体」成为一等公民 | 隔离粒度是本体存储，版本与快照都按 `target_id` 归类 | 新表 `ontology_platform.ontologies`：id / identifier / name / description / color / tags / created_by / created_at / updated_at / target_id / namespace；版本记录加 `ontology_id`，老数据迁移成一个默认本体（名字取原本体存储名）。快照磁盘结构不动 |
| O2 | 落点自动分配 | Jena 的命名图写在 `target.options.namedGraph` 上，是整个存储一份；Neo4j 只能一个存储一个本体 | Jena：新建本体时自动分配 `urn:ontology:<id>`，命名图改为**按调用传入**（`jena.ts` 的 endpoints 解析 + `getGraphStore` 增加可选 namespace），于是一个 Fuseki 能承载多个本体；Neo4j：社区版一个库只能一个本体，实例被占用时提示"再起一个实例"（复用 `scripts/neo4j-instance.ps1` 与现有 409 逻辑） |
| O3 | 本体列表页 | 左侧是「本体存储」下拉，没有本体概念 | 对标截图：卡片列表（名字 / 描述 / 标签 / 统计 / 创建人 / 更新时间）+「新建 / 导入 / 搜索 / 分页」；顶部「当前本体」选择器取代「当前本体存储」；原「本体存储」页改名「存储资源」，显示每个存储挂了几个本体 |
| O4 | 本体统计 | 无 | 卡片上显示对象类型数 / 关系类型数 / 对象数 / 关系数（`statistics`），数据从版本快照 + 图库统计来 |

**不变量：「当前本体」是主选择，落点必须跟着它走。** 2026-09-13 修过一个 bug：首次加载时
`loadTargets` 从本体列表和存储列表**各自**取第一项，两个列表顺序无关，于是侧边栏显示「本体 A」、
实际加载的却是「存储 B」的草稿与版本（页头、版本条、画布全是 B 的内容）。现在的规则：
`loadTargets` / `loadOntologies` 只从本体列表决定 `targetId`；`loadVersions` 在目标变化时先清空
版本与运行时统计，避免切换的一瞬间显示上一个本体的草稿。改动这块时别把两者再拆成独立取值。

### 工程清洁

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| C1 | `src/lib/version-store.test.ts` 命名过时 | 用例实际测试 `version-snapshot.ts`，文件应与被测模块同名 |
| C2 | 端到端用例覆盖不足 | `e2e/` 目前只有一个版本工作区 smoke；本体存储创建向导、发布失败提示、SPARQL 工作台、数据资源浏览与类绑定都还没有 e2e |
