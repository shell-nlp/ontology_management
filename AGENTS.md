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
2. 「对象类型」不等于「标签」。它在 Jena 里落成 `rdf:type` 的宾语，那只是它在图库里的形态；
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
| P1 | 增量发布 | 每次发布都是整图替换：Jena 清空目标命名图 + 重写 | 快照与当前图做 diff，只写增删改；`GraphStore` 增加 `applyDelta` 能力，版本里记录基线版本 |
| P2 | 大图导出流式化 | `exportGraph()` 全量进内存（Jena 单条 `SELECT ?s ?p ?o`），快照写入也一次性构造 | 分页/游标导出（按主语分页的 `SELECT`），快照写入改流式 |
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

| G5 | ~~后端定位与许可~~ | **已于 2026-09-14 关闭：Neo4j 整体移除，见下方「Neo4j 移除记录」。** |

| G6 | ~~Neo4j 侧的类层级~~ | **随 Neo4j 移除一并关闭（2026-09-14）**：只有 Jena 需要落地类层级，已由 M3 完成。 |

### 本体核心模型

记录时间：2026-09-12。对照的是 Palantir Ontology 的 object type / object 关系：
object type 是 schema 定义（属性、主键、标题、backing datasource），object 是它的一个实例，
对象身份是 (object type, primary key)，用户的编辑、对象间的链接、权限都挂在这个身份上。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| M1 | 对象身份 = (类, 主键) | 发布时对象身份取快照节点 id（临时写成 `__ontology_id`，发布后移除），`sources[].primaryKey` 只用于来源绑定校验与多来源（MDO）按列合并；图上的唯一约束来自属性自己的 `unique` / `indexed` 标志（`jena.ts` 的 `applyStrongRules`），不看 `sources[].primaryKey` | 让主键成为对象的真实身份：发布与动作写入都用 `sources[0].primaryKey` 生成稳定 id，按主键建唯一约束，读路径与动作引用改按主键定位。是 D1 的前置依赖 |
| M2 | 接口（interfaces） | 完全没有 | Palantir 用接口表达共享能力与多继承：接口是抽象的、不能被直接实例化，object type 实现接口后按接口被消费，链接与动作也能定义在接口上。工作量在定义层语义（接口定义、类实现、属性/链接/动作的继承与覆盖）加图库落地方式，建议先出 ADR 再实现。参考 https://palantir.com/docs/foundry/interfaces/interface-overview/ |

**M3（类层级与类型传播，第一档推理）已于 2026-09-13 完成（Jena 侧）**，记录如下：

- 发布时按定义写元模型：每个类声明 `owl:Class`，有 `parents` 的写 `rdfs:subClassOf`，关系类型写 `rdfs:domain` / `rdfs:range`（`jena.ts` 的 `schemaStatements`，纯函数、有单测）。
- 元模型与实例隔离：类声明同时盖 `urn:bkn:Class`、关系类型盖 `urn:bkn:Property`，所有实例级查询用 `NOT_META_SUBJECT` 统一排除。没有这一步，类会混进对象数、对象类型分布、标签清单与整图导出。
- 读路径做类型传播：图库侧用 `?s rdf:type ?t . ?t rdfs:subClassOf* <类>`（`selectSubjects`）；快照侧用 `expandLabelFilter`（`class-hierarchy.ts`，界面默认走这条）。两条路径结果一致：按父类筛，子类的对象也出现。
- 继承属性对实例生效：`mergeInheritedProperties` 用于对象写入、发布前校验（必填 / 唯一）、运行时类型清单与对象编辑表单。不补这一层，子类的对象连父类定义的字段都填不了。
- 本体视图（`readSchemaGraph`）改为**始终**画出声明的类与 `subClassOf` 边，不再只在图库为空时才回退到 RDF Schema。
- 类层级与类型传播只在 Jena 侧落地；Neo4j 已于 2026-09-14 整体移除，不再需要考虑它的等价实现。

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

### 多本体隔离

**结论：隔离单位是「命名图」，不是「多起一套实例」。** 2026-09-14 之后的实现：

- 新建本体时自动分配 `urn:ontology:<本体 id>`，写进 `graph_targets.options.namedGraph`；
  `createOntology` 走 `createManagedTarget` 开一条受管存储记录，用户不需要理解数据集与命名图。
- 发布是**整图替换**，作用范围就是这个命名图（`jena.ts` 的 `replaceGraph` 清掉目标命名图后重写，
  没配命名图时才是默认图），所以同一个 Fuseki 上可以并存任意多个本体。
- 仍然拦截「同一个数据集 + 命名图」被登记两次（HTTP 409 + 说明怎么改），因为那两边的发布确实会互相清空。
- 要按环境 / 租户再分一层时用**多 dataset**（一个 Fuseki 下配多个 dataset，登记时选不同数据集）；
  需要资源或权限硬隔离时才单起一套 Fuseki/TDB2。

历史（已作废）：2026-09-12 曾按 Neo4j Community「一个库一个本体」的限制选了"N 个实例各自登记"的方案
（`scripts/neo4j-instance.ps1`，已在 2026-09-14 随 Neo4j 一并删除）。下表的 N1/N3/N4 都是 Neo4j 专属路径，
保留只为说明当时的取舍。

| 编号 | 方案 | 说明 |
| --- | --- | --- |
| N1 | 多实例（Neo4j，已作废） | 一台机器跑多个 Neo4j Community（不同端口/容器），各登记一个本体存储。隔离最彻底，代价是每个实例一份进程与内存 |
| N2 | 用 Fuseki/Jena 承载多本体 | **已采用**：同一 dataset 内用命名图（`options.namedGraph`），或一个 Fuseki 下配多个 dataset |
| N3 | 单实例逻辑隔离（Neo4j，已作废） | 给本体存储加 `namespace`，对标签/关系类型统一加前缀并让读路径按它过滤 |
| N4 | 升级 Enterprise / Aura（Neo4j，已作废） | Neo4j Enterprise 才有多库，`CREATE DATABASE` |

### Neo4j 移除记录

记录时间：2026-09-14。用户要求「去掉 neo4j」，这次是**整体移除**，不是像 2026-09-13 那样只从前端下线。

删掉的东西：

- 代码：`src/lib/graph/neo4j.ts`、`src/lib/graph/neo4j.test.ts`、`scripts/neo4j-instance.ps1`
- 依赖：`package.json` 的 `neo4j-driver`（`next.config.ts` 的 `serverExternalPackages` 同步去掉）
- 类型：`GraphTargetKind` 收窄成 `"JENA"`，`QueryLanguage` 收窄成 `"sparql"`，`GRAPH_TARGET_KINDS` 只剩 Jena；
  `retiredGraphTargetKinds()` 与「已下线」分组一并删除（`FRONTEND_GRAPH_TARGET_KINDS` 保留为 `GRAPH_TARGET_KINDS` 的别名）
- 界面：存储资源页只剩 Jena 分组；新建本体存储因为只有一个引擎，直接进连接表单，不再有"选类型"步骤；
  图谱页的查询工作台固定 SPARQL；本体草稿页的「复制显示样式」（Neo4j Browser GraSS）按钮删除
- 行为：`createOntology` 不再有「资源被占用」分支（命名图天然隔离）；`/api/query` 去掉遗留的 `cypher` 入参别名

**有意保留的两处**：

1. `platform-db.ts` 里 `neo4j_targets` → `graph_targets` 的改名迁移**必须留着** —— 老部署升级时靠它保住历史数据。
2. 数据库里若残留 `kind` 不是受支持引擎的记录，`getTarget` / `listTargets` 直接跳过（当作不存在），
   不再回退成某个后端去连。要清理就手写一条 SQL：
   `DELETE FROM ontology_platform.graph_targets WHERE kind NOT IN ('JENA');`
   （本机两个连接都是 Jena，没有需要清理的行。）

### 本体一等公民（对标 bkn-studio）

记录时间：2026-09-13。**用户方向：像 bkn-studio 的「知识网络管理」那样，在平台里直接建立不同的本体来做隔离**，
而不是让用户先去理解「本体存储 / 数据集 / 命名图」。

现状的问题是隔离单位错了：现在隔离粒度是**本体存储**（一个连接 = 一个本体，1:1），
于是用户必须先想清楚"存哪"才能建本体，图库的隔离限制就直接暴露在界面上（Neo4j 时代是社区版一个库的限制）。
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
| O2 | 落点自动分配 | **已完成**：新建本体时自动分配 `urn:ontology:<id>` 写成 `target.options.namedGraph`，一个 Fuseki 能承载任意多个本体 | Neo4j 分支已随 2026-09-14 的移除取消，`createOntology` 不再需要"资源被占用"的判断 |
| O3 | 本体列表页 | 左侧是「本体存储」下拉，没有本体概念 | 对标截图：卡片列表（名字 / 描述 / 标签 / 统计 / 创建人 / 更新时间）+「新建 / 导入 / 搜索 / 分页」；顶部「当前本体」选择器取代「当前本体存储」；原「本体存储」页改名「存储资源」，显示每个存储挂了几个本体 |
| O4 | 本体统计 | 无 | 卡片上显示对象类型数 / 关系类型数 / 对象数 / 关系数（`statistics`），数据从版本快照 + 图库统计来 |

**不变量：「当前本体」是主选择，落点必须跟着它走。** 2026-09-13 修过一个 bug：首次加载时
`loadTargets` 从本体列表和存储列表**各自**取第一项，两个列表顺序无关，于是侧边栏显示「本体 A」、
实际加载的却是「存储 B」的草稿与版本（页头、版本条、画布全是 B 的内容）。现在的规则：
`loadTargets` / `loadOntologies` 只从本体列表决定 `targetId`；`loadVersions` 在目标变化时先清空
版本与运行时统计，避免切换的一瞬间显示上一个本体的草稿。改动这块时别把两者再拆成独立取值。

### 本体包（导出 / 导入）

记录时间：2026-09-14。对标 bkn-foundry 的知识网络导出：**一个 JSON 文件带走整份结构**，方便传播。

- 模块：`src/lib/ontology-bundle.ts`（纯函数，单测 `ontology-bundle.test.ts`）。
- 接口：`GET /api/ontologies/:ontologyId/export`（取已发布版本的定义，没有就取草稿）、
  `POST /api/ontologies/import`（建本体 + 写草稿，**不发布**）。
- 界面：本体卡片上的「导出」；页头「导入本体包」。

三条不变量，改动时别破：

1. **`definition` 就是 `OntologyDefinition` 原样进出**，不新造形状 —— 导出的就是"卡位上写着的那份定义"。
2. **包里绝不写凭据**；数据资源只记连接坐标，导入端按坐标匹配本机资源。
   匹配顺序是「五项全等」→「少模式一项（放宽 + 提醒）」→ 找不到就**留空绑定并点名是哪个类**。
3. **导入停在草稿**，不碰图库。别人的文件不能绕过版本边界。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| E1 | 带实例导出 | 只导结构，`statistics.objects` 只是"导出端当时有多少" | 加可选 `instances` 字段（nodes / relationships），导入同样换 id、按类名认对象类型。因为是可选字段，格式版本不用动 |
| E2 | 概念域分组与指标 | 本体模型里**没有**这两个概念（bkn 的 `concept_groups` / `metrics`） | 先在定义层加模型，再进本体包。别为了"和 bkn 对齐"往包里塞平台不认识的段 |
| E3 | 包与已有本体合并 | 导入只有"新建"，不能"并进已有本体" | 要合并得按名字匹配类/关系类型并让人确认冲突，属于独立特性，别顺手做 |
### 能力验证（智能问答与 MCP）

记录时间：2026-09-13。**对标 bkn-studio 的「能力验证」：用大模型编排本体工具，多步查询后给带证据的结论。**
bkn 那边的形态是 `search_schema / query_object_instance / query_instance_subgraph / execute_action`
一组 MCP 工具 + LLM 编排（`bkn-studio/src/modules/knowledge-network/services/agent-chat.service.ts`），
工具实现落在 `bkn-foundry/adp/bkn/ontology-query`。平台这一版把同样的闭环做进来，工具层自己实现。

已落地：

- `src/lib/reasoning/tools.ts`：五个**只读**工具 —— `search_schema`（自然语言 → 概念命中，带命中理由）、
  `get_object_type`（属性含继承、父类、端点关系、动作）、`query_object_instance`（走图库，带类型传播）、
  `query_instance_subgraph`、`list_actions`。排序是纯函数（`rankSchemaConcepts`），有单测。
- `src/lib/reasoning/agent.ts`：编排循环（默认最多 8 步）。模型只负责"下一步查什么"，
  事实全部来自工具；每步记录工具、入参、结果（按上限截断）、耗时、引用的**真实** id。
- `src/lib/reasoning/provider.ts`：把"OpenAI 兼容端点 + 三个环境变量"翻译成 AI SDK 的模型对象，
  只读 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`。没配时 `/api/reasoning/status` 明确上报未配置，界面显示而不是静默失败。
- **编排层用 Vercel AI SDK v7**（`ai` 的 `ToolLoopAgent`，provider 用 `@ai-sdk/openai-compatible`），
  不再手写"调模型 → 解析工具调用 → 回灌结果"的循环。选型口径：本端点是**非标准代理**
  （自建 `thinking` 参数、思考走 DeepSeek 的 `reasoning_content`），`@ai-sdk/openai-compatible`
  两点都支持，且会把 `providerOptions` 里不认识的自定义字段**原样合并进请求体**。
- `POST /api/reasoning/run`（一次性）、`POST /api/reasoning/stream`（SSE）、`GET /api/reasoning/status`；
  每次运行写一条 `REASONING_RUN` 审计。
- 前端「能力验证」两页（2026-09-14 重做，对标 bkn-studio 的「智能问答 / MCP 调试」）：
  - **智能问答**（`src/components/qa-studio.tsx`）：会话流。用户的话是右侧小气泡，Agent 的回复是通栏报告，
    结构固定为 **求证轨迹 → 结论 → 依据 → 用量**。求证轨迹是这一区的签名元素：一条可展开的步骤带
    （第几步 · 调了什么 · 命中多少 · 耗时），展开能看到工具的原始返回；依据里的对象 chip
    **点一下直接跳到对象页并选中它**。颜色只在依据上用一处「核实绿」（#0f766e），其余沿用平台蓝。
  - **MCP 调试**（`src/components/mcp-studio.tsx`）：左列工具清单（按「本体与 Schema / 本体模型检索 /
    对象实例与关系子图查询」分组），右侧是接口台 —— 说明 + 参数表 + 请求体 + 响应，带「接口文档 / 自动填参 / 运行」。
    页面调的是**真实 MCP 协议**（POST /api/mcp，JSON-RPC 2.0），不是另做一套内部调用。

**流式与思考开关已落地**（2026-09-14）：

- 走的全是流式（`includeUsage: true`，否则流式下统计不到 token）。工具调用分片由 SDK 按 `index` 归并，
  不会拼出半截 JSON。
- `agent.ts` 消费 `ToolLoopAgent.stream()` 的 `fullStream`，往外发 `thinking` / `answer` / `answerReset` /
  `step` / `done`（对应 `reasoning-delta` / `text-delta` / `tool-call` / `tool-result` / `finish`）；
  `/api/reasoning/stream` 再把它们转成 SSE 帧。**校验与权限必须在开流之前做完**，一开流就没法改状态码了。
- **`providerOptions` 只能放在 `new ToolLoopAgent({...})` 构造层**，不能放进 `agent.stream()` 的参数 ——
  `AgentCallParameters`（`stream()` / `generate()` 的入参）没有这个字段，放错会直接 typecheck 失败。
- `answerReset` 的用途：模型调工具前常会先吐一句旁白，那不是结论。界面收到后把它**挪进思考过程**再清空正文 ——
  既不让结论区闪出半句话，也不把这段过程丢掉（关掉思考时模型尤其爱这样旁白）。
- **思考开关**：`thinking: false` 经 `providerOptions` 下发 `thinking.type=disabled`，`reasoning_content` 变空、
  通常更快（实测同一问题 4.6s → 3.8s；迁移到 SDK 后复测 5.9s → 3.5s，思考 197 字 → 0 字）。
  界面在问答页头有个「思考 开/关」，按**每一轮**记录，所以同一会话里开着问一轮、关着问一轮，两轮的展示各自正确。
  注意：`chat_template_kwargs.thinking=false` / `enable_thinking=false` 会被这个端点**静默忽略**（返回 200 但照样有思考）。
- 实测事件流（迁移到 SDK 后复测）：思考 1→53→191→345 字、步骤 0→4、正文 0→95→251→349 字，都是边跑边长出来的；
  收尾后「思考过程 / 求证轨迹」会按设计自动收起（`open = manual ?? live`），展开仍能看到完整内容。

两条刻意的边界，改动时别无意破坏：

1. **只在已发布版本上推理**。草稿的定义与图库里的数据不是同一份，混着推会得出"定义说有、图里没有"的矛盾结论。
2. **工具只读**。让模型直接写图库风险太大（它可能编造对象 id）；写入继续走动作引擎 + 人工确认。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| L2 | 历史推理记录 | 只写进 `audit_entries`，界面上看不到（同 U2） | 推理页加「历史记录」侧栏：问题、步数、结论、证据；与审计界面一起做 |
| L3 | 语义检索用向量 | `search_schema` 是关键词 + 中文 2 元组匹配，没有语义召回 | 等 R2 接上 embedding 后，给概念建向量索引，与关键词分数融合 |
| L4 | 让模型执行动作 | 工具全只读，动作只能看不能跑 | 若要开放，走"模型提议 + 人确认"：用 AI SDK 的 `toolApproval`（`new ToolLoopAgent({ tools, toolApproval: { name: 'user-approval' } })`）让工具返回审批请求而不是直接执行，流里会给到 `tool-approval-request`，由界面二次确认后再落到动作引擎。不要直接给写权限 |
| L5 | 多轮追问 | 一次运行一问一答，没有上下文（智能问答页只是把多轮**并列**展示） | 会话表 + 把上一轮结论压缩进 system；注意结论里的 id 仍是真实的才能复用 |

**MCP 服务端已落地**（`src/lib/reasoning/mcp.ts` + `src/app/api/mcp/route.ts`）：

- 传输：Streamable HTTP，JSON 响应；实现 `initialize` / `ping` / `tools/list` / `tools/call`，
  通知回 202，GET 回 405（不做服务端推送）。协议版本 `2025-06-18`。
- 工具：`list_ontologies` + 上面那五个，**每个都多一个 `ontology_id`**（面向外部客户端时，隔离单位是本体而不是存储）。
- 鉴权：平台会话 Cookie（站内调试）或 `Authorization: Bearer <MCP_API_TOKEN>`（外部客户端）。
  令牌在 `.env.local`，没有它外部就连不上，不会静默放行。
- 复用 `reasoning/tools.ts` 的实现，一层都不重写 —— 避免"界面上查得到、MCP 里查不到"的漂移。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| V1 | MCP 调用审计 | 平台内的运行写 `REASONING_RUN` 审计，但**外部客户端经 MCP 调用没有留痕** | 在 `tools/call` 里写一条 `MCP_TOOL_CALL`（谁、哪个本体、哪个工具、耗时、命中数）；配合 U2 的审计界面一起看 |
| V2 | MCP 鉴权粒度 | 单一静态令牌：谁拿到都能查所有本体，也不能按用户吊销 | 改成平台 API Key（每人一个、可吊销），并把令牌绑定到本体范围；令牌轮换后写审计 |
| V3 | MCP 的 resources / prompts | 只实现了 tools 能力 | 若要给客户端直接挂"本体说明书"，可以加 `resources/list` 暴露本体概览；先等真实客户端需求 |
| V4 | MCP 侧的长任务通知 | 平台内的问答已经走 SSE 边跑边显示；MCP 工具仍是同步返回，大子图查询会让客户端干等 | 评估 MCP 的 progress 通知（`notifications/progress`），先看真实客户端是否需要 |
### 工程清洁

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| C1 | `src/lib/version-store.test.ts` 命名过时 | 用例实际测试 `version-snapshot.ts`，文件应与被测模块同名 |
| C2 | 端到端用例覆盖不足 | `e2e/` 目前只有一个版本工作区 smoke；本体存储创建向导、发布失败提示、SPARQL 工作台、数据资源浏览与类绑定都还没有 e2e |
