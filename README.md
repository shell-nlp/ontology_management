<p align="center">
  <img src="src/app/icon.svg" alt="本体管理平台" width="80" height="80" />
</p>

<h1 align="center">本体管理平台</h1>

<p align="center">
  <em>Ontology Management</em>
</p>

<p align="center">
  面向 Neo4j 与 Apache Jena 的本体与图数据管理平台<br/>
  可插拔图数据库抽象 · 版本化本体快照 · 草稿安全编辑 · 发布重建图数据
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=nextdotjs&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img alt="Neo4j" src="https://img.shields.io/badge/Neo4j-Graph-008CC1?style=flat-square&logo=neo4j&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Platform_DB-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white" />
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-Unit_Tests-6E9F18?style=flat-square&logo=vitest&logoColor=white" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square&logo=apache&logoColor=white" /></a>
  <img alt="Status" src="https://img.shields.io/badge/status-Active-success?style=flat-square" />
</p>

---

使用 Next.js 管理多个图数据库（当前支持 Neo4j 与 Apache Jena）；在已有 PostgreSQL 的 `ontology_platform` Schema 中保存账号、加密的本体存储凭据、版本索引与审计记录。

图数据库访问统一收敛在 `src/lib/graph` 抽象层：上层 API 与界面只调用 `GraphStore`，不感知 Cypher / SPARQL 差异。接入新的图后端只需新增一个适配器。

本体类型与实例数据统一按 **版本快照** 管理：

```text
草稿编辑 → 校验 → 发布 / 激活 → 重建图数据
   │                                    │
   └──── 只写本地快照文件 ──────────────┘  成功后才更新版本状态
```

## 目录

- [能力概览](#能力概览)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [统一版本快照](#统一版本快照)
- [角色与安全](#角色与安全)
- [服务端接口](#服务端接口)
- [数据资源](#数据资源)
- [目录结构](#目录结构)
- [开发约定](#开发约定)

## 能力概览

| | 模块 | 说明 |
| :---: | --- | --- |
| 📐 | **本体草稿** | 类、关系类型、端点契约与属性规则；校验后发布 |
| 🔗 | **对象与关系** | 对象绑定单一已发布类型（Label）；关系端点须符合契约 |
| 🧩 | **属性系统** | 文本 / 整数 / 小数 / 布尔 / 日期 / 日期时间 / 文本数组 / JSON |
| 👁 | **双视图** | 本体视图看已发布类型；运行时 Schema 由各后端推导（Neo4j / RDF）。两种视图的节点都可拖拽摆放：有草稿的实例位置写入图快照，只读浏览与本体骨架的摆放只记在本机浏览器 |
| ⌨️ | **查询工作台** | 按本体存储后端切换 Cypher / SPARQL；默认只读，禁止绕过发布直接写入 |
| 🗄 | **本体存储管理** | 按图数据库类型分组；凭据 AES-256-GCM 加密入库，主密钥仅在服务端 |
| 🔌 | **图数据库抽象** | `GraphStore` 接口 + 适配器注册表，Neo4j 与 Apache Jena 已实现 |
| 🧱 | **数据资源** | 外部关系库的只读连接（PostgreSQL / MySQL / Oracle）：列结构、字段与数据预览，再把类绑到表上 |
| 📦 | **统一版本** | 类型 + 对象 + 关系完整快照；草稿写文件，发布才写图 |

## 技术栈

| 层级 | 选型 |
| --- | --- |
| 前端 / API | Next.js（App Router）、React 19 |
| 图数据库 | Neo4j · `neo4j-driver`；Apache Jena / Fuseki · SPARQL 1.1 |
| 平台元数据 | PostgreSQL · Schema `ontology_platform` |
| 图可视化 | Sigma / Graphology、React Flow |
| 校验 | Zod |
| 工具链 | pnpm · TypeScript · Vitest · ESLint · Playwright |

## 快速开始

### 1. 环境变量

```bash
cp .env.example .env.local
```

| 变量 | 必填 | 说明 |
| --- | :---: | --- |
| `DATABASE_URL` | ✅ | PostgreSQL 连接串（自动使用 `ontology_platform`） |
| `TARGET_ENCRYPTION_KEY` | ✅ | 32 字节 Base64 密钥：`openssl rand -base64 32` |
| `AUTH_SECRET` | ✅ | ≥32 位随机串，签署会话 Cookie |
| `BOOTSTRAP_ADMIN_EMAIL` | 首次 | 首个管理员邮箱 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次 | 首个管理员密码 |
| `ONTOLOGY_VERSION_DIR` | 可选 | 快照目录，默认 `<项目>/.data/ontology-versions` |

### 2. 安装与启动

```bash
pnpm install
pnpm dev
```

打开 [http://localhost:3000](http://localhost:3000)。

### 3. 首次初始化

```bash
curl -X POST http://localhost:3000/api/bootstrap
```

创建 `ontology_platform` Schema 与首个管理员。已初始化时返回 `409`。

### 4. 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` / `pnpm start` | 生产构建与启动 |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript 检查 |

## 统一版本快照

一个版本是 **不可拆分** 的完整快照，不只是类型定义。

### 快照文件

| 文件 | 内容 |
| --- | --- |
| `definition.json` | 类、关系类型、端点契约、属性规则 |
| `nodes.csv` | 对象稳定 ID、Label、属性 JSON |
| `relationships.csv` | 关系稳定 ID、起止对象 ID、类型、属性 JSON |
| `manifest.json` | 格式版本、本体存储、版本号、数量、时间、SHA-256 |

版本索引与状态（版本号、状态、数量、哈希、发布时间）就写在同一个快照目录的 `manifest.json` 里，**快照文件是实例数据与版本状态的唯一事实来源**。PostgreSQL 只保存账号、本体存储与审计记录；`ONTOLOGY_VERSION_DIR` 因此是所有实例共享的持久卷。

### 生命周期

```text
┌─────────────┐    ┌─────────────┐    ┌──────────┐    ┌────────────────┐
│ 1. 创建草稿  │ →  │ 2. 编辑草稿  │ →  │ 3. 校验   │ →  │ 4. 发布 / 激活  │
│ 复制或导出  │    │ 只改本地文件 │    │ 定义+实例 │    │ 事务重建图      │
└─────────────┘    └─────────────┘    └──────────┘    └────────────────┘
```

1. **创建草稿** — 优先复制当前发布版；升级后首版从当前图数据导出  
2. **编辑草稿** — 类型 / 对象 / 关系 / 属性 / 画布位置只改文件；写操作须带 `versionId`  
3. **校验** — 必填/唯一、实例类型、关系端点与契约  
4. **发布** — 由后端适配器整图替换，必须原子：要么整体生效，要么图保持原样  
5. **激活历史** — 同一发布流程；存在草稿时禁止切换  

### 发布的原子性与并发

`GraphStore.replaceGraph()` 有硬性契约：**失败时图数据必须保持替换前的状态**，由 `capabilities.atomicReplace` 声明，发布流程据此决定失败提示的措辞。

| 后端 | 原子替换的实现 |
| --- | --- |
| Neo4j | 单个写事务内 `DETACH DELETE` + 分批 `UNWIND CREATE`，任一批失败整体回滚 |
| Apache Jena | 单个 SPARQL Update 请求完成「清空 + 插入」（TDB2 上单请求即事务）；超过 5000 条三元组时先写入影子命名图，再用一个请求 `CLEAR + ADD + DROP` 原子切换 |

发布过程写三条审计：`VERSION_PUBLISH_STARTED`（含后端类型与 `atomicReplace`）、`VERSION_PUBLISHED` / `VERSION_ACTIVATED`、失败时的 `VERSION_PUBLISH_FAILED`（含 `graphReplaced`，用于判断图是否已被改动）。同一个本体存储的发布在进程内队列与 PostgreSQL advisory lock 两层串行，多实例部署也不会并发替换同一个本体存储。

发布成功后才更新版本状态，并对账 `ontology_*` 约束与索引。

### 稳定标识

`elementId()` 在重新导入后会变化，不能作长期引用。快照使用 UUID；发布时 UUID 仅事务内连边，完成后从节点移除，不污染业务属性。

### 部署注意

> **多实例生产环境**：`ONTOLOGY_VERSION_DIR` 必须是所有实例共享的持久卷，不能用各机本地临时目录。

无实例快照的旧归档版本不可激活；当前发布版与草稿会在首次使用时从真实 Neo4j 生成快照。

## 角色与安全

| 角色 | 权限 |
| --- | --- |
| `ADMIN` 本体存储、本体版本、实例写入、Cypher 写入（需确认） |
| `VIEWER` | 登录、浏览与只读查询 |

- 会话：HttpOnly Cookie，`AUTH_SECRET` 签署  
- 数据面：Neo4j / PostgreSQL 仅服务端访问，浏览器不接触密码与主密钥  
- 写入边界：业务写经草稿快照与发布；Cypher 默认只读，避免绕过版本  

## 服务端接口

<details>
<summary><b>认证与初始化</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/bootstrap` | 创建 Schema 与首个管理员（仅一次） |
| `POST` | `/api/auth/login` | 登录，签发会话 Cookie |
| `POST` | `/api/auth/logout` | 登出 |
| `GET` | `/api/auth/session` | 当前会话 |

</details>

<details>
<summary><b>本体存储（Neo4j / Apache Jena）</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/targets` | 列表 / 登记 |
| `GET` / `PATCH` / `DELETE` | `/api/targets/:targetId` | 查看 / 更新 / 删除 |
| `GET` | `/api/targets/:targetId/schema` | 运行时 Schema |
| `POST` | `/api/targets/:targetId/test` | 连接测试 |
| `POST` | `/api/targets/:targetId/reset` | 重置本体存储状态 |

</details>

<details>
<summary><b>本体版本</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/ontology` | 列表 / 创建草稿 |
| `GET` / `PATCH` / `DELETE` | `/api/ontology/:versionId` | 读取 / 更新 / 删除草稿 |
| `POST` | `/api/ontology/:versionId/validate` | 校验草稿 |
| `POST` | `/api/ontology/:versionId/publish` | 发布并重建图 |
| `POST` | `/api/ontology/:versionId/activate` | 激活历史快照 |

</details>

<details>
<summary><b>实例（草稿快照）</b></summary>

写操作面向草稿 `versionId`；读可按本体存储与版本查询。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/instances/entities` | 对象列表 / 创建 |
| `GET` / `PATCH` / `DELETE` | `/api/instances/entities/:elementId` | 对象读写删 |
| `GET` / `POST` | `/api/instances/relationships` | 关系列表 / 创建 |
| `GET` / `PATCH` / `DELETE` | `/api/instances/relationships/:elementId` | 关系读写删 |
| `GET` | `/api/instances/graph` | 图数据 |
| `GET` | `/api/instances/types` | 运行时类型 |
| `GET` | `/api/instances/meta` | 元信息 |
| `GET` | `/api/instances/search` | 搜索 |
| `GET` | `/api/instances/neighbors` | 一度邻居扩展（后端无关） |
| `POST` | `/api/instances/positions` | 画布位置 |

</details>

<details>
<summary><b>查询工作台</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/query` | 按连接的后端执行只读 Cypher / SPARQL，写入一律 409 |

</details>

<details>
<summary><b>数据资源（外部关系库）</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/data-sources` | 列表 / 登记数据资源 |
| `GET` / `PATCH` / `DELETE` | `/api/data-sources/:sourceId` | 查看 / 更新（密码留空即不变）/ 删除 |
| `POST` | `/api/data-sources/test` | 用表单里的参数试连一次，不落库 |
| `POST` | `/api/data-sources/:sourceId/test` | 按已保存的连接试连 |
| `GET` | `/api/data-sources/:sourceId/views` | 表与视图清单；`schema=*` 表示看全库，`search=` 过滤 |
| `GET` | `/api/data-sources/:sourceId/views/:viewName` | 字段清单 + 若干行数据预览（只读） |

</details>

## 图数据库抽象

`src/lib/graph` 是唯一的图数据库访问入口：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `GraphTarget`、`GraphData`、`RuntimeTypeSet`、`GraphStore` 契约与连接元数据 |
| `neo4j.ts` | Neo4j 适配器：Cypher、约束/索引、`db.schema.visualization` |
| `jena.ts` | Apache Jena / Fuseki 适配器：SPARQL 1.1、RDF ↔ 属性图映射 |
| `index.ts` | `getGraphStore(target)` 注册表，按 `target.kind` 分派 |

### 本体存储配置字段

| 字段 | Neo4j | Apache Jena |
| --- | --- | --- |
| `uri` | `neo4j://host:7687` | Fuseki 服务地址，如 `http://host:3030`（也接受 `/ds/query`、`/ds/sparql`） |
| `database_name` | 数据库名 | 数据集名 |
| `username` / `password` | 必填 | 可选（写入通常需要管理员凭据） |
| `options.namedGraph` | — | 可选，写入/读取指定命名图，默认图可留空 |

RDF 与属性图的映射：`?s rdf:type ?t` → 节点标签，字面量三元组 → 节点属性，资源三元组 → 关系；关系自身属性用 `urn:bkn:Relationship` 具体化表达，同时保留一条直接三元组，外部 SPARQL 工具照常可查。

### 新增图后端

1. 在 `GraphTargetKind` 登记类型，并在 `GRAPH_TARGET_KINDS` 补齐连接表单元数据；
2. 新增实现 `GraphStore` 的适配器；
3. 在 `getGraphStore` 中注册。

API 路由、版本发布流程与界面组件无需改动。

## 数据资源

数据资源是**外部数据来源**，和本体存储不是一回事：本体存储（Neo4j / Apache Jena）是本体自己的落库位置，数据资源是「类下面那些对象从哪来」。

`src/lib/data-source` 是唯一的数据来源访问入口：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `DataSourceKind`、`DATA_SOURCE_KINDS` 连接表单元数据、`DataSourceConnector` 契约；纯类型，客户端可直接引用 |
| `sql.ts` | 关系库适配器：TypeORM 建连接，`test / listViews / describeView / previewView`；Oracle 走数据字典读结构 |
| `index.ts` | `openDataSourceConnector(record, credentials)` 注册表，按 `record.kind` 分派 |

当前支持 PostgreSQL、MySQL、Oracle。三类共用同一份 SQL 实现，接入新的关系库通常只需要在 `DATA_SOURCE_KINDS` 里加一条元数据；接入 Elasticsearch、REST、文件这类非关系来源时，在 `openDataSourceConnector` 里分流到一个新实现即可 —— 界面与 API 不用改。

### 对象与数据表的对应关系

参照 Palantir 的模型：**类 ≈ 数据集，对象 ≈ 一行，属性 ≈ 一列**。因此绑定写在**类**上，而不是逐个对象上：

| 绑定项 | 含义 |
| --- | --- |
| 数据资源 + 表 / 视图 | 这个类的对象来自哪张表 |
| 主键字段（可复合） | 一个对象的身份 |
| 显示名字段 | 对象在列表与图谱上的标题 |
| 属性映射 | 类的属性对应哪个列 |

绑定信息保存在版本快照的类定义里（`entityTypes[].source` 与 `properties[].sourceField`），草稿改动即时落库，历史版本读出来是空绑定，不会报错。

### 连接配置

| 类型 | 连接串 | 驱动 | 容器 |
| --- | --- | --- | --- |
| PostgreSQL | `postgresql://user@host:5432/db` | `pg` | 模式（schema），可留空 |
| MySQL | `mysql://user@host:3306/db` | `mysql2` | 库名即容器 |
| Oracle | `oracle://user@host:1521/SERVICE` | `oracledb` | 模式（schema / 用户），可留空 |

Oracle 注意两点：服务端版本较旧（11g 及更早）时必须用 Instant Client 走 Thick 模式，把客户端目录配到 `ORACLE_CLIENT_LIB_DIR`（或放进 `.data/oracle-client/`）；结构清单直接读 `all_tables` / `all_tab_columns` 等数据字典，不走 ORM 的 `getTables()`。

## 目录结构

```text
ontology_management/
├── src/
│   ├── app/              # 页面与 API 路由
│   ├── components/       # 工作台、图画布、属性编辑器
│   └── lib/              # 认证、图数据库抽象（graph/）、数据来源抽象（data-source/）、本体、版本快照
├── docs/
│   └── adr/              # 架构决策记录
├── e2e/                  # Playwright 端到端
├── .env.example
├── LICENSE
└── package.json
```

设计细节见 [`docs/adr/`](docs/adr/)。

## 开发约定

- 包管理统一使用 **pnpm**（见 `packageManager`）
- 业务逻辑优先放在 `src/lib`，API 路由保持薄封装
- 改动版本快照 / 发布流程时，同步关注 `src/lib/version-snapshot.ts` 与相关 ADR

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 开源许可。

```text
Copyright 2026 本体管理平台 Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

<p align="center">
  <sub>本体管理平台 · Ontology Management · Apache-2.0</sub>
</p>
