# 第 10 章 · MCP 服务与外部集成

## 10.1 平台提供两个 MCP 服务

平台把两类能力分别发布成两个独立的 MCP 服务端，**职责与鉴权都不同，不要混用**：

| | 本体数据 MCP | 建模技能 MCP |
| --- | --- | --- |
| 地址 | `/api/mcp`、`/api/mcp/<本体 id>` | `/api/skills/mcp` |
| 提供什么 | 本体定义、表结构、只读数据查询、可选对象实例查询 | 三套建模技能的 Markdown、参考文件与出包脚本 |
| 鉴权 | 平台会话令牌，或 MCP 访问令牌 | **免令牌** |
| 能力 | `tools` | `tools` + `prompts` |
| 数据敏感性 | 含本体定义与业务数据入口，必须鉴权 | 仅仓库内公开文档，不含凭据与本体数据 |

两个服务端都是 **Streamable HTTP JSON 响应**形态，协议版本 `2025-06-18`。

## 10.2 本体数据 MCP 的两种地址

### 平台级端点：`/api/mcp`

- 一个端点覆盖平台上所有本体；
- 每次调用由参数 `ontology_id` 决定查哪个本体；
- `tools/list` 按全局默认工具策略返回；
- 适合“还不知道要查谁、先列本体”的客户端。

### 本体级端点：`/api/mcp/<本体 id>`

- 地址把本体钉死；
- `tools/list` 按这个本体生效的工具开关过滤；
- `tools/call` 自动注入 `ontology_id`，客户端不用也不该自己填；
- `initialize` 的说明里会写明绑定的本体名称与 id；
- 配置片段一眼能看出这条 MCP 查的是哪个本体。

## 10.3 鉴权

本体数据 MCP 支持两种 Bearer：

| 方式 | 来源 | 用途 |
| --- | --- | --- |
| 平台会话令牌 | 平台登录接口返回的 JWT | 平台内“MCP 调试”页、脚本、已有平台账号 |
| MCP 访问令牌 | 平台生成、可多条、可撤销 | 外部 Agent / IDE；一条令牌配一个客户端 |

补充规则：

- `.env.local` 的 `MCP_API_TOKEN` 仍然认，作为一条**只读兜底**；
- 生产环境推荐在“MCP 调试 → MCP 接入”里生成平台管理的令牌；
- 明文令牌加密保存，只有具备 `mcp.token.manage` 权限的管理员可以查看和撤销；
- 平台管理令牌支持多条，撤销哪条只断哪条；
- 换掉 `TARGET_ENCRYPTION_KEY` 会导致已有令牌解不开，需要撤销后重新生成。

### 权限

| 操作 | 权限 |
| --- | --- |
| 进入 MCP 调试页、调用 MCP 数据工具 | `reasoning.use` |
| 生成 / 查看 / 撤销访问令牌 | `mcp.token.manage` |
| 修改工具开关 | `mcp.token.manage` |

## 10.4 协议能力

本体数据 MCP 实现以下 JSON-RPC 2.0 方法：

| 方法 | 说明 |
| --- | --- |
| `initialize` | 返回协议版本、服务名、能力与使用说明 |
| `notifications/initialized` | 客户端初始化通知；服务端不返回响应 |
| `ping` | 连通性检查 |
| `tools/list` | 按当前策略返回可用工具 |
| `tools/call` | 调用工具；错误放在 `result.isError`，让模型能自我纠正 |

其他行为：

- 支持单条和批量 JSON-RPC 请求；
- 全是通知时返回 `202`，无响应体；
- `GET` 返回 405：本实现不做服务端主动推送；
- `OPTIONS` 返回 CORS 预检响应；
- 工具返回 MCP 标准的 `content` 文本与 `structuredContent`。

## 10.5 工具清单

### 默认开启

| 工具 | 说明 |
| --- | --- |
| `list_ontologies` | 仅 MCP 平台级端点：列出本体，拿 `ontology_id` |
| `search_schema` | 语义检索对象类型、关系类型、动作、接口、指标与属性 |
| `get_object_type` | 对象类型详情 |
| `list_concept_groups` | 概念分组清单 |
| `list_interfaces` | 接口清单 |
| `traverse_object_types` | 对象类型多跳 |
| `get_table_ddl` | 表结构 + 列画像 + 反向引用 |
| `run_query` | 本体查询 DSL（结构化问数优先入口） |
| `run_sql` | 只读 SQL（DSL 兜底与排障） |
| `list_metrics` | 指标定义 |

### 出厂默认关闭

| 工具 | 说明 |
| --- | --- |
| `list_actions` | 动作定义与规则 |
| `query_object_instance` | 按对象类型查真实对象 |
| `query_instance_subgraph` | 按对象类型与关系类型取子图 |

这三个可以在“MCP 调试”里按全局默认或按本体单独打开。关闭后工具在外部客户端眼里等于不存在。

### 平台固定关闭

当前没有平台固定关闭（`disabled`）的工具。`run_query`（查询 DSL 工具）已于 2026-10-10 开放，进入「默认开启」清单。

## 10.6 工具开关：全局默认与本体覆盖

工具开关分两层：

| 层级 | 存储 key | 行为 |
| --- | --- | --- |
| 全局默认 | `reasoning.toolPolicy` | 所有本体的基底 |
| 本体覆盖 | `reasoning.toolPolicy:<ontologyId>` | 该本体单独配置；有覆盖就按覆盖走 |

界面显示“跟随全局 / 当前本体单独配置”，可以一键恢复跟随全局。开关由 `mcp.token.manage` 权限控制，服务端在 `tools/list` 和 `tools/call` 两次都检查，避免“列表没有但直接调用能跑”。

## 10.7 在 MCP 调试页调试

入口：**能力验证 → MCP 调试**。

页面分两档：

| 档位 | 内容 |
| --- | --- |
| 工具 | 逐个小试，跑真实 MCP 协议；可以看到请求、响应与错误 |
| MCP 接入 | 地址、作用域切换、客户端配置片段、令牌管理 |

调试页用的也是同一个端点、同一套协议；它不直接调内部函数。这样可以验证客户端真正会看到什么。

## 10.8 客户端配置示例

通用 `mcp.json`：

```json
{
  "mcpServers": {
    "ontology-management": {
      "type": "http",
      "url": "http://<平台地址>/api/mcp/<本体 id>",
      "headers": {
        "Authorization": "Bearer <MCP 访问令牌>"
      }
    }
  }
}
```

Claude Code 命令行：

```bash
claude mcp add --transport http ontology-management http://<平台地址>/api/mcp/<本体 id> \
  --header "Authorization: Bearer <MCP 访问令牌>" \
  --scope user
```

Cursor `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "ontology-management": {
      "url": "http://<平台地址>/api/mcp/<本体 id>",
      "headers": {
        "Authorization": "Bearer ${env:MCP_API_TOKEN}"
      }
    }
  }
}
```

说明：

- 有的客户端把 `type` 写成 `streamable-http`，含义一样；
- 平台级地址是 `/api/mcp`，本体级地址是 `/api/mcp/<本体 id>`；推荐用本体级，配置能看出查的是谁；
- 不要把明文令牌提交到仓库；Cursor 用环境变量插值，Claude Code 用 `--scope user` 或项目 `.mcp.json` 时要确认访问范围；
- 页面上的配置片段在点过“查看令牌”后会自动带上真值。

## 10.9 推荐接入流程

1. 确认目标本体已经发布。
2. 进入“MCP 调试 → MCP 接入”，选择平台级或本体级地址。
3. 在令牌管理里生成一条令牌，命名成客户端名（例如 `cursor-张三`）。
4. 复制对应客户端的配置片段。
5. 在客户端里连接，先调 `tools/list` 看工具是否按预期。
6. 对平台级端点，先用 `list_ontologies` 拿 `ontology_id`。
7. 用 `search_schema` 确认概念名，再 `get_object_type` / `get_table_ddl` / `run_sql`。
8. 如果工具缺失，到“工具”档检查是不是被全局或本体策略关掉了。
9. 客户端不再使用时撤销对应令牌，不要留着长期闲置。

## 10.10 安全与审计

- 本体数据 MCP 是**只读**，写操作只能通过平台内动作；MCP 不提供写工具；
- 工具只读已发布版本，草稿不会暴露给外部客户端；
- 访问令牌逐条加密保存，查看与撤销需要权限；
- 令牌错误与未配置令牌是两种情况，调试页会分别提示；
- 工具开关变更写 `REASONING_TOOL_POLICY_UPDATED` 审计；
- MCP 的工具调用会随智能问答的 `REASONING_RUN` 或图查询写入审计；
- CORS 允许跨域，因此令牌就是实际边界，必须妥善保管。

## 10.11 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 客户端连上但没有工具 | 平台工具策略把工具关了 | 到 MCP 调试页按全局或按本体打开 |
| 平台级端点报缺少 `ontology_id` | 没有先调 `list_ontologies` 或用本体级地址 | 先列本体，或改用 `/api/mcp/<本体 id>` |
| 401 | 令牌错误、过期或用户已失效 | 重新生成 / 更新令牌 |
| 403 | 账号没有 `reasoning.use` 或 `mcp.token.manage` | 找管理员补权限 |
| 工具调用返回 `isError: true` | 这是给模型的工具错误，不是协议崩溃 | 看错误信息修正入参或先检查本体是否发布 |
| 看不到对象实例工具 | 该工具出厂默认关闭 | 按需打开，并确认有 `instance.read` |
| 看不到 `run_query` | 被工具开关关掉，或客户端连的是旧版本 | 到 MCP 调试页打开；工具本身已开放，DSL 不支持时可回退 `run_sql` |

## 10.12 当前限制

- 本体数据 MCP 只读，不提供写工具。
- 只认已发布版本；草稿和未发布对象不会出现。
- 结构化问数优先走 `run_query`（查询 DSL）；`run_sql` 保留为兜底与排障。
- 对象实例与关系子图工具默认关闭，需要显式打开。
- 技能 MCP 免鉴权，只提供公开文档；不要把敏感内容放进 `skills/` 目录。
- MCP 协议实现不包含服务端推送；客户端按请求-响应方式使用。