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

使用 Next.js 管理多个图数据库目标（当前支持 Neo4j 与 Apache Jena）；在已有 PostgreSQL 的 `ontology_platform` Schema 中保存账号、加密目标凭据、版本索引与审计记录。

图数据库访问统一收敛在 `src/lib/graph` 抽象层：上层 API 与界面只调用 `GraphStore`，不感知 Cypher / SPARQL 差异。接入新的图后端只需新增一个适配器。

本体类型与实例数据统一按 **版本快照** 管理：

```text
草稿编辑 → 校验 → 发布 / 激活 → 重建目标图数据
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
- [目录结构](#目录结构)
- [开发约定](#开发约定)

## 能力概览

| | 模块 | 说明 |
| :---: | --- | --- |
| 📐 | **本体草稿** | 实体类型、关系类型、端点契约与属性规则；校验后发布 |
| 🔗 | **实体与关系** | 实体绑定单一已发布类型（Label）；关系端点须符合契约 |
| 🧩 | **属性系统** | 文本 / 整数 / 小数 / 布尔 / 日期 / 日期时间 / 文本数组 / JSON |
| 👁 | **双视图** | 本体视图看已发布类型；运行时 Schema 由各后端推导（Neo4j / RDF） |
| ⌨️ | **查询工作台** | 按目标后端切换 Cypher / SPARQL；默认只读，禁止绕过发布直接写入 |
| 🗄 | **目标管理** | 按图数据库类型分组；凭据 AES-256-GCM 加密入库，主密钥仅在服务端 |
| 🔌 | **图数据库抽象** | `GraphStore` 接口 + 适配器注册表，Neo4j 与 Apache Jena 已实现 |
| 📦 | **统一版本** | 类型 + 实体 + 关系完整快照；草稿写文件，发布才写图 |

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
| `definition.json` | 实体类型、关系类型、端点契约、属性规则 |
| `nodes.csv` | 实体稳定 ID、Label、属性 JSON |
| `relationships.csv` | 关系稳定 ID、起止实体 ID、类型、属性 JSON |
| `manifest.json` | 格式版本、目标、版本号、数量、时间、SHA-256 |

PostgreSQL `ontology_platform.ontology_versions` 保存索引、状态、路径、数量与哈希；**快照文件是实例数据的事实来源**。

### 生命周期

```text
┌─────────────┐    ┌─────────────┐    ┌──────────┐    ┌────────────────┐
│ 1. 创建草稿  │ →  │ 2. 编辑草稿  │ →  │ 3. 校验   │ →  │ 4. 发布 / 激活  │
│ 复制或导出  │    │ 只改本地文件 │    │ 定义+实例 │    │ 事务重建图      │
└─────────────┘    └─────────────┘    └──────────┘    └────────────────┘
```

1. **创建草稿** — 优先复制当前发布版；升级后首版可从 Neo4j 导出  
2. **编辑草稿** — 类型 / 实体 / 关系 / 属性 / 画布位置只改文件；写操作须带 `versionId`  
3. **校验** — 必填/唯一、实例类型、关系端点与契约  
4. **发布** — 单事务清空并分批重建；任一批失败则整图回滚  
5. **激活历史** — 同一发布流程；存在草稿时禁止切换  

发布成功后才更新版本状态，并对账 `ontology_*` 约束与索引。

### 稳定标识

`elementId()` 在重新导入后会变化，不能作长期引用。快照使用 UUID；发布时 UUID 仅事务内连边，完成后从节点移除，不污染业务属性。

### 部署注意

> **多实例生产环境**：`ONTOLOGY_VERSION_DIR` 必须是所有实例共享的持久卷，不能用各机本地临时目录。

无实例快照的旧归档版本不可激活；当前发布版与草稿会在首次使用时从真实 Neo4j 生成快照。

## 角色与安全

| 角色 | 权限 |
| --- | --- |
| `ADMIN` | 目标、本体版本、实例写入、Cypher 写入（需确认） |
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
<summary><b>连接目标（Neo4j / Apache Jena）</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/targets` | 列表 / 登记 |
| `GET` / `PATCH` / `DELETE` | `/api/targets/:targetId` | 查看 / 更新 / 删除 |
| `GET` | `/api/targets/:targetId/schema` | 运行时 Schema |
| `POST` | `/api/targets/:targetId/test` | 连接测试 |
| `POST` | `/api/targets/:targetId/reset` | 重置目标状态 |

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

写操作面向草稿 `versionId`；读可按目标与版本查询。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/instances/entities` | 实体列表 / 创建 |
| `GET` / `PATCH` / `DELETE` | `/api/instances/entities/:elementId` | 实体读写删 |
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
| `POST` | `/api/query` | 按目标后端执行只读 Cypher / SPARQL，写入一律 409 |

</details>

## 图数据库抽象

`src/lib/graph` 是唯一的图数据库访问入口：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `GraphTarget`、`GraphData`、`RuntimeTypeSet`、`GraphStore` 契约与连接元数据 |
| `neo4j.ts` | Neo4j 适配器：Cypher、约束/索引、`db.schema.visualization` |
| `jena.ts` | Apache Jena / Fuseki 适配器：SPARQL 1.1、RDF ↔ 属性图映射 |
| `index.ts` | `getGraphStore(target)` 注册表，按 `target.kind` 分派 |

### 目标配置字段

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

## 目录结构

```text
ontology_management/
├── src/
│   ├── app/              # 页面与 API 路由
│   ├── components/       # 工作台、图画布、属性编辑器
│   └── lib/              # 认证、图数据库抽象（graph/）、本体、版本快照、目标
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
