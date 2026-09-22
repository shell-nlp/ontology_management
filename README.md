<p align="center">
  <img src="src/app/icon.svg" alt="本体管理平台" width="80" height="80" />
</p>

<h1 align="center">本体管理平台</h1>

<p align="center">
  <em>Ontology Management</em>
</p>

<p align="center">
  本体建模 · 版本化快照 · 可插拔图存储 · 数据资源 · 智能问答与 MCP<br/>
  默认使用平台自带的内置图存储；Apache Jena / Fuseki 是可选后端，随时可换
</p>

<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge" />
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=nextdotjs&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white" />
</p>

<p align="center">
  <img alt="Graph Store" src="https://img.shields.io/badge/Graph_Store-Embedded_|_Apache_Jena-6D4AFF?style=flat-square" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-Platform_DB-4169E1?style=flat-square&logo=postgresql&logoColor=white" />
  <img alt="MCP" src="https://img.shields.io/badge/MCP-Ontology_Tools_+_Skills-1F7A57?style=flat-square" />
  <img alt="AI SDK" src="https://img.shields.io/badge/AI_SDK-7-000000?style=flat-square" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white" />
  <img alt="Vitest" src="https://img.shields.io/badge/Vitest-Unit_Tests-6E9F18?style=flat-square&logo=vitest&logoColor=white" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square&logo=apache&logoColor=white" /></a>
  <img alt="Status" src="https://img.shields.io/badge/status-Active-success?style=flat-square" />
</p>

---

平台管三件事：**本体是什么**（对象类型、关系类型、接口、概念分组）、**本体能做什么**（动作与规则）、**本体里的数据从哪来**（数据资源绑定与对象检索）。本体按**版本快照**管理：草稿只写本地文件，发布才重建图数据。

图存储是**可替换的**：默认用平台自带的内置图存储（PostgreSQL 持久化，不需要外部服务），也可以在「设置 → 图引擎配置」里登记 Apache Jena / Fuseki；上层 API 与界面只调用 `GraphStore` 抽象，不感知具体引擎。平台库（PostgreSQL `ontology_platform`）保存账号、连接、审计、对象检索索引与版本状态。

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
- [Docker Compose 部署](#docker-compose-部署)
- [统一版本快照](#统一版本快照)
- [本体包（导出与导入）](#本体包导出与导入)
- [智能问答与 MCP](#智能问答与-mcp)
- [本体技能](#本体技能)
- [对象从哪来](#对象从哪来)
- [角色与安全](#角色与安全)
- [服务端接口](#服务端接口)
- [图存储抽象](#图存储抽象)
- [数据资源](#数据资源)
- [目录结构](#目录结构)
- [开发约定](#开发约定)

## 能力概览

按 Palantir 的说法，本体由两部分组成，左侧导航也是按这个分的：

| | 是什么 | 平台里的位置 |
| --- | --- | --- |
| **本体模型** | 本体「是什么」：对象类型（Object Type）与它们的属性、关系类型、接口、概念分组 | 本体建模 · 本体技能 |
| **本体实例** | 本体里"实际有什么"：对象与关系，以及它们的实例图谱 | 实例图谱 · 对象 · 关系 |
| **动力模型** | 本体「能做什么」：动作（唯一的业务写入口），以及挂在动作上的规则 / 动态安全 | 动作 · 规则 |
| **能力验证** | 把本体交给模型与外部 Agent 用起来：智能问答（工具循环）与 MCP 服务 | 智能问答 · MCP 调试 |

「总览」同时展示当前本体的运行状态与本体列表，可在列表中搜索、新建、导入、打开或导出。数据资源（本体脚下来自哪张表）与本体存储（本体落在哪个图库）是平台层；图引擎连接在「设置 → 图引擎配置」管理。
| | 模块 | 说明 |
| :---: | --- | --- |
| 📐 | **本体建模** | 对象类型、关系类型、端点契约与属性规则；保存为草稿，校验后发布 |
| 🔗 | **对象与关系** | 对象绑定单一已发布类型（Label）；关系端点须符合契约 |
| 🪪 | **接口（Interfaces）** | 抽象契约：只描述"实现我的对象类型必须有哪些属性与关系"，不绑数据、不能实例化；一个对象类型可实现多个接口、接口可继承接口。本体建模的「接口」标签可查看定义和实现情况 |
| 🧩 | **属性系统** | 文本 / 整数 / 小数 / 布尔 / 日期 / 日期时间 / 文本数组 / JSON；每个属性可带**显示名**与**说明**（外部本体的中文名与口径原文能原样带进来） |
| 👁 | **建模与实例图谱** | 本体建模画布查看和搜索对象类型、属性、关系类型；图谱只展示实例。两处节点都可拖拽摆放：有草稿的实例位置写入图快照，建模画布的位置只记在本机浏览器 |
| ⌨️ | **只读查询** | 实例图谱页可展开的只读查询（内置与 Jena 共用同一套模板）；写入一律拒绝，避免绕过版本 |
| 🗄 | **图引擎配置** | 内置图存储开箱可用；也可登记 Apache Jena / Fuseki，凭据 AES-256-GCM 加密入库 |
| 🔌 | **存储抽象** | `GraphStore` 契约 + 注册表（内置 / Jena 两个适配器），业务 API 不直接依赖具体引擎 |
| 🧱 | **数据资源** | 外部关系库的只读连接（PostgreSQL / MySQL / Oracle）：列结构、字段与数据预览，再把类绑到表上（一个类可挂多份来源，按主键合并属性） |
| 📦 | **统一版本** | 类型 + 对象 + 关系完整快照；草稿写文件，发布才写图 |
| 📤 | **本体包** | 一个 `.ontology.json` 带走整份**结构**（类 / 关系类型 / 动作 / 规则 + 数据资源坐标），导入停在草稿。不含实例数据，也不含凭据 |
| 🧭 | **概念分组** | 画布上的逻辑分组：先建分组，再在对象类型上选归属；智能问答可以按分组找类型 |
| 🤖 | **智能问答** | 服务端工具循环（AI SDK）：模型只调只读工具（本体检索、多跳、表结构、只读 SQL），流式输出、可中断、可带图片、带会话历史 |
| 🛰 | **MCP** | 两个服务端：本体数据工具（会话或令牌）与建模技能（免令牌），外部 Agent / IDE 直接接 |
| ✨ | **本体技能** | 三套建模技能（需求澄清 → 本体设计 → 出包交付），整包下载，或经 MCP 直接给 Agent 用 |
| 🔍 | **对象检索** | 对象索引（全文 / 模糊 / 向量，当前落 PostgreSQL）+ 回源策略；海量业务对象不进进程内存 |
| 🧾 | **审计记录** | 发布、导入、删除、改名等关键操作留痕，在「设置 → 审计记录」里按动作筛选 |

## 技术栈

| 层级 | 选型 |
| --- | --- |
| 前端 / API | Next.js 16（App Router）、React 19、TypeScript |
| 本体存储 | 默认**内置图存储**（PostgreSQL 持久化 + Graphology 类型图 + N3.js / Comunica 只读 SPARQL）；可选 **Apache Jena / Fuseki**。Neo4j 已移除 |
| 平台元数据 | PostgreSQL · Schema `ontology_platform` · TypeORM（业务侧不写裸 SQL） |
| 对象检索 | PostgreSQL 索引表：`tsvector` 全文 + `pg_trgm` 模糊 + `pgvector` 向量；缺扩展自动降级 |
| 智能问答 | AI SDK 7（`ai` + `@ai-sdk/openai-compatible`）：服务端工具循环、流式输出、可中断 |
| 对外协议 | MCP：本体数据工具与建模技能两个服务端 |
| 图可视化 | Sigma + Graphology（实例图谱）、React Flow（本体建模画布） |
| 数据资源驱动 | `pg` · `mysql2` · `oracledb`（Thick 模式，镜像内置 Instant Client） |
| 契约与文档 | Zod；OpenAPI 由 `next-openapi-gen` 生成，Swagger UI 在 `/docs` |
| 工具链 | pnpm · Vitest · ESLint · Playwright |

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
| `AUTH_COOKIE_SECURE` | 可选 | 会话 Cookie 的 Secure 开关；留空按请求实际协议判断（推荐） |
| `GRAPH_ENDPOINT_HOST_ALIAS` | 可选 | Jena 端点主机名改写；容器默认 `localhost=host.docker.internal`，外部服务可覆盖 |
| `MCP_API_TOKEN` | 可选 | 外部 MCP 客户端访问 `/api/mcp` 用的 Bearer 令牌；不配则只有平台会话能连（站内「MCP 调试」不受影响） |
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

无需手动调用接口。首次访问平台时自动创建 `ontology_platform` Schema；若用户表为空，
平台会用 `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` 创建首个管理员。
已有用户时不会重新创建，也不会因修改环境变量而重置密码。
`POST /api/bootstrap` 暂时保留给旧调用方；自动初始化后调用它会返回 `409`。

### 4. 常用脚本

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 开发服务器 |
| `pnpm build` / `pnpm start` | 生产构建与启动 |
| `pnpm test` | 单元测试（Vitest） |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript 检查 |
| `pnpm docker:up` / `docker:down` / `docker:logs` | 容器部署（见下一节） |

## Docker Compose 部署

编排只包含 **`app`**（本体平台）。PostgreSQL（平台库）、业务数据源和可选的
Apache Jena/Fuseki 图引擎都由你单独部署；不用 Jena 时无需运行 Fuseki。已有 Jena 本体仍可连接
外部服务，移除编排服务并不删除 Jena 适配器或 `.data/fuseki` 旧数据。

```bash
cp .env.docker.example .env.docker    # 填 DATABASE_URL 与密钥（模板里有逐项说明）
pnpm docker:up                        # = docker compose --env-file .env.docker up -d --build
pnpm docker:logs                      # 跟日志
```

`pnpm docker:*` 都带 `--env-file .env.docker`：这个文件既给容器注入变量，也给 compose 做变量替换，
所以 `APP_PORT` / `VERSION_SNAPSHOT_DIR` / `NODE_IMAGE` 也写在里面（模板第 0 节）。手动敲命令时
记得带上这个参数，否则这几个变量取不到值。

不带 `--env-file` 直接 `docker compose up -d` 也能起（Docker Desktop 上点按钮、IDE 里的 compose up
都走这条路），但那时用的是**默认值**：版本快照使用项目下的 `./.data/ontology-versions`，
Jena 端点中的 `localhost` 改写为 `host.docker.internal`；仍需 `.env.docker` 提供平台库与密钥。
固定配置请用 `pnpm docker:up`。

| 命令 | 用途 |
| --- | --- |
| `pnpm docker:up` | 构建并后台启动（`docker compose up -d --build`） |
| `pnpm docker:down` | 停止并删除平台容器（版本快照在绑定目录或命名卷里，不会丢） |
| `pnpm docker:logs` | 跟踪平台日志 |
| `pnpm docker:config` | 打印合并后的编排，排查变量问题 |

三处容易踩的地方：

1. **容器里的 `localhost` 是容器自己。** 连宿主机上的平台库要用 `host.docker.internal`：
   `DATABASE_URL=postgresql://用户:密码@host.docker.internal:5432/库名`（compose 已加
   `host.docker.internal:host-gateway`，Linux 上也能这么写）。如果另行部署的 Jena 在宿主机，库里
   登记的 endpoint 是 `http://localhost:3030/ds`，容器默认用
   `GRAPH_ENDPOINT_HOST_ALIAS=localhost=host.docker.internal` 改写；远端 Jena 请直接登记可达地址。
2. **`TARGET_ENCRYPTION_KEY` 必须与库里已有数据所用的那一把一致**：数据资源的凭据是加密后存进平台库的，
   换一把钥匙就解不开已登记的连接。`AUTH_SECRET` 换掉只会让已登录会话失效，可以重新生成。
3. **首次登录不必再调初始化接口**：确认环境中已配置管理员邮箱和密码，平台库为空时会自动创建首个管理员；若库里已有用户，这两个变量不会覆盖现有密码。

其他细节：

- 端口：宿主机 `3000` 被占用时用 `APP_PORT=3100 docker compose up -d` 换一个。
- **可选 Jena/Fuseki**：自行部署、管理数据集和管理员密码，然后在「设置 → 图引擎配置」中登记
  可从平台容器访问的地址。升级现有 Compose 配置时，旧 `ontology-fuseki` 容器可能成为孤儿；本次改动
  不自动停止或删除它，`.data/fuseki` 数据目录也保持原样。旧 `.env.docker` 中的 `FUSEKI_*` 参数
  不再配置服务，建议手动移除（`env_file` 仍会把它们注入 app 环境）。
  如果旧连接登记的是 `http://fuseki:3030`，请改成独立服务可达地址，或设置
  `GRAPH_ENDPOINT_HOST_ALIAS=fuseki=host.docker.internal`（服务仍映射到宿主机 3030 时）。
- **用机器 IP / 域名走 http 访问时，登录能站住**：会话 cookie 的 `Secure` 按**这次请求实际的协议**决定
  （反向代理后面看 `x-forwarded-proto`），不再只看 `NODE_ENV`。早先只看 `NODE_ENV`，容器里
  `NODE_ENV=production` 恒成立，于是 http 访问发出去的是 Secure cookie，浏览器直接丢掉 ——
  现象就是"登录成功了一下马上又被踢回登录页"（localhost 例外，浏览器把它当安全源，所以只在这台机器上
  用 localhost 测是查不出来的）。前端是 https 而代理没带头时，用 `AUTH_COOKIE_SECURE=true` 兜底。
- **版本快照目录是状态，不是缓存**：库里只记"某本体发布了 v2"，定义本身在快照目录里
  （容器内 `/data/ontology-versions`，默认绑到项目 `.data/ontology-versions` —— 与本机开发服务同一份，
  `docker compose down` 不会删它；也可以把 `VERSION_SNAPSHOT_DIR` 写成卷名改用命名卷，
  Linux 服务器用绑定挂载时要 `chown -R 1000:1000`，容器里的 node 用户是 uid 1000）。
  把部署搬到新机器时，要么把旧机器的 `<项目>/.data/ontology-versions` 带过来并让
  `VERSION_SNAPSHOT_DIR` 指向它，要么部署完在界面「本体建模」里重新发布一次 ——
  不带过去的话，模型工具会答"本体还没有发布版本"，图库也跟库里记的版本对不上。
  同一个平台库上同时跑着本机开发服务时，更要把它指到项目里的同一个目录：两边各写各的快照，
  会出现"一边发布、另一边读不到"。
- 拉不动 Docker Hub 时用镜像站：`NODE_IMAGE=docker.1ms.run/node:24-bookworm-slim docker compose up -d --build`
  （Windows PowerShell 先 `$env:NODE_IMAGE="docker.1ms.run/node:24-bookworm-slim"`）。
- **Oracle 开箱可用**：镜像里装好了 Linux 版 Instant Client，`ORACLE_CLIENT_LIB_DIR` 指向
  `/opt/oracle/instantclient` —— 因为要连的服务端只支持 Thick 模式（Thin 模式会被服务端以 NJS-138 拒掉）。
  构建时优先用 `docker/oracle/` 下的 `instantclient-basiclite-linux.x64-*.zip`，没有才去 Oracle 官网下载，
  公司网络受限时把 zip 放进 `docker/oracle/` 即可离线构建。想换成自备客户端就挂载到 `/opt/oracle/instantclient`
  并设 `ORACLE_CLIENT_LIB_DIR`（Windows 的 dll 在容器里用不了）。
- 平台库需要 `pg_trgm` 与 `pgvector` 扩展（对象检索层会 `CREATE EXTENSION IF NOT EXISTS`）；
  没有权限时检索自动降级成 `ILIKE`，不影响其他功能。

## 统一版本快照

一个版本是 **不可拆分** 的完整快照，不只是类型定义。

### 快照文件

| 文件 | 内容 |
| --- | --- |
| `definition.json` | 类、关系类型、端点契约、属性规则 |
| `nodes.csv` | 对象稳定 ID、Label、属性 JSON |
| `relationships.csv` | 关系稳定 ID、起止对象 ID、类型、属性 JSON |
| `manifest.json` | 格式版本、本体存储、版本号、数量、时间、SHA-256 |

版本索引与状态（版本号、状态、数量、哈希、发布时间）就写在同一个快照目录的 `manifest.json` 里，**快照文件是版本状态与草稿的事实来源**。Jena 发布后写入命名图；内置后端把当前发布视图原子保存在 PG 的 `embedded_graphs` 表，运行时从中重建小型类型图。`ONTOLOGY_VERSION_DIR` 仍是所有平台实例共享的持久卷。

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
| Apache Jena | 单个 SPARQL Update 请求完成「清空 + 插入」（TDB2 上单请求即事务）；超过 5000 条三元组时先写入影子命名图，再用一个请求 `CLEAR + ADD + DROP` 原子切换 |
| 内置类型图 | PostgreSQL 单行 UPSERT 原子替换发布视图，查询只见旧版本或新版本；Graphology/N3.js 视图按需重建 |

发布过程写三条审计：`VERSION_PUBLISH_STARTED`（含后端类型与 `atomicReplace`）、`VERSION_PUBLISHED` / `VERSION_ACTIVATED`、失败时的 `VERSION_PUBLISH_FAILED`（含 `graphReplaced`，用于判断图是否已被改动）。同一个本体存储的发布在进程内队列与 PostgreSQL advisory lock 两层串行，多实例部署也不会并发替换同一个本体存储。

发布成功后才更新版本状态，并对账 `ontology_*` 约束与索引。

### 稳定标识

`elementId()` 在重新导入后会变化，不能作长期引用。快照使用 UUID；发布时 UUID 仅事务内连边，完成后从节点移除，不污染业务属性。

### 部署注意

> **多实例生产环境**：`ONTOLOGY_VERSION_DIR` 必须是所有实例共享的持久卷，不能用各机本地临时目录。

无实例快照的旧归档版本不可激活；当前发布版与草稿会在首次使用时从真实图库生成快照。

## 本体包（导出与导入）

版本快照是**平台内部**的形态：一个目录四个文件，id 全是本机的 UUID。要在人和环境之间传播，
需要的是另一种东西 —— **本体包**：一个 `.ontology.json` 文件，单文件、自描述、只装结构。

```json
{
  "format": "ontology.bundle",
  "formatVersion": 1,
  "exportedAt": "2026-09-14T06:58:39.413Z",
  "generator": { "name": "ontology-management", "version": "0.1.0" },
  "ontology": { "identifier": "m3-1789283543253", "name": "...", "description": "...", "color": "", "tags": ["m3"] },
  "statistics": { "objectTypes": 3, "relationTypes": 1, "actionTypes": 0, "rules": 0, "objects": 3, "relationships": 0 },
  "dataSources": [{ "id": "<导出端的数据资源 id>", "kind": "ORACLE", "host": "39.164.136.34", "port": 1251, "databaseName": "orcl", "schemaName": "GISTOOLS" }],
  "definition": { "entityTypes": [], "relationshipTypes": [], "actionTypes": [], "rules": [] }
}
```

三条不变量：

1. **`definition` 就是平台内部的 `OntologyDefinition`，原样进出。** 不新造一套形状，
   所以导出/导入不可能出现"两份定义各说各话"。
2. **包里绝不写凭据。** 数据资源只记连接坐标（kind / host / port / 库 / 模式），
   导入端按坐标去匹配本机已登记的资源。
3. **导入一定停在草稿。** 别人的文件不该绕过版本边界——导入只写本地快照，
   校验、发布仍走平台既有流程。

### 导入时做的三件事

1. **换 id。** 包里的 UUID 全部重发新号，接口与实现、关系端点、动作作用域、规则条件一起改写
   （一次遍历建立映射，避免"边改边查"漏改）。
2. **接回数据资源。** 先按 kind + host + port + 库 + 模式五项全等匹配；只差模式时放宽一次并给出提醒；
   还是找不到就把这条来源绑定**留空**，并在弹窗里点名是哪个类需要重新选表——不静默丢绑定。
3. **建本体 + 写草稿。** 本体名（可改）与标识沿用包里的，标识被占用就自动加序号。

实例数据**不在**包里：`statistics.objects` 只是告诉接收方"导出端当时有多少对象"。
所以导入后的本体对象数是 0，需要自己补数据或从数据资源实例化。

### 也能导入 bkn 的知识网络

导入入口同时认 **bkn-foundry 导出的知识网络**（`module_type: knowledge_network`）。服务端会先把它
转成标准本体包再走同一条导入路径 —— 也就是说换 id、接数据资源、写草稿这些规则完全一致。
转换只搬我们装得下的，**装不下的逐条报出来**（概念域分组、指标、关系的连接规则 `mapping_rules`、
平台不认识的属性类型），不会静默丢：

- 属性带上 bkn 的 `display_name`（中文名）与 `comment`（说明）；
- `primary_keys` 落到来源绑定的主键上；没有数据来源的类，主键改记成"必填 + 唯一"并给出提醒；
- bkn 只写 `SCHEMA.TABLE`、不带数据库连接，所以来源资源要导入后自己在类型编辑里选一次。

## 智能问答与 MCP

「能力验证」这一组是同一个能力的两种用法：**平台内的问答**与**对外的 MCP 服务**共用同一套只读工具，
所以不会出现"界面上查得到、MCP 里查不到"的漂移。

### 智能问答（工具循环）

- **循环在服务端**：AI SDK 的 `ToolLoopAgent` 负责"模型选工具 → 执行 → 结果回灌 → 再选"，平台只负责提供事实工具。
- **工具全部只读**：本体概念检索、对象类型详情、概念分组、接口、多跳遍历、动作定义、表结构（DDL）、只读 SQL。写入业务数据的唯一入口是**动作**。
- **旋钮**在「问答配置」抽屉里：步数上限、单次工具返回长度、取数行数、历史轮数与系统提示词；默认都不限制（服务端兜底防死循环）。
- **流式与中断**：回答按「思考 / 正文 / 工具步」分段流式回传，可随时停止；提问支持附带图片。
- **会话历史**存在平台库，可回看、可删除；上下文过长时由框架负责裁剪压缩。

### MCP（两个服务端）

| 服务端 | 地址 | 鉴权 | 提供什么 |
| --- | --- | --- | --- |
| 本体数据 | `/api/mcp` | 平台会话或 `Bearer <MCP_API_TOKEN>` | 本体与 Schema 检索、对象类型详情与多跳、概念分组、接口、动作定义、表结构与只读 SQL |
| 建模技能 | `/api/skills/mcp` | **免令牌** | 三套建模技能的正文与参考文件（公开文档，不含凭据） |

「MCP 调试」页把工具逐个列出来：可以改参数、直接运行、看真实返回，也能复制各家客户端的接入配置（默认是通用 `mcp.json`）。
工具说明按「用途 / 输入 / 产出 / 下一步调谁」写，模型不点开 schema 也知道怎么用。

## 本体技能

平台自带三套建模技能，目标是让 Agent 按本平台的规范建模，并直接产出**能导入的本体包**：

| 技能 | 干什么 | 产物 |
| --- | --- | --- |
| `ontology-requirement` | 需求澄清：把业务描述问成可建模的清单 | 澄清后的对象类型 / 关系类型 / 动作清单 |
| `ontology-builder` | 本体设计：按建模细则设计对象类型、关系类型、接口、动作 | 设计稿与校验结论 |
| `ontology-bundle` | 出包交付：把设计编译成平台可直接导入的本体包 | `.ontology.json` |

- **模型只写结构化清单，脚本负责编译**：手写 UUID 与 id 引用最容易出错，所以由 `skills/ontology-bundle/scripts/build-bundle.mjs` 生成最终包（只用 Node 内置模块，Windows / Linux / macOS 同一套命令）。
- 技能页可以**整包下载** zip（解压进 `~/.codex/skills/` 之类的目录），也可以直接走上面的**免令牌 MCP**。

## 对象从哪来

平台把"对象"和"对象存在哪"解耦成两层，读路径只有一条：

```text
界面 / 智能问答 / MCP
        │  按「对象类型 + 主键」取对象
        ▼
   对象服务（Object Service）
        │  auto（默认）：先查索引，索引里没有就回源
        ├──► 对象检索索引（Object Index）   当前落 PostgreSQL：全文 / 模糊 / 向量
        └──► 数据资源连接（DataSourceConnector）  Oracle / PostgreSQL / MySQL 只读事务
```

- **索引层**是可选加速：对象量大时把常用类型物化进索引表，检索、过滤、分页都快；不物化也能用，代价是每次回源查业务库。
- **回源**按对象类型上绑定的数据资源与主键字段读，只走只读事务与语句白名单。
- 换中间件（例如把检索索引换成独立搜索引擎）只替换扩展点，对象服务、界面与 AI 工具一行都不用改。

## 角色与安全

| 角色 | 权限 |
| --- | --- |
| `ADMIN` | 本体与版本、数据资源、图引擎连接、导入导出、本体编辑与删除、审计；实例与动作写入 |
| `VIEWER` | 登录、浏览、只读查询与智能问答（工具全部只读） |

- 会话：HttpOnly Cookie，`AUTH_SECRET` 签署  
- 数据面：图库 / PostgreSQL 仅服务端访问，浏览器不接触密码与主密钥  
- 写入边界：业务写经草稿快照与发布；原生查询一律只读，避免绕过版本  

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
<summary><b>图引擎连接</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` / `POST` | `/api/targets` | 列表 / 登记 |
| `GET` / `PATCH` / `DELETE` | `/api/targets/:targetId` | 查看 / 更新 / 删除 |
| `GET` | `/api/targets/:targetId/schema` | 运行时 Schema |
| `POST` | `/api/targets/:targetId/test` | 连接测试 |
| `GET` | `/api/targets/:targetId/clear` | 清空前的预览：当前有多少对象与关系 |
| `POST` | `/api/targets/:targetId/clear` | 清空图数据（全部节点与关系）；需键入本体存储名称确认，仅动图库，平台版本与快照保留 |
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
| `GET` | `/api/ontologies/:ontologyId/export` | 导出本体包（单文件 JSON，仅结构） |
| `POST` | `/api/ontologies/import` | 从本体包导入：建本体 + 写草稿（不发布） |

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
<summary><b>只读查询</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/query` | 执行只读 SPARQL，写入一律 409 |

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

<details>
<summary><b>智能问答</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/reasoning/stream` | 流式问答（SSE：思考 / 正文 / 工具步 / 收尾） |
| `POST` | `/api/reasoning/run` | 非流式运行，给脚本与调试用 |
| `GET` | `/api/reasoning/tools` | 工具清单与启用状态 |
| `GET` | `/api/reasoning/status` | 模型与运行状态 |
| `GET` / `DELETE` | `/api/reasoning/conversations` | 会话历史列表 / 清空 |
| `GET` / `DELETE` | `/api/reasoning/conversations/:conversationId` | 单个会话的轮次 / 删除 |

</details>

<details>
<summary><b>MCP 与技能</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/mcp` | 本体数据 MCP 服务（会话或令牌） |
| `GET` | `/api/mcp/info` | 该 MCP 服务的接入信息与工具清单 |
| `POST` | `/api/skills/mcp` | 建模技能 MCP 服务（免令牌） |
| `GET` | `/api/skills` | 技能清单 + MCP 接入信息 |
| `GET` | `/api/skills/archive` | 全部技能打包成 zip |

</details>

<details>
<summary><b>对象检索与审计</b></summary>

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/objects/index` | 把对象按类型同步进检索索引 |
| `POST` | `/api/objects/materialize` | 物化：把来源数据写进索引 |
| `POST` | `/api/object-search` | 按关键词与过滤条件检索对象 |
| `POST` | `/api/object-search/reindex` | 重建索引 |
| `GET` | `/api/audit` | 审计记录（`scope=changes` / `actions` / `reads` / `all`，仅管理员） |

</details>

## 图存储抽象

`src/lib/graph` 是统一的本体存储访问入口，测试统一放在 `tests/`，按相同目录层次组织：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `GraphTarget`、`GraphData`、`RuntimeTypeSet`、`GraphStore` 契约与连接元数据 |
| `jena/index.ts` | Apache Jena / Fuseki 适配器：SPARQL 1.1、RDF ↔ 属性图映射 |
| `embedded/index.ts` | 内置适配器：平台 PG 持久化，Graphology 类型图与 N3.js / Comunica 只读 SPARQL |
| `index.ts` | `getGraphStore(target)` 注册表，按 `target.kind` 分派 |

### 本体存储配置字段

| 字段 | 说明（Apache Jena） |
| --- | --- |
| `uri` | Fuseki 服务地址，如 `http://host:3030`（也接受 `/ds/query`、`/ds/sparql`） |
| `database_name` | 数据集名 |
| `username` / `password` | 可选（写入通常需要管理员凭据） |
| `options.namedGraph` | 可选，写入/读取指定命名图，默认图可留空；平台给每个本体自动分配 `urn:ontology:<id>` |

RDF 与属性图的映射：`?s rdf:type ?t` → 节点标签，字面量三元组 → 节点属性，资源三元组 → 关系；关系自身属性用 `urn:bkn:Relationship` 具体化表达，同时保留一条直接三元组，外部 SPARQL 工具照常可查。

内置类型图由代码作为虚拟存储选项提供，不在 `graph_targets` 中创建根资源记录；不需要配置凭据，也不能删除该选项。新建或导入具体本体时才持久化独立的受管目标。在「总览」中新建或导入本体时默认选择它；需要外部服务时仍可在「设置 → 图引擎配置」中新建 Jena 连接。**图引擎配置不是本体**，不会自动生成空本体。类型图只包含定义；为了兼容现有手工对象页面，当前发布视图可以暂存少量实例，但**海量业务对象不能进入这份 JSONB 视图或进程内 RDF Store**。Jena 保留且继续可选，现有 Jena 本体不会自动改变后端；若要迁移定义，可导出本体包，在新存储上导入并核验。当前本体包不携带实例数据。

### 多个本体放在哪（隔离）

平台的「发布」是**整图替换**：Jena 侧清掉目标命名图（没配命名图时是默认图）后重写。
因此**同一个「数据集 + 命名图」上不能登记两个本体存储**——两边会互相看见数据，发布时互相清空。
新建 / 编辑本体存储时平台会拦下这种情况（HTTP 409），并说明怎么改。

Jena 的隔离单位是**命名图**，不是「多起一套实例」；内置后端由受管目标 ID 隔离，SPARQL 只看当前目标的 RDF 数据集：

| 做法 | 适用 | 说明 |
| --- | --- | --- |
| 命名图（默认做法） | Apache Jena | 一个数据集里一个本体一个命名图。在「总览」中新建本体时**不用选**，平台自动分配 `urn:ontology:<本体 id>`，同一个 Fuseki 上可以并存任意多个本体 |
| 多 dataset | Apache Jena | 需要按环境 / 租户再分一层时，一个 Fuseki 下配多个 dataset，登记存储时选不同数据集 |
| 独立实例 | Apache Jena | 需要资源或权限硬隔离时才单起一套 Fuseki/TDB2；日常使用不需要 |

### 新增图后端

1. 在 `GraphTargetKind` 登记类型，并在 `GRAPH_TARGET_KINDS` 补齐连接表单元数据；
2. 新增实现 `GraphStore` 的适配器；
3. 在 `getGraphStore` 中注册。

API 路由、版本发布流程与界面组件无需改动。

## 数据资源

数据资源是**外部业务数据来源**，和本体存储不是一回事：本体存储（内置或 Jena）管理本体发布视图，数据资源回答「对象类型对应的业务数据从哪来」。

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
| 数据资源 + 表 / 视图 | 这份来源读哪张表 |
| 主键字段（可复合） | 主来源里，这几列是一个对象的身份 |
| 显示名字段 | 对象在列表与图谱上的标题 |
| 属性映射 | 类的属性取自哪一份来源的哪个列 |

### 一个类挂多份来源（多来源对象类型）

一个类可以从多张表拼属性，对应 Palantir 的 **column-wise MDO**（[官方说明](https://palantir.com/docs/foundry/object-permissioning/multi-datasource-objects/)）：

- `entityTypes[].sources[0]` 是**主来源**：对象的身份（`primaryKey`）与标题（`titleField`）由它决定。
- 后面的每一份是**补充来源**：`primaryKey` 写的是「这张表里哪几列对应对象主键」，按列位置一一对齐，就是两份来源的连接条件。
- 属性用 `properties[].sourceId` 指回那份来源，再用 `sourceField` 指向具体列；`sourceId` 为空表示主来源。

绑定信息保存在版本快照的类定义里（`sources` 与 `properties[].sourceField` / `sourceId`），草稿改动即时落库。加多来源之前的老快照里是单个 `source` 字段，读出来会自动折成 `sources[0]`，不会丢绑定。

编辑面板（类 → 编辑）按这个形状做：主来源卡在最上面，补充来源依次挂在下面，每份补充来源的连接键直接画成「主键列 → 本表列」的对位关系；属性映射一行三格：属性、来源、列。

发布前检查会顺带核查来源绑定，分两档：

| 情况 | 处理 |
| --- | --- |
| 补充来源选了表却没有连接键、连接键列数和主键对不上、属性指向一份已经不在类上的来源 | **拦下来**，属于配置自相矛盾 |
| 主来源还没选表 / 还没指定主键、补充来源还没选表、同一张表挂了两次 | 只提示（`warnings`），不拦发布 —— 平台现在还不从绑定取数，建模阶段允许先把结构搭起来 |

### 读取成本与缓存

结构清单不便宜（Oracle 要扫一遍数据字典，PG / MySQL 要走一次 ORM 的 `getTables`），所以读取分两层缓存，都能主动穿透：

| 层 | 行为 | 什么时候失效 |
| --- | --- | --- |
| 服务端 | 结构清单按「连接 + 容器」缓存 60 秒，命中时不建连接、不查库 | 超过 60 秒，或请求带 `refresh=1`（界面上的「刷新结构」） |
| 前端 | 资源清单、结构清单、表字段与预览按 key 存在会话内存里，切页面回来先渲染缓存再后台取最新一份 | 改过连接信息（整条丢掉）、超过缓存条数上限、整页刷新 |

单表读取走精确路径：Oracle 按 `owner + 表名` 直接查 `all_tables` / `all_views` 定位，再取列与预览，不再为了一张表扫整库。

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
│   ├── app/              # 页面与 API 路由（含 /docs 的 OpenAPI 页面）
│   ├── components/       # 工作台、建模画布、实例图谱、动作、问答、MCP 调试
│   └── lib/
│       ├── graph/        # 图存储抽象：内置（embedded/）与 Jena（jena/）两个适配器 + 注册表
│       ├── data-source/  # 数据资源抽象：Oracle / PostgreSQL / MySQL
│       ├── object-index/ # 对象检索索引（当前落 PostgreSQL）
│       ├── object-service/ # 对象从哪来：索引 / 回源 / 自动
│       ├── reasoning/    # 智能问答：工具循环、工具集、提示词、会话历史、MCP
│       ├── db/           # TypeORM 实体与迁移
│       └── ...           # 本体定义、版本快照、本体包、接口、动作引擎、认证、审计
├── skills/               # 随平台下发的建模技能（Markdown + 出包脚本）
├── docs/                 # 设计文档与架构决策记录
├── scripts/              # OpenAPI 生成等构建脚本
├── docker/               # Oracle Instant Client 等镜像内资源
├── e2e/ · tests/         # Playwright 端到端与 Vitest 单测
├── .env.example
├── LICENSE
└── package.json
```

设计细节见 [`docs/`](docs/) 与 [`skills/README.md`](skills/README.md)。

## 开发约定

- 包管理统一使用 **pnpm**（见 `packageManager`）
- 业务逻辑优先放在 `src/lib`，API 路由保持薄封装
- 改动版本快照 / 发布流程时，同步关注 `src/lib/version-snapshot.ts` 与相关 ADR
- 改 `src/lib/ontology.ts` 的本体 schema 时，同步改 `skills/ontology-bundle/references/` 下的格式文档与示例包（`skills.test.ts` 会校验）
- 日常验证统一用 `pnpm dev`，不在日常流程里跑生产构建

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
