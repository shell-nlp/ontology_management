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
- 左侧导航按 **语义模型（本体草稿）· 本体实例（图谱 / 对象 / 关系）· 动力模型（动作 / 规则）** 分组（2026-09-14 起）：图谱里虽然能切「查看本体」，它整体归在实例侧。
- **「界面」包括会显示给用户的消息**：校验结果、发布拦截原因、导入提醒、`notify()` / `throw new Error()` 里的文案。
  这些和按钮、标题一样按界面算，一律写「对象类型」。代码注释、测试名、内部变量名不受此限。
- 自查办法（提交前跑一遍，只应剩下"这类问题""这几类关系"这种普通汉语）：
  `rg -n "类「|新增类|类清单|起始类|终止类|该类的|这个类的" src`（剩下的命中应该只在代码注释或测试名里）

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

**和容器构建的关系**：上面这条约束的是"日常验证"，不是镜像构建。`docker compose up -d --build`
里的 `pnpm build` 是镜像构建的一部分（Dockerfile 的 builder 阶段），该跑就跑。

## 客户端代码约定

**不许直接用"只在安全上下文里存在"的浏览器 API。** 2026-09-14 用户报：用机器 IP 走 http 访问，
一点「本体草稿」整页变成 `This page couldn't load`（控制台是 `crypto.randomUUID is not a function`）——
`crypto.randomUUID` 只在 https 或 localhost 下存在，IP 访问时是 `undefined`，异常被 Next 的错误边界接住。

- `crypto.randomUUID` → 用 `@/lib/ids` 的 `newId()`（优先原生，其次 `getRandomValues` 自己拼 v4，
  最差退回时间戳 + 随机数）。`resolveGroup` / `planBundleImport` 这类可注入生成器的函数，默认值也用它。
- `navigator.clipboard` → 用 `mcp-studio.tsx` 里那种"先 Clipboard API、失败退隐藏 textarea + execCommand"的写法。
- 同类还有 `crypto.subtle`、`navigator.geolocation`、`Notification`、Service Worker：都需要安全上下文。

**这些 API 在 https 与 localhost 下都在，所以只在本机用 `localhost` 测是查不出来的** ——
界面改动要在两个入口各过一遍：`http://localhost:<port>` 与 `http://<机器 IP>:<port>`。

## 部署（Docker Compose）

记录时间：2026-09-14。用户要求提供容器化部署：先明确"只部署平台本体"，
随后又把 `stain/jena-fuseki:latest` 也加进编排（**容器之间走服务名 `fuseki:3030`**）。
PostgreSQL（平台库）与业务数据源仍不进编排，按各自现有方式跑。

- 文件：`Dockerfile`（builder 做 `pnpm build`，runner 只装生产依赖用 `next start` 起）、
  `docker-compose.yml`（`app` + `fuseki` 两个服务）、`.env.docker.example`（连接信息与密钥模板，
  真文件 `.env.docker` 已在 `.gitignore` 里）、`.dockerignore`。
- **不用 `output: "standalone"`**：`next.config.ts` 把 oracledb / typeorm / pg / mysql2 交给运行时加载，
  而 oracledb 是按平台拼文件名 require 预编译二进制的，Nft 追踪容易漏 → 会出现"装得上、连不上 Oracle"。
  宁可镜像大一点，也要保证原生驱动在。
- 密钥一律运行时注入（`.dockerignore` 把 `.env*` 挡在构建上下文外）；版本快照挂命名卷
  （默认改为绑定项目 `.data/ontology-versions`，与本机开发服务共用同一份；写卷名才用命名卷。
  Linux 上绑定挂载要 `chown -R 1000:1000`，容器里的 node 用户是 uid 1000）。
- **容器里的 `localhost` 是容器自己**：`DATABASE_URL` 要写 `host.docker.internal`
  （compose 已加 `host-gateway` 映射）。本体存储那条登记不用改 —— 见下面的主机别名一条。
- **`TARGET_ENCRYPTION_KEY` 必须与库里已有数据一致**：数据资源凭据是加密存的，换钥匙就解不开。
- **版本快照目录是状态，不是缓存**（2026-09-14 实测）：平台库只记"某本体发布了 vN"，
  定义本身在 `ONTOLOGY_VERSION_DIR`（容器内 `/data/ontology-versions`）。空卷 + 有版本的库
  会表现成"模型工具答**本体还没有发布版本**、图库与版本对不上"。要么把旧目录带过来
  （compose 的 `VERSION_SNAPSHOT_DIR` 指向它），要么部署完重新发布一次。
  **同一个平台库上并行跑本机开发服务与容器时，两边的快照目录必须是同一个**（把
  `VERSION_SNAPSHOT_DIR` 指到项目里的 `.data/ontology-versions`），否则一边发布的版本另一边读不到。
- **Oracle 只能走 Thick 模式**（2026-09-14 实测）：要连的服务端会直接拒掉驱动 Thin 模式
  （NJS-138），所以镜像里内置 Linux 版 Instant Client（`docker/oracle/install-instantclient.sh`，
  构建时优先用 `docker/oracle/*.zip`，没有才去 Oracle 官网下载），并同时设
  `ORACLE_CLIENT_LIB_DIR` 与 **`LD_LIBRARY_PATH=/opt/oracle/instantclient`** ——
  只设前者在 Linux 上会报 `DPI-1047 ... libnnz.so`（libclntsh.so 不带 `$ORIGIN`）。
  这与 `D:\project\shangke-insight` 的做法一致，改这块先去看那边的 Dockerfile。
- `APP_PORT` / `VERSION_SNAPSHOT_DIR` / `NODE_IMAGE` 是给 compose 做**变量替换**的。
  `env_file:` 里的变量不参与替换，所以四个 `docker:*` 脚本统一带 `--env-file .env.docker`
  （同一个文件既注入容器、又做替换）；手动敲 `docker compose` 时必须自己带上这个参数。
- **会话 cookie 的 Secure 不能只看 `NODE_ENV`**（2026-09-14 用户报"登录一下就退出"）：
  容器里 `NODE_ENV=production` 恒成立，直接 http（非 localhost）访问时发 Secure cookie 会被浏览器丢掉，
  于是登录成功但会话立刻失效。现在由 `src/lib/session-cookie.ts` 的 `sessionCookieSecure()` 决定：
  先看 `x-forwarded-proto`（代理后面）与请求协议，`https` 才发 Secure，另有 `AUTH_COOKIE_SECURE`
  可显式覆盖；本机是 https 时不允许被客户端伪造的头部降级。**这条只有用非 localhost 的地址才复现**，
  验证时两种入口都要试。
- `platform-db.ts` 的连接池挂了 `error` 监听：远端平台库的空闲连接被网络设备掐断时，
  没有监听者就是未捕获的 error 事件（进程可能直接退出，日志还会打出整个连接对象）。
- **图库端点的主机名由 `GRAPH_ENDPOINT_HOST_ALIAS` 改写**（2026-09-14）：平台库里登记的端点是
  给宿主机写的（`http://localhost:3030/ds`），容器里 `localhost` 是容器自己。与其让人再登记一条
  或去改库，不如在部署侧声明"A 换成 B" —— compose 里 app 默认 `localhost=fuseki`，
  于是宿主机与容器共用同一份登记。实现在 `jena.ts` 的 `resolveSparqlEndpoints`（唯一出口，
  `applyEndpointHostAlias` 有单测）：**别绕过它直接拼端点**。
- **Fuseki 也在编排里**（只是比 app 后加）：`stain/jena-fuseki:latest`，`FUSEKI_BASE`（`/fuseki`，
  含 `databases/` 与 `shiro.ini`）整个绑定到 `.data/fuseki`；数据集名必须与平台登记一致（`ds`）；
  **管理密码在 compose 里写死一个非空默认值**（`ADMIN_PASSWORD: ${FUSEKI_ADMIN_PASSWORD:-admin-studio}`）——
  用户明确要求"要有默认值密码、设置在 compose 里"。别改成 `${VAR:?}`（`env_file` 的变量不参与变量替换，
  不带 `--env-file` 的 `docker compose up` 会直接报错），也别留空（空值会让 Fuseki 自己随机生成一个，
  密码就不在用户手上了）。镜像里的 fuseki 用户是 **uid 100**，
  Linux 上绑定的宿主目录要 `chown -R 100:101`。换机器把 `.data/fuseki` 带走，或从旧容器
  `docker cp <旧容器>:/fuseki/. ./.data/fuseki/`；图库是派生数据，重新发布也能重建。**已验证**：
  从 app 容器调 `/api/targets/:id/test` 返回 `address=http://fuseki:3030/ds/query、hasTriples=true`。

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
| M2 | ~~接口（interfaces）~~ | **2026-09-15 已完成第一版**（见「接口类型（Palantir Interface）」一节）：定义层、实现映射（按同名属性）、关系约束、多继承、Jena 落库、校验、界面、`list_interfaces` 工具都到位。**未做**：动作约束（action type constraints）、shared properties / struct、status / searchable 元数据、画布上画接口节点 |

**M3（类层级与类型传播，第一档推理）已于 2026-09-13 完成（Jena 侧）**，记录如下：

- 发布时按定义写元模型：每个类声明 `owl:Class`，有 `parents` 的写 `rdfs:subClassOf`，关系类型写 `rdfs:domain` / `rdfs:range`（`jena.ts` 的 `schemaStatements`，纯函数、有单测）。
- 元模型与实例隔离：类声明同时盖 `urn:bkn:Class`、关系类型盖 `urn:bkn:Property`，所有实例级查询用 `NOT_META_SUBJECT` 统一排除。没有这一步，类会混进对象数、对象类型分布、标签清单与整图导出。
- 读路径做类型传播：图库侧用 `?s rdf:type ?t . ?t rdfs:subClassOf* <类>`（`selectSubjects`）；快照侧用 `expandLabelFilter`（`class-hierarchy.ts`，界面默认走这条）。两条路径结果一致：按父类筛，子类的对象也出现。
- 继承属性对实例生效：`mergeInheritedProperties` 用于对象写入、发布前校验（必填 / 唯一）、运行时类型清单与对象编辑表单。不补这一层，子类的对象连父类定义的字段都填不了。
- 本体视图（`readSchemaGraph`）改为**始终**画出声明的类与 `subClassOf` 边，不再只在图库为空时才回退到 RDF Schema。
- 类层级与类型传播只在 Jena 侧落地；Neo4j 已于 2026-09-14 整体移除，不再需要考虑它的等价实现。

### 接口类型（Palantir Interface）

记录时间：2026-09-15。用户要求按 Palantir 的接口（interfaces）实现：**接口是抽象契约** ——
它不绑数据、不能被实例化，只描述「实现我的对象类型必须长什么样」。应用按接口统一消费，
于是新加一个实现了该接口的对象类型不用改应用。用户当时的疑问是"接口是不是和父类很像、父类好像没什么用" ——
两者都落 `rdfs:subClassOf`，但语义不同：

- **父类（`parents`）**：具体类型之间的继承。子类自动拥有父类属性，按父类筛能看到子类对象（M3 的类型传播）。
- **接口（`interfaces` + `entityTypes[].implements`）**：能力与形状的契约。一个对象类型可以有多个父类，
  也可以实现多个接口；实现接口要满足接口的属性与关系约束，否则发布前校验会拦下。

数据落在定义里（`src/lib/ontology.ts`）：

- `ontologyDefinitionSchema.interfaces: InterfaceType[]`：`{ id, name, description, properties[], extends[], linkConstraints[] }`
  - `properties[]`：接口属性。`required` 的属性，实现方必须有**同名**属性
    （Palantir 是"把现有属性映射到接口属性上"，平台这一版按同名映射 —— 够表达，也不必再维护第二张映射表）。
  - `extends[]`：接口继承接口（可多继承）；属性与关系约束一起继承，同名以更近的接口为准。
  - `linkConstraints[]`：`{ name, targetKind: OBJECT_TYPE | INTERFACE, targetId, cardinality: ONE | MANY, required }`，
    要求实现方有一条「从我出去、终点是目标对象类型（或其子类）/ 实现了目标接口的类型」的具体关系类型。
- `entityTypes[].implements: string[]`：这个对象类型实现了哪些接口。

三条不变量（改这块时别破）：

1. **接口不是对象类型**：不绑数据源、不能实例化、不进实例查询。发布时声明成 `owl:Class` + `urn:bkn:Interface`；
   `jena.ts` 的 `META_TYPES` 必须留着 `BKN_INTERFACE_META`，否则接口会被当成对象混进对象数、标签清单与整图导出。
2. **实现 = 同名属性 + 必填关系约束**：判断口径只有一处 —— `src/lib/interfaces.ts` 的 `checkImplementations`
   （纯函数、有单测）。发布前校验（`validateVersionSnapshot` → `validateInterfaces` / `validateInterfaceImplementations`）
   与界面提示都走它；校验返回的 message 是**给用户看的界面文案**，按术语约定写「对象类型」。
3. **实现了子接口 = 实现了父接口**：`implementersOf` 把"实现了子接口的对象类型"也算成父接口的实现者；
   图库侧靠 `rdfs:subClassOf` 的类型传播天然成立（按接口筛对象能筛到实现者）。实现同时写 `urn:bkn:implements`，
   读骨架时才能把「实现」与「父类」分成两种边（`readSchemaGraph` 的 `implementPairs`）。

界面（配置一处、使用两处）：

- **「本体草稿 → 接口」标签**（`interface-manager.tsx`）：左栏接口清单、右栏接口定义（名称 / 说明 / 继承 / 接口属性 / 关系约束 / 实现情况）。
  接口图标画成**虚线框**（Palantir 用虚线轮廓区分接口与对象类型）；两栏之间是可拖的分隔条（本机键 `interface-split`）。
- **对象类型侧**：`type-edit-dialog.tsx` 的「实现接口」多选会显示「必填属性对上几条、还缺哪些」并给「按接口补齐属性」；
  可视化画布的右栏也显示「实现接口 X」。`TypeEditDialog` 的 `interfaces` 属性在**可视化与表单两个入口都要传**
  （漏传就会变成"草稿里还没有接口"）。
- 工具侧：`list_interfaces`（接口清单 + 属性 + 关系约束 + 实现者），`get_object_type` 带 `interfaces`（接口属性映射状态），
  `search_schema` 与概念清单都能命中接口；MCP 里 `list_interfaces` 归在 `model` 组、标题「接口」。

已知未做（有意留白，别以为漏了）：接口的**动作约束**（Palantir 的 action type constraints、参数映射，本身还在 beta）、
shared properties / struct、接口的 status 与 searchable 元数据、把接口画在可视化画布上（只画在「接口」标签与骨架图里）。
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

**不变量：用户查询必须按命名图限定数据集。** 2026-09-14 修过一个串数据的 bug：
适配器自己的读路径都套了内联 `GRAPH <命名图>`，唯独 `/api/query`（图谱页的 SPARQL 工作台）
是原样执行用户语句 —— 于是裸 `?s ?p ?o` 打到 Fuseki 的**默认图**，而默认图里放的是
「没配命名图」的那个本体的数据，看起来就是"别的本体的数据跑进来了"。
现在的规则：`execute()` 走 `scopedQueryUrl(endpoints)`，用 SPARQL 协议参数
`default-graph-uri` + `named-graph-uri` 把命名图设成这次查询的默认图（也登记成命名图，
所以 `GRAPH <自己的图>` / `GRAPH ?g` 仍可用，但数据集里只有这一个图）。
没配命名图的存储原样执行 —— 那类存储就住在默认图里，而且它是「看整个数据集」的排查入口。
`jena.test.ts` 有 `scopedQueryUrl` 的单测，改这块别把限定去掉。

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

**侧栏「当前本体」的长名字会撑破侧栏**（2026-09-14 修）：`<select>` 在 grid 里默认按 **min-content** 撑宽，
本体名一长（例如「中国移动客户账务订购业务网络V3（含概念域）」）就把 240px 的侧栏顶破、文字压到内容区上。
修法是给 `.target-picker` 和它的 `select` 加 `min-width: 0` + `width: 100%` + `text-overflow: ellipsis`，
并给 select 挂 `title`（鼠标停上去能看到全名）。以后往侧栏里加"用户自己起名的东西"（本体名、标签、数据资源名）
都要按这条处理 —— 名字长度不由我们决定。

### 本体包（导出 / 导入）

记录时间：2026-09-14。对标 bkn-foundry 的知识网络导出：**一个 JSON 文件带走整份结构**，方便传播。

- 模块：`src/lib/ontology-bundle.ts`（纯函数，单测 `ontology-bundle.test.ts`）。
- 接口：`GET /api/ontologies/:ontologyId/export`（取已发布版本的定义，没有就取草稿）、
  `POST /api/ontologies/import`（建本体 + 写草稿，**不发布**）。
- 界面：本体卡片上的「导出」；页头「导入本体包」。
- **导入接受两种文件**：平台自己的 `ontology.bundle`，以及 bkn-foundry 导出的知识网络
  （`module_type: knowledge_network`）。后者由 `src/lib/bkn-import.ts` 先转成标准本体包，
  **转换时丢掉的每一类东西都进 warnings**（指标、关系连接规则、平台不认的属性类型……），不静默丢。
- **概念域分组会一起搬**（2026-09-14 起）：bkn 的 `concept_groups` → `definition.groups`，
  成员在 bkn 里写在分组这一侧（`object_type_ids`）、平台写在对象类型那一侧，转换时按 `idMap` 铺到 `groupId`；
  一个类型挂在多个分组时按文件顺序保留第一个（并报一条 warning），成员 id 找不到对象类型也会报出来。

三条不变量，改动时别破：

1. **`definition` 就是 `OntologyDefinition` 原样进出**，不新造形状 —— 导出的就是"卡位上写着的那份定义"。
2. **包里绝不写凭据**；数据资源只记连接坐标，导入端按坐标匹配本机资源。
   匹配顺序是「五项全等」→「少模式一项（放宽 + 提醒）」→ 找不到就**留空绑定并点名是哪个类**。
3. **导入停在草稿**，不碰图库。别人的文件不能绕过版本边界。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| E1 | 带实例导出 | 只导结构，`statistics.objects` 只是"导出端当时有多少" | 加可选 `instances` 字段（nodes / relationships），导入同样换 id、按类名认对象类型。因为是可选字段，格式版本不用动 |
| E2 | ~~概念域分组~~ / 指标 | **概念域分组已于 2026-09-14 支持**：bkn 的 `concept_groups` 转成平台的概念分组（见「概念分组（业务域）」一节），导入自带、已实测。**指标（`metrics`）仍没有模型**，逐条进 warnings | 指标要等定义层有了模型再进本体包。别为了"和 bkn 对齐"往包里塞平台不认识的段 |
| E3 | 包与已有本体合并 | 导入只有"新建"，不能"并进已有本体" | 要合并得按名字匹配类/关系类型并让人确认冲突，属于独立特性，别顺手做 |
| E4 | bkn 的关系连接规则 | 导入 bkn 知识网络时 `mapping_rules`（两边哪些字段相等就连边）没有模型可落，逐条进了 warnings | 即「关系类型的数据来源」（D2）。先在定义层给关系类型加映射模型，再让 bkn 转换与本体包都带上 |
### 属性与关系类型的说明文本

记录时间：2026-09-14。为了让外部本体能带说明进来补的字段（对标 Palantir 的 property display name / description）：

- 属性（`properties[]`）：`displayName`（给人看的名字，留空退回 `name`）、`description`（这是什么、口径怎么算）。
  列名往往是 `STATIS_DATE` 这种，显示名才是「统计日期」。
- 关系类型（`relationshipTypes[]`）：`description`，和类的 `description` 对齐。

两处都只服务界面与语义，**不落图库**：Jena 侧照旧只写 `rdf:type` / `subClassOf` / `domain` / `range`。
界面上：类型编辑弹窗里可编辑，属性列表显示名当主标题、机器名收成小标签、说明跟在后面；
对象 / 关系的属性表单用显示名当字段名、说明挂 `title`。

### 能力验证（智能问答与 MCP）

记录时间：2026-09-13。**对标 bkn-studio 的「能力验证」：用大模型编排本体工具，多步查询后给带证据的结论。**
bkn 那边的形态是 `search_schema / query_object_instance / query_instance_subgraph / execute_action`
一组 MCP 工具 + LLM 编排（`bkn-studio/src/modules/knowledge-network/services/agent-chat.service.ts`），
工具实现落在 `bkn-foundry/adp/bkn/ontology-query`。平台这一版把同样的闭环做进来，工具层自己实现。

已落地：

- `src/lib/reasoning/tools.ts`：**只读**工具 —— `search_schema`（自然语言 → 概念命中，带命中理由）、
  `get_object_type`（属性含继承与映射列、父类、**一跳**的出边/入边、动作、数据来源绑定、所属概念分组）、
  `list_concept_groups`（有哪些概念分组、每组里有哪些对象类型）、
  `traverse_object_types`（**多跳**：沿关系类型走 1~5 跳，默认 3，可按对象类型与关系类型限定）、
  `get_table_ddl`（表 / 视图的结构，返回 DDL）、`run_sql`（对象类型绑定的表上的只读 SQL）、`list_actions`。
  另外两个实例工具留在目录里但标了 `disabled`（见下面「推理范围」）。排序是纯函数（`rankSchemaConcepts`），有单测。
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
    （第几步 · 调了什么 · **传了什么入参** · 拿到了什么 · 耗时），展开能看到这一步的完整入参与原始返回；依据里的对象 chip
    **点一下直接跳到对象页并选中它**。颜色只在依据上用一处「核实绿」（#0f766e），其余沿用平台蓝。
- **MCP 调试**（`src/components/mcp-studio.tsx`）：左列工具清单（按「本体与 Schema / 本体模型检索 /
  对象实例与关系子图查询（暂时不用，灰着）」分组），右侧是接口台 —— 说明 + 参数表 + 请求体 + 响应，带「接口文档 / 自动填参 / 运行」。
  页面调的是**真实 MCP 协议**（POST /api/mcp，JSON-RPC 2.0），不是另做一套内部调用。
- **接入配置一键复制**（2026-09-14）：连接面板里按客户端给三段可直接粘贴的配置 ——
  **Claude Code**（`claude mcp add --transport http <name> <url> --header "Authorization: Bearer …"` 与项目
  `.mcp.json`，`type` 用 `http`）、**Cursor**（`.cursor/mcp.json`，用 `${env:MCP_API_TOKEN}` 取值）、
  **通用 mcp.json**（`mcpServers` 片段）。写法照两家官方文档来，改之前先回去核对文档，别凭印象改。
  令牌**只以 `<MCP_API_TOKEN>` 占位符出现**，真实值留在服务端 `.env.local`；未配置时面板上直接给一条警示。
  复制走 `copyText()`（Clipboard API 不可用时退回 execCommand），复制按钮点完自己变成「已复制」。

**数据来源绑定必须暴露给模型**（2026-09-14 修）：

对象类型绑了哪张表存在 `entityTypes[].sources` 里，但里面只有**数据资源的 id 与来源 id（都是 UUID）**，
模型看不懂；而 `get_object_type` 当时**根本没返回 `sources`**，于是「专线产品用户 绑定了哪个表」只能被答成
"没有数据来源 / 图库里没有数据"。现在的做法：

- `ToolContext.dataSources`（本机已登记的数据资源）由三个入口一起传：`/api/reasoning/run`、`/api/reasoning/stream`、
  `src/lib/reasoning/mcp.ts` 的 `contextFor`（忘记传就会退化成只有 UUID，答不出表名）。
- `get_object_type` 的 payload 增加 `sources`（角色 / 资源名 / schema / 表 / 主键 / 标题列），每个属性增加
  `source_field`（映射到源表哪一列）与 `source_role`（属于哪一份来源），并附一句 `data_source_note` 说明
  "对象是这张表里的一行、图库对象数与是否绑表无关"。
- `search_schema` 的 `haystack` 把**表名**也算进去：问「TB_MK_GRP_LINE_LIST_DAY 是哪张表」能直接命中对象类型，
  候选的 `detail` 里写「绑定 GISTOOLS.TB_xxx（资源名）」。
- `schemaBrief`（system 里的本体概览）顺带带上每个对象类型绑的表，省掉一次 `get_object_type` 往返。

加新工具或改工具返回时守住这条：**给模型看的字段里不许出现裸 UUID**，要么翻成人话，要么别给。

**表名一律写全「模式.表」，拆分只做一次（2026-09-14 修）**：

界面上、`schemaBrief` 里、`get_object_type.sources` 里，表名都是「模式.视图」的写法
（`GISTOOLS.TB_DIC_AREA_CODE`），模型就照着这个写法去调 `get_table_ddl` / `run_sql`。
`get_table_ddl` 在这里踩过一个坑：传进来的名字被原样当成**裸表名**去数据字典里精确比对，
于是"明明有这张表"却报 `数据源里没有表或视图「GISTOOLS.TB_DIC_AREA_CODE」`（2026-09-14 用户报的）。现在的规则：

- 名字的引用与拆分统一在 `src/lib/data-source/object-name.ts`（纯函数、有单测）：
  `splitObjectName` 认 `模式.表` / `"模式"."表"` / 反引号 / 方括号；`quoteIdentifier`、`qualifiedName`
  也搬到了这个文件，`sql.ts` 只做重导出，别再各写一份。
- 数据资源层在**查字典之前**拆名字，候选模式按优先级：名字里写的 → 调用方给的 → 数据资源登记的
  （`candidateOwners`）。几个候选一起查、再按这个顺序挑（`resolveOracleObject` / `pickNamedObject`），
  所以写 `GISTOOLS.TB_X`、只写 `TB_X`、甚至写错模式都还能落到真实的那张表上。
- Oracle 侧**两边的比较都要 `UPPER()`**（`UPPER(owner) IN (UPPER('gistools'))`）。少一层 `UPPER()`
  会让小写写法查不到 —— 这个坑本轮当场踩到，靠真机验证才发现。
- 查不到时的消息要说清试过哪些模式，并在 Oracle 上补一句"同名对象在别的模式下存在"（`oracleOwnerHint`），
  不要再出现"明明有表却说没有"的排查黑洞。
- 顺带一条已知的**正常现象**：连接用户不是表的所有者时（本机 `sk_ws` 看 `GISTOOLS` 的表），
  `DBMS_METADATA.GET_DDL` 会报 `ORA-31603`，这时按列元数据还原 DDL 是预期路径，
  `get_table_ddl` 的 `ddl_source` 会是 `metadata`，`notes` 里会如实写出原因。

**概念分组与多跳查询（2026-09-14）**：这一版把"分组看得见"和"多跳走得通"补齐，三处要点：

1. **概览里直接给分组成员**：`agent.ts` 的 `schemaBrief` 现在写
   `概念分组：客户域（2 个：客户、用户）；账务域（5 个：…）；未归组：账单`（导出了这个函数，`agent.test.ts` 有单测）。
   用户问"某业务域里有什么"是最常见的一类问题，写在概览里就不必再调工具，也不会出现"分组明明建了、模型说没有"。
   对象类型清单里因此**不再重复**每个类型的分组名（分组清单已经把成员列全了）。
2. **一跳在 `get_object_type`，多跳在 `traverse_object_types`**（`relations` 那个旧字段已换成 `one_hop`）：
   - `get_object_type.one_hop`：`outgoing` / `incoming` 两组，每条带 `relation` + 对方的名字、分组、一句话说明、绑的表。
   - `traverse_object_types`：纯函数 `traverseTypeGraph`（有单测）。起点 `start_type` 留空 = 从全部对象类型出发（等于整张类型图，
     所有节点都是 0 跳）；`hops` 默认 3、上限 5；`object_types` / `relationship_types` 是**白名单**，
     不给就是不限定，起点永远包含在结果里。`nodes[].hop` 是**最短距离**，`edges` 是这些节点之间**全部**关系的诱导子图
     （每条边的 `hop` 取两端里更远的那个），这样"隔两跳能到谁"和"这两类之间还连着哪几条"一次都答得出来。
     起点或白名单里写了本体没有的名字：起点直接抛错（让它先 `search_schema`），白名单里的名字原样进 `unknown_names` 并提醒，**不猜**。
3. **没有合并工具的地址**（`list_concept_groups` 与概览、`get_object_type` 与多跳各留一份是有意的）：
   概览是"一屏看完"，`list_concept_groups` 是**权威清单**（含空分组与未归组，适合"还有哪些没归组"）；
   `get_object_type` 的一跳是读定义时的顺带信息，`traverse_object_types` 才是做路径/范围分析的入口。
   真要把两者合并，就得给"看分组"再编一套参数语义，反而更难被模型用对；这条记录一下，别当成重复实现清理掉。

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

**问答配置（运行参数）**（2026-09-14，对标 bkn-studio 的「问答配置」抽屉）：

**默认全不限制，想卡才卡。** 三个数存在浏览器本地（`src/lib/reasoning/settings.ts`，`ontology.qa.settings`）：

| 字段 | 默认 | 作用 | 服务端兜底 |
| --- | --- | --- | --- |
| 工具步数上限 | 不限制 | 一次问答最多让模型走几步（一步里可并发调多个工具） | 100 步（防死循环） |
| 工具结果上限 | 不限制 | 单个工具返回给模型的字符超过就截断 | 无 |
| 取数行数上限 | 不限制 | `run_sql` 一次最多返回多少行（**只往下压**：留空时模型不指定就按工具默认 100 行） | 5000 行（防一次拉爆内存） |

**run_sql 的默认行数与「已被截断」标记**（2026-09-14 修，用户口径"默认限制 100 条，超过就在 JSON 里标已截断"）：

- 默认从 50 改成 **100**（工具层 `DEFAULT_SQL_ROWS`、连接器 `DEFAULT_QUERY_ROWS` 两处一致）；
  模型传了 `limit` 就按它的来，再被「取数行数上限」往下压，最后被 `SQL_ROWS_CEILING = 5000` 兜住。
- **截断检测以前是坏的**：连接器给语句套了 `LIMIT n`（Oracle 是 `ROWNUM <= n`），
  于是返回行数永远不可能超过 n，而判断写的是 `list.length > n` —— 对 SELECT 恒为 false，
  只有 `SHOW` / `EXPLAIN` 这类套不上 LIMIT 的语句才会真的标出来。
  现在按 **`n + 1` 多取一行**当探针，再用 `takeRows()`（纯函数，有单测）切掉那一行并给出 `truncated`。
  `boundedStatement` 的内部硬上限因此是 `SQL_ROWS_CEILING + 1`：正好打在上限时也要能探出第 5001 行。
- payload 里除了 `truncated: true` 还多一句人话 `truncation_note`：
  「结果已被截断：只返回了前 100 行（本次上限 100），表里还有更多行……」——
  只给模型一个 boolean，它很容易把"前 100 行"当成全量。
- 顺带把连接器的硬上限从 500 抬到 5000（`QUERY_LIMIT_MAX = SQL_ROWS_CEILING`）：
  在这之前「取数行数上限」界面上能填 5000、实际最多只给 500，两边对不上。
- 实测（Oracle 测试 1251）：默认 → `returned 100 / row_limit 100 / truncated true`；
  `limit=6000` → 压到 5000 且 `truncated true`；SQL 自带 `ROWNUM <= 100` → 正好 100 行、`truncated false`（不误报）。

- 请求体里**不带**的项就是"不限制"：`/api/reasoning/stream` 与 `/run` 只认这几个字段，
  服务端把步数夹到 100、`run_sql` 的行数夹到 5000。界面页脚也不显示 `x/分母 步` ——
  没设上限时那个分母是兜底值，显示出来会冒充"限制"。
- 起因：步数原本默认 8、硬上限 16，实测一次"按地市分类统计"的分析跑到 8/8 被拦停，
  界面报「步数用满，结论可能不完整」（用户反馈：不要限制）。现在默认不限制，页头开关上
  设过任意一项才挂「已设」角标。
- 抽屉改完**立即生效**并写 localStorage，没有「保存」按钮 —— 这几个数没有"改到一半"的中间态；
  带「恢复默认」，Esc 与点遮罩都能关。

**系统提示词也能改，默认那段就显示在抽屉里**（2026-09-14，用户要求"这里也要可以配置模型的系统提示词，默认的提示词要显示出来"）：

- 提示词与"本体概念清单"拆成独立模块 `src/lib/reasoning/prompt.ts`（`DEFAULT_SYSTEM_PROMPT` / `schemaBrief` /
  `buildInstructions` / `isCustomSystemPrompt`）。**单独一个文件是有原因的**：界面要显示默认提示词原文，
  而 `agent.ts` 会 import AI SDK 的 provider —— 客户端组件直接引 `agent.ts` 会把它们白打进浏览器包。
- 抽屉里多一段可编辑的 textarea，**默认值就是默认提示词的原文**（这是用户的原话要求："默认的提示词要显示出来"）。
  改了才存 localStorage（`systemPrompt`）；和默认一字不差、或只有空白，都当"没改"（`isCustomSystemPrompt`），
  请求里也不带这一项，服务端自己回退。`reasoningSettingsPayload` 负责这个转换，「恢复默认」= 清掉这一项。
- **概念清单永远自动接在提示词后面**（`buildInstructions`）：概念分组与成员、对象类型与它绑的表、关系类型、动作、数据资源
  都是**数据不是提示词**，让用户手写就会和本体漂移；抽屉里也把这句话写给了用户。
- 两条链路都认这个参数：`/api/reasoning/stream`（页面）与 `/api/reasoning/run`（一次性），
  服务端 `z.string().trim().max(20_000)`（前端 `SYSTEM_PROMPT_LIMIT` 与它对齐）；
  流式那条的审计里多记一个 `customSystemPrompt: boolean`（**不记原文**）。
- 改这块时注意：`settings.ts` 的 `clampField` 只认三个数字键（`NumericSettingKey`），别再往 `REASONING_SETTING_RANGES` 里塞非数字项。
- 实测（2026-09-14）：把提示词换成"严格三段：结论 / 依据 / 风险，全文不超过 200 字"后，模型照做；
  点「恢复默认」回到默认那段，localStorage 里那一项也清掉了。
- **刻意不放进配置的东西**：只读事务、语句超时、写操作拦截（护着数据库，不该由这个抽屉关掉）；
  模型与系统提示词也先不做成可改 —— 改坏了会把"只读""不查本体实例"这些规矩一起改没。

**智能问答的对话历史**（2026-09-14，对应原先的待办 L2）：

- 两张表（`platform-db.ts`）：`reasoning_conversations`（id / ontology_id / target_id / title / created_by）
  与 `reasoning_messages`（一轮问答：question / answer / thinking / thinking_on / `run` JSONB / error）。
  整份 `run` 都存下来，是为了"看以前的对话"能看到和当时一样的过程（轨迹 / 结论 / 依据），
  而不是只剩一段结论；消息靠外键 `ON DELETE CASCADE` 跟着对话一起走。
- **归属 = 提问的人 + 当前本体**：换个人登进来看到的是他自己的记录。正常按 `ontology_id` 归，
  只有直接选中一条未纳管的存储资源（没有本体）时才退化成按 `target_id` 归 ——
  所以本体换了落点之后，历史仍然跟着这个本体。
- 落库时机是**一轮问答真正跑完之后**（`/api/reasoning/stream` 里 `runReasoning` 返回、审计写完之后）。
  失败的一轮不进历史，不会出现"点进去只有半句话"的记录；落库失败只多发一条带 warning 的
  `saved` 事件，不影响已经生成的结论。
- 接口：`GET /api/reasoning/conversations?targetId=`（列表，只回摘要）、
  `GET|DELETE /api/reasoning/conversations/:id?targetId=`（完整内容 / 删除）。
  三个都先按「落点 → 本体 + 当前用户」把范围定死，别人的记录一律当不存在（404），
  不靠界面客气地不显示链接来兜底。
- 界面（`qa-studio.tsx`）：头部「对话历史」开关（开合状态记在 localStorage）+ 右侧 292px 侧栏，
  按 今天 / 昨天 / 更早 分组，点一条就把那次的完整过程铺回主区，删除走就地二次确认。
  侧栏用 `grid-template-areas` 挂在 `.qa-root` 上，**关掉时布局和以前一模一样**；
  原来头部的「清空」换成了「新对话」（同一个动作，但语义清楚了：清空的是画面，不是历史）。
- **步骤上要能看到工具入参**（2026-09-14）：同一轮里模型常连调好几次同一个工具
  （实例查询一次能出现九步），只显示工具名根本分不出哪一步查了什么。所以求证轨迹的每一行
  在工具名后面带一行 `key="值"` 的入参摘要（单行省略，`argumentSummary()`），点开后上半是
  **入参**（浅底，完整 JSON）、下半是**返回**（深底）—— 一浅一深交代方向，不用读标签。
  窄屏（≤900px）先让机器名 `code` 让位，入参留着。
- **步骤右侧写的是「拿到了什么」，不是证据条数**（2026-09-14 修）：`get_table_ddl` / `run_sql`
  按设计不产出证据（表结构、时序数据都不是可寻址的本体实体），早先这里用 evidence 的长度当"命中"，
  于是 `run_sql` 明明返回了 6 行也显示"无命中"，看着像工具什么都没查到（用户报的）。
  现在由 `tool-summary.ts` 纯函数按工具如实生成（`6 行` / `表结构 · 按列元数据还原` / `命中 2 个概念`），
  服务端在 `agent.ts` 写进 `ReasoningStep.summary`，界面直接显示；拿不到可说的东西时写"已返回"，
  **不编数字**。汇总行同步改成「已调用工具 N 次 · 证据 M 项 · Xs」，M 为 0 时不显示那一段。
- 纯函数在 `conversation-view.ts`（标题截断、日期分组、时间文案），有单测。**别从
  `@/lib/reasoning/conversations` 里 import 界面要用的东西** —— 它会拉起 pg 连接池，
  那是服务端专用的（`ConversationSummary` / `ConversationMessage` 这类契约类型定义在纯模块里）。

**推理范围：只在对象类型 / 关系类型这一层**（2026-09-14 决定，用户提出）：

只回答"本体里有哪些对象类型、它们的属性 / 父类 / 关系类型 / 动作 / 绑了哪张表"，**不查本体实例**
（图库里的对象与关系）。要真实数据有另一条通道：**对象类型绑定的源表**，用 `get_table_ddl` 看结构、
`run_sql` 只读查数（见下一节）。两者不要混起来说 —— "本体里没有对象"不等于"表里没有数据"。
做法上分三层，缺一层就不成立：

1. **工具层**：`REASONING_TOOLS` 里的 `query_object_instance` / `query_instance_subgraph` 标 `disabled: true`。
   `reasoningToolSet()` 与 `MCP_TOOLS`（tools/list、tools/call 用的那份）都按它过滤，所以模型与外部客户端
   都拿不到；`MCP_TOOL_CATALOG` 是全量目录，只给「MCP 调试」页，界面把 `disabled` 的那组**灰着列出来**
   （标题挂「暂不使用」、按钮点不动、顶部把可用数与暂不使用数分开写）—— 看得见"有这么两个工具，今天不用"。
   实现还留在 `runReasoningTool` 的两个 case 里，要恢复就删掉 `disabled`。
2. **提示词层**：system prompt 明确写"这一版只在本体定义这一层推理"，并要求被问到实例时直接说明范围、
   指到「对象」「图谱」页，**不许拿数量编答案**。
3. **数据层**：给模型看的文字里不出现实例层面的数字 —— 对象数 / 关系数已从 `schemaBrief`、`search_schema`
   的 `detail`、`get_object_type` 的 payload 里去掉（`weight` 仍按对象数算，只用于"没命中时的兜底排序"，
   不进文案）。同时那条兜底**不再按「有实例」筛**：图库还空着的本体以前一条都返回不了，现在不会。

加新工具或新字段时守住这条：**模型回答不了的层，就别把那一层的数字给它**。

**数据来源：只读 SQL 与表结构**（2026-09-14，用户提出）：

本体这一层只有定义，要具体数据就得走"对象类型 → 它绑定的表"。两个工具把这条路接上，
闸门写在 `src/lib/data-source/sql-guard.ts`（纯函数，有单测），**两道闸是有意重复的**：

- **词法闸门**判断语句"长得像不像查询"：必须以 SELECT / WITH / SHOW / DESC / DESCRIBE / EXPLAIN / VALUES /
  TABLE 开头；多条语句（分号）、`INTO`、INSERT / MERGE / DROP / ALTER / CREATE / GRANT / CALL 等一律拦下。
  判断前先剥掉注释与字符串字面量，所以 `SELECT '删库'` 放行、`/* x */ DROP TABLE t` 照样被拦。
  取值取向是**宁可偶尔误杀**（模型换个写法重来），也不要放过一次写操作。
- **数据库的只读事务**是权威的那道：PG `BEGIN READ ONLY`、MySQL `START TRANSACTION READ ONLY`、
  Oracle `SET TRANSACTION READ ONLY`（都跑在同一个 QueryRunner 上，两次 query 不会跑到不同连接）。
  驱动起不了只读事务时（自动提交模式那类）如实返回 `readOnlyTransaction: false`，工具把它报给模型，
  不让人以为库里有保险。实测这台 Oracle 是 `true`。
- **限量与超时**：SELECT / WITH 会被套一层行数上限（Oracle 用 ROWNUM 包一层，其它用派生表 + LIMIT），
  默认 50、最大 500；PG 加 `SET LOCAL statement_timeout`，MySQL 试 `SET SESSION MAX_EXECUTION_TIME`
  （MariaDB / 旧版不认就算了），Oracle 这一层没有等价开关。
- **DDL**：能拿原始语句就用原始的（MySQL `SHOW CREATE TABLE`、Oracle `DBMS_METADATA.GET_DDL`），
  拿不到就按列元数据还原，并在 `notes` 里写明"差在哪、为什么走了还原这条路"。
  实测这台 Oracle 报 `ORA-31603`（连接用户读不到那个 schema 的元数据），于是输出还原版
  `CREATE TABLE` + `COMMENT ON COLUMN`（注释取自 `all_col_comments`，是真值不是猜的）。
- `data_source` 用**数据资源名**（不是 id、不是图存储连接）；资源清单随 `schemaBrief` 进 system prompt，
  名字写错时错误信息会把当前登记的资源全列出来，模型可以自己改对。

已知缺口：`run_sql` 还没单独写审计 —— 谁在什么时候跑了哪条 SQL 只能在对话历史里看到。
要补得先把 actor 透进 `ToolContext`（工具层现在拿不到是谁在调）。

两条刻意的边界，改动时别无意破坏：

1. **只在已发布版本上推理**。草稿的定义与图库里的数据不是同一份，混着推会得出"定义说有、图里没有"的矛盾结论。
2. **工具只读**。让模型直接写图库风险太大（它可能编造对象 id）；写入继续走动作引擎 + 人工确认。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| L3 | 语义检索用向量 | `search_schema` 是关键词 + 中文 2 元组匹配，没有语义召回 | 等 R2 接上 embedding 后，给概念建向量索引，与关键词分数融合 |
| L4 | 让模型执行动作 | 工具全只读，动作只能看不能跑 | 若要开放，走"模型提议 + 人确认"：用 AI SDK 的 `toolApproval`（`new ToolLoopAgent({ tools, toolApproval: { name: 'user-approval' } })`）让工具返回审批请求而不是直接执行，流里会给到 `tool-approval-request`，由界面二次确认后再落到动作引擎。不要直接给写权限 |
| L5 | 多轮追问 | 一次运行一问一答，没有上下文（智能问答页只是把多轮**并列**展示）。会话表已随对话历史落地（`reasoning_conversations` / `reasoning_messages`），但**没有把上一轮喂给模型** | 把同一段对话里上一轮的结论压缩进 system；注意结论里的 id 仍是真实的才能复用 |

**L2（历史推理记录）已于 2026-09-14 完成**，见上面「智能问答的对话历史」一节。

**MCP 服务端已落地**（`src/lib/reasoning/mcp.ts` + `src/app/api/mcp/route.ts`）：

- 传输：Streamable HTTP，JSON 响应；实现 `initialize` / `ping` / `tools/list` / `tools/call`，
  通知回 202，GET 回 405（不做服务端推送）。协议版本 `2025-06-18`。
- 工具：`list_ontologies` + 上面那几个，**每个都多一个 `ontology_id`**（面向外部客户端时，隔离单位是本体而不是存储）。
- 鉴权：平台会话 Cookie（站内调试）或 `Authorization: Bearer <MCP_API_TOKEN>`（外部客户端）。
  令牌在 `.env.local`，没有它外部就连不上，不会静默放行。
- 复用 `reasoning/tools.ts` 的实现，一层都不重写 —— 避免"界面上查得到、MCP 里查不到"的漂移。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| V1 | MCP 调用审计 | 平台内的运行写 `REASONING_RUN` 审计，但**外部客户端经 MCP 调用没有留痕** | 在 `tools/call` 里写一条 `MCP_TOOL_CALL`（谁、哪个本体、哪个工具、耗时、命中数）；配合 U2 的审计界面一起看 |
| V2 | MCP 鉴权粒度 | 单一静态令牌：谁拿到都能查所有本体，也不能按用户吊销 | 改成平台 API Key（每人一个、可吊销），并把令牌绑定到本体范围；令牌轮换后写审计 |
| V3 | MCP 的 resources / prompts | 只实现了 tools 能力 | 若要给客户端直接挂"本体说明书"，可以加 `resources/list` 暴露本体概览；先等真实客户端需求 |
| V4 | MCP 侧的长任务通知 | 平台内的问答已经走 SSE 边跑边显示；MCP 工具仍是同步返回，大子图查询会让客户端干等 | 评估 MCP 的 progress 通知（`notifications/progress`），先看真实客户端是否需要 |

### 概念分组（业务域）

记录时间：2026-09-14。**用户方向：像 bkn-studio 的知识网络详情页那样，把对象类型按业务域（客户域 / 账务域 / 字典域…）
归堆，图谱上按组画框图。** 这一层是"人怎么看这个本体"，不是本体语义。

数据落在定义里（`src/lib/ontology.ts`）：

- `ontologyDefinitionSchema.groups: ConceptGroup[]`，一条是 `{ id, name, color }`；`color` 留空就按它在清单里的位置取
  `GROUP_PALETTE`（6 色，`concept-groups.ts`）。
- `entityTypes[].groupId`：空串 = 未归组。**分组的 id 与对象类型的 id 共用一套 id 空间**：导入时
  `ontology-bundle.ts` 的 `collectDefinitionIds` / `relinkDefinitionIds` 会把两者一起换成新 id，`groupId` 才跟着指对。

三条不变量（改这块时别破）：

1. **分组只影响展示与检索提示**：不写进图库（Jena / Neo4j 侧没有对应三元组）、不参与发布校验、不进推理结论。
   它唯一"进入推理"的地方是检索面与提示词：`schemaConcepts` 把分组名并进 haystack（问「客户域里有什么」能命中成员），
   `get_object_type` 返回 `group`，`schemaBrief` 在每个对象类型后面跟分组名。
2. **分组是对象类型这一层的东西**，不是对象（实例）的属性。实例图谱不画分组框，也不提供布局切换。
3. **归组只有一条路径**：`resolveGroup(groups, name)` —— 去掉前后空格、忽略大小写，重名复用，没有就新建（走这条路径的
   `groupName` 一律来自下拉选项，所以实际都是"复用"）。分组的增删改只在配置页做，别处只能"选"。

界面（配置只有一处，看效果有两处）：

- **概念分组标签**（2026-09-14 从左侧导航移进「本体草稿」页，`concept-group-manager.tsx`）：**唯一的分组配置入口**，与「可视化建模 / 表单」并列为同一页的第三个标签（左导航不再有这一项；画布工具栏的「概念分组 N」按钮切到这个标签）。
  左栏是色卡式的分组清单（那道色条就是图上框的颜色），右栏改名 / 换色（6 色调色板 + "按位置自动"，带虚线框预览）/ 点选成员 chip / 删除。
  **一个对象类型最多属于一个分组** —— 点一个已经在别组的 chip 会把它移过来，再点一下就是移出。
  改动先落在右栏草稿里（标题旁出现「未保存」，保存按钮这时才可用），点「保存分组」才写进草稿定义（一次性覆盖，避免两次写互相盖掉）；切换 / 新建分组时若有未保存改动先确认。两栏之间的分隔条可拖（宽度记在本机 `concept-group-split`），与对象页共用 `split-pane.ts` 的 `useSplitPane`。
- **对象类型侧只做"选"**：`type-edit-dialog.tsx` 的「概念分组」是**下拉**（选项来自上面那份分组清单，带"不分组"），
  不再让人随手填一个新名字；可视化的右栏也有同一个下拉，方便边看边调。
- **看效果的两处**：本体草稿可视化画布（`ontology-builder.tsx`，工具栏「概念分组 N」切到同页的「概念分组」标签）
  与「图谱 → 查看本体」（`graph-canvas.tsx` 的 `viewMode === "ontology"`）都有 `layout-switcher.tsx` 的布局切换器。
- **导入自带分组**：bkn 知识网络里的 `concept_groups` 由 `bkn-import.ts` 转成 `groups` + `entityTypes[].groupId`
  （成员写在分组那一侧，转换时反过来铺；一个类型挂多个分组时保留文件里的第一个并报 warning）。
- 布局三种：**默认布局**（按关系铺开）、**圆形布局**、**按逻辑分组**（`groupedLayoutPositions`：
  组内小圈 + 组心大圈 + 未归组最外圈，`orderFramesByEdges` 让连边多的组排相邻）。
- **三种布局都能拖节点**（2026-09-14 修：一开始把后两种的拖动关掉了，用户反馈"节点不能拖了"）。
  后两种的底图是算出来的，但点位取 **「手工覆盖 > 算出来的」**，而手工覆盖**按布局分别记**在本机：
  默认布局沿用老键 `ontology-builder:<存储 id>`，圆形 / 按逻辑分组各用 `…:circle` / `…:grouped`
  （本体骨架页同理，`ontology-layout:<存储 id>` 加后缀）。分开记才不会出现"默认布局摆好的位置一切到按逻辑分组就全乱"。
  拖完不会弹回去 —— 换布局、改定义、重开页面都还在。`GraphCanvas` 的骨架页写位置时是**合并**进现有映射（`{ ...read, ...next }`），
  不然一次拖动会把同一布局里其它拖过的节点覆盖掉。
- 分组框画在节点下面，按成员的**实时屏幕包围盒**算（`GroupFrameLayer` 挂在 `afterRender` 上），
  所以拖动时框会跟着节点的位置**收缩 / 扩大**，不用等松手。
- 「自动整理」= 清掉**当前布局**的手工覆盖 + 换一个 seed 重新算（后两种布局下就是整圈转一下）。
- 分组框由 `sigma-graph.tsx` 的 `GroupFrameLayer` 画：按成员的屏幕包围盒算虚线圆角框 + 左上角组名，
  `afterRender` / 相机变化时重画；z-index 比边线层低，框永远在点和线下面。
- 布局选择记在 localStorage（`ontology-layout-mode:<本体 id>` / `ontology-builder:<存储 id>:layout`）：它属于"我怎么看这张图"，不进草稿。

工具与 MCP：

- `list_concept_groups`（无参数）：返回 `group_count` / `groups[{ name, object_types[], object_type_count }]`
  （**空分组也列**）/ `ungrouped_object_types`（`groupId` 指向已删除分组的类型也算未归组）/ `note`；
  evidence 是 `{ kind: "GROUP", id, label }`。
- **工具读的是已发布定义**（和别的推理工具同一条口径）：刚在草稿里分好组、还没发布时，
  `list_concept_groups` 会说"没有分组"。要让它看到，先发布一次。
- MCP 侧标题「概念分组」，归在 `model` 组（`mcp.ts` 的 `TOOL_TITLES` / `TOOL_GROUP`，漏了会退化成原始工具名 + 默认分组）。

| 编号 | 事项 | 现状 | 建议做法 |
| --- | --- | --- | --- |
| U5 | 分组只在草稿侧可编辑 | 「查看本体」页只读，没有归组入口；分组顺序也固定按创建顺序 | 改定义本来就走草稿，保持只读；若要把分组当"域目录"浏览，就在「查看本体」右侧加只读的分组列表 |
| U6 | 分组没进筛选层 | 布局、检索提示、`list_concept_groups` 都用到了分组，但对象页与图谱筛选仍只能按类型 | 等 R1（对象页接检索层）落地后加"按分组筛"：把分组成员展开成类型清单再筛 |
| U7 | 左侧导航不显示计数 | bkn-studio 的导航每个条目都带数量（概念分组 6 / 对象类 18…），平台这边一个都没有 | 要补就一起补（本体、对象类型、关系类型、动作、分组），只补一个会显得突兀；计数从当前草稿的 `definition` 直接数 |

### 工程清洁

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| C1 | `src/lib/version-store.test.ts` 命名过时 | 用例实际测试 `version-snapshot.ts`，文件应与被测模块同名 |
| C2 | 端到端用例覆盖不足 | `e2e/` 目前只有一个版本工作区 smoke；本体存储创建向导、发布失败提示、SPARQL 工作台、数据资源浏览与类绑定都还没有 e2e |
