# Atlas Ontology

面向 Neo4j 的本体管理平台。平台使用 Next.js 和 `neo4j-driver` 管理多个 Neo4j 目标，使用已有 PostgreSQL 数据库中的 `ontology_platform` Schema 保存账号、加密目标凭据、本体版本和审计记录。

## 能力

- 本体草稿：预先定义实体类型、关系类型、端点契约与属性规则，校验后发布。
- 实体与关系：实体只能选用一个已发布实体类型作为 Neo4j Label；关系只能选用一个已发布关系类型，且端点必须符合契约。
- 属性：支持文本、整数、小数、布尔值、日期、日期时间、文本数组和 JSON；规则定义于类型，值编辑于实例。
- 双视图：本体视图展示全部已发布类型；运行时 Schema 视图调用 `CALL db.schema.visualization()` 展示目标库事实。
- Cypher 工作台：默认只读。管理员执行写入语句时需要显式写入模式和单次确认；查看者只能查询。
- 目标管理：Neo4j 密码使用 AES-256-GCM 加密后存入 PostgreSQL，主密钥只存在服务端环境变量。

## 启动

1. 复制 `.env.example` 为 `.env.local`，填入已有 PostgreSQL 的连接串和三个密钥/初始管理员变量。
2. 执行 `pnpm install`。
3. 执行 `pnpm dev`，访问 [http://localhost:3000](http://localhost:3000)。
4. 首次初始化时调用 `POST /api/bootstrap`，平台会创建 `ontology_platform` Schema 和首个管理员。

## 服务端接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/login` | 本地账号登录并签发 HttpOnly 会话 Cookie |
| `GET/POST /api/targets` | 查看或登记 Neo4j 目标 |
| `GET /api/targets/:targetId/schema` | 读取 `CALL db.schema.visualization()` 结果 |
| `GET/POST /api/ontology` | 查看或创建本体草稿版本 |
| `POST /api/ontology/:versionId/validate` | 依据已有图数据校验草稿 |
| `POST /api/ontology/:versionId/publish` | 校验后发布，并生成显式配置的约束或索引 |
| `POST /api/ontology/:versionId/activate` | 将具有完整快照的历史版本重新导入并激活 |
| `POST /api/cypher` | 在指定目标执行受权限和确认策略保护的 Cypher |

所有 Neo4j 与 PostgreSQL 操作均在 Next.js 服务端执行；浏览器不会收到数据库密码或加密主密钥。

## 统一版本快照

本体版本同时管理类型定义、实体和关系数据。草稿编辑只写 `ONTOLOGY_VERSION_DIR` 下的 `definition.json`、`nodes.csv`、`relationships.csv` 和 `manifest.json`，不会直接修改 Neo4j；发布或激活历史版本时才在事务中完整重建目标图。生产多实例部署必须为该目录配置共享持久卷。
