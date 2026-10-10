# 查询 DSL（Ontology Query DSL）

> 状态：P0 已实现；P0.5 的外键式关系、中间表式关系、基数保护和多来源对象类型基础能力已落地；影子对拍与真实问题集验收待完成。
>
> 本文是查询 DSL 的系统说明，不是一次性设计稿。后续 DSL、解析器、编译器、执行器或工具行为发生变化时，必须同步更新本文。

## 1. 目标与定位

查询 DSL 是智能问答和外部 MCP 客户端访问业务数据的**统一逻辑查询协议**。

它解决的问题是：

- 模型不再直接生成 SQL
- 模型不再关心物理表名、列名、连接方式
- 业务口径从本体定义层统一解析
- SQL 只由后端编译器生成
- 未来可以继续接 Elasticsearch、知识库检索等后端

DSL 的基本链路：

```text
用户自然语言
  ↓
LLM
  ↓
run_query / query-dsl JSON
  ↓
Schema 校验
  ↓
语义解析 Resolve
  ↓
LogicalPlan / AST
  ↓
查询规划与能力检查
  ↓
SQL 编译器
  ↓
只读执行
  ↓
归一化结果
```

核心原则：

1. DSL 以对象类型、属性、关系类型、指标为中心，不暴露物理表。
2. LLM 不能提供 SQL、表名、列名或任意表达式片段。
3. 所有值使用参数绑定，不拼接到 SQL 字符串。
4. 不能保证语义等价的查询必须明确拒绝，不做静默近似。
5. 指标负责表达业务口径；临时聚合允许，但必须标记为 ad-hoc。
6. 关系 JOIN 只能通过本体关系类型产生，不能由模型自由编造 JOIN 条件。
7. 关系放大风险默认 fail-closed：聚合查询遇到可能重复计数的关系时拒绝执行。

## 2. 当前实现范围

### 2.1 已实现

- DSL v1.0 JSON/Zod 校验
- `records` 字段查询
- `aggregate` 聚合查询
- 递归 `and / or / not` 过滤
- 比较、集合、空值、字符串、区间、枚举标签操作符
- 指标引用与固定口径过滤
- 指标固定过滤编译为条件聚合
- `group_by / order_by / limit`
- 参数引用 `{ "param": "..." }`
- PostgreSQL / MySQL / Oracle SQL 编译
- 只读执行
- 行数上限与截断说明
- 枚举标签到实际码值的解析
- `run_query` 工具目录接入，当前为 disabled
- 单对象类型主来源查询
- 外键式关系 JOIN
- 中间表式关系 JOIN
- 关系基数放大保护
- 多来源对象类型（MDO）按主键对齐的补充来源 JOIN

### 2.2 P0.5 基础能力已落地

- 外键式关系 JOIN
- 中间表式关系 JOIN
- 关系基数放大保护
- 多来源对象类型（MDO，column-wise 多来源）
- 待补：与 `run_sql` 的真实问题集影子对拍、跨来源对象类型、更复杂的多跳关系规划
- 与 `run_sql` 的真实问题集影子对拍

### 2.3 暂不支持

- 任意 JOIN
- 用户自定义 SQL 表达式
- 任意函数
- 子查询
- CTE
- UNION
- 窗口函数
- 跨数据资源 JOIN
- Elasticsearch 编译器
- 知识库检索融合
- 权限与行级数据权限 DSL

## 3. DSL v1.0 规范

### 3.1 顶层结构

```json
{
  "version": "1.0",
  "kind": "records",
  "from": {
    "object_type": "对象类型名",
    "alias": "root"
  },
  "relationships": [],
  "where": {},
  "select": [],
  "group_by": [],
  "order_by": [],
  "limit": 100,
  "parameters": {}
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 当前固定为 `"1.0"` |
| `kind` | 是 | `records` 或 `aggregate` |
| `from.object_type` | 是 | 本体里的对象类型名 |
| `from.alias` | 否 | 默认 `root` |
| `relationships` | 否 | 受控关系遍历列表 |
| `where` | 否 | 递归过滤表达式 |
| `select` | 是 | 输出字段、指标或聚合 |
| `group_by` | 否 | 聚合维度 |
| `order_by` | 否 | 排序 |
| `limit` | 否 | 默认 100，最大 5000 |
| `parameters` | 否 | 查询参数值 |

### 3.2 字段引用

```json
{ "alias": "root", "property": "统计日期" }
```

- `alias` 默认是 `root`
- `property` 必须是对象类型上的属性名
- 属性由 Resolver 映射到物理列，模型看不到物理列

### 3.3 过滤表达式

逻辑组合：

```json
{ "and": [ ... ] }
{ "or": [ ... ] }
{ "not": { ... } }
```

条件：

```json
{
  "field": { "alias": "root", "property": "业务状态" },
  "op": "eq",
  "value": "A"
}
```

支持的操作符：

| 操作符 | 语义 | 备注 |
| --- | --- | --- |
| `eq` | 等于 | 通用 |
| `ne` | 不等于 | 通用 |
| `gt` / `gte` | 大于 / 大于等于 | 数值、日期 |
| `lt` / `lte` | 小于 / 小于等于 | 数值、日期 |
| `in` / `not_in` | 集合包含 / 不包含 | 值数组 |
| `contains` | 字符串包含 | 编译为参数化 LIKE，处理通配符转义 |
| `starts_with` | 前缀匹配 | 参数化 LIKE |
| `ends_with` | 后缀匹配 | 参数化 LIKE |
| `is_null` | 为空 | 不接受比较值 |
| `is_not_null` | 非空 | 不接受比较值 |
| `enum_label` | 按枚举标签比较 | 由属性 `enumValues` 解析到实际码值 |
| `in_range` | 闭区间 | 值必须是 `[from, to]` 两个元素 |

参数写法：

```json
{
  "op": "eq",
  "value": { "param": "date" }
}
```

对应：

```json
{
  "parameters": {
    "date": "2026-09-13"
  }
}
```

### 3.4 `select`

字段输出：

```json
{
  "field": { "alias": "area", "property": "地市名称" },
  "as": "地市"
}
```

指标输出：

```json
{
  "metric": "专线条数",
  "on": "root",
  "as": "条数"
}
```

临时聚合：

```json
{
  "aggregate": "SUM",
  "property": "税后优惠后收入",
  "on": "root",
  "as": "收入"
}
```

聚合枚举：

- `COUNT`
- `COUNT_DISTINCT`
- `SUM`
- `AVG`
- `MIN`
- `MAX`

语义：

- `COUNT` 且不填 `property`：数行数，编译为 `COUNT(*)`
- `COUNT` 且填 `property`：统计非空值
- `COUNT_DISTINCT`：必须填 `property`
- `SUM / AVG / MIN / MAX`：必须填 `property`

临时聚合会在结果里产生 warning，表示它没有引用已定义指标。

### 3.5 指标口径

优先使用本体指标：

```json
{
  "metric": "专线条数",
  "as": "条数"
}
```

指标解析会展开：

- 作用对象类型
- 聚合方式
- 被聚合属性
- 固定过滤
- 可用维度
- 单位
- draft / verified 状态

指标固定过滤不会无条件塞进全局 `WHERE`。如果多个指标固定过滤不同，编译器会生成条件聚合：

```sql
COUNT(CASE WHEN 产品名称 LIKE :p1 THEN 1 END)
SUM(CASE WHEN 状态 = :p2 THEN 收入 END)
COUNT(DISTINCT CASE WHEN 口径成立 THEN 客户编号 END)
```

如果所有指标过滤条件相同，后续可以优化为统一 `WHERE` 下推；当前优先保证语义正确。

`draft` 指标允许执行，但结果带 warning。以后可以配置为直接拒绝 draft。

### 3.6 关系引用

关系引用只能引用本体中已有的关系类型：

```json
{
  "alias": "area",
  "type": "归属地市",
  "from": "root",
  "direction": "forward",
  "optional": true
}
```

规则：

- `alias` 必须唯一
- `from` 必须指向已经声明的别名
- `direction` 支持 `forward` / `backward`
- 当前 SQL 编译器不接受一个关系同时向两个方向展开
- `optional: true` 编译为 `LEFT JOIN`
- `optional: false` 编译为 `JOIN`
- 连接列来自关系类型的 key mapping 与 `planLinkSource()`
- 模型不能提供 JOIN 条件
- 关系涉及的数据资源必须与根查询一致；跨数据资源默认拒绝

### 3.7 排序与分页

```json
{
  "order_by": [
    { "ref": "条数", "direction": "desc" }
  ],
  "limit": 100
}
```

- `ref` 优先匹配 `select[].as`
- 也支持对象属性名
- 聚合查询的排序字段必须能解析成输出列或分组字段
- `limit` 由执行器传递到只读查询上限，不拼接到模型可见内容

## 4. 内部 AST / LogicalPlan

DSL JSON 不是编译器直接消费的形状。解析后生成类型化计划：

```text
LogicalPlan
  Root Scan
  Relationship Joins
  Where
  Select
  GroupBy
  Aggregate
  OrderBy
  Limit
```

主要类型：

- `ResolvedEntity`：对象类型、主来源、物理表、主键、属性映射
- `ResolvedField`：逻辑字段到物理列
- `ResolvedExpr`：过滤表达式树
- `ResolvedMetric`：指标展开后的聚合、过滤、维度
- `ResolvedRelationship`：关系方向、连接计划、基数
- `ResolvedSelectItem`：字段、指标、临时聚合
- `LogicalPlan`：完整逻辑计划

设计原因：

- 让解析、校验、规划、编译解耦
- 便于未来增加 Elasticsearch、知识库等后端
- 避免每个后端各自重新解释 DSL

## 5. Resolver 语义

Resolver 负责把 DSL 从“名字”解析成“可执行逻辑”。

校验包括：

- 对象类型是否存在
- 对象类型是否绑定数据资源
- 属性是否存在
- 属性是否映射到主来源
- 指标是否存在
- 指标作用对象是否匹配
- 指标过滤属性是否存在
- 指标维度是否允许当前 `group_by`
- 关系类型是否存在
- 关系方向是否合法
- 关系端点是否匹配
- 关系连接计划是否完整
- 关系数据资源是否与根对象一致
- 聚合字段是否都在 `group_by` 中
- `kind=records` 不允许指标或聚合输出
- `kind=aggregate` 至少要有一个指标或聚合输出

## 6. 关系与基数安全

关系类型有一个方向性基数：

- `ONE_TO_ONE`
- `ONE_TO_MANY`
- `MANY_TO_ONE`
- `MANY_TO_MANY`

这里的基数回答的是：

> 从起点端走一次到终点端，会不会把一个对象放大成多行。

编译聚合查询时：

- `MANY_TO_ONE` / `ONE_TO_ONE`：通常可以安全聚合
- `ONE_TO_MANY` / `MANY_TO_MANY`：可能重复计数，默认拒绝
- 基数未标注：聚合查询默认拒绝或要求显式收敛
- 记录查询允许执行，但必须保留 warning

这条规则的目标是：

> 宁可拒查，也不静默算错。


### 6.1 多来源对象类型（MDO）

对象类型可以有多份来源：

- `sources[0]` 是主来源，决定对象身份、主键和标题。
- 后续来源是补充来源，按主键列**逐列对齐**连接到主来源。
- 属性通过 `sourceId` 指定自己来自哪份来源。
- 主来源物理别名使用对象类型别名；补充来源使用稳定别名，例如 `line__src1`。
- 编译器为补充来源生成 `LEFT JOIN`：补充来源的连接键 = 主来源主键。
- 补充来源和主来源必须落在同一个数据资源；跨数据资源 MDO 当前拒绝。
- 补充来源的 `primaryKey` 数量必须和主来源一致；不一致时拒绝。

MDO 不改变逻辑对象身份：模型仍然只引用对象类型和属性名，物理来源拆分由编译器和 Resolver 处理。
## 7. SQL 编译器

当前支持：

- PostgreSQL
- MySQL
- Oracle

编译规则：

- 表名和列名使用方言标识符引用
- 值全部走命名参数
- 字符串匹配转义 `%`、`_` 和转义符
- 枚举标签先在 Resolver 中解析成实际码值
- `COUNT(*)` 与 `COUNT(column)` 语义分开
- `COUNT_DISTINCT` 使用 `COUNT(DISTINCT ...)`
- 指标固定过滤生成条件聚合
- `group_by` 编译成显式分组
- `order_by` 使用输出列别名或已解析字段
- 行数上限由连接器执行器统一处理

编译器输出：

```ts
type CompiledSqlQuery = {
  statement: string;
  parameters: Record<string, string | number | boolean | null>;
  dataSourceId: string;
  columns: string[];
  limit: number;
  warnings: string[];
};
```

编译后的 SQL 和参数只存在于服务端执行链路与审计记录中，不返回给模型。

## 8. 执行与结果

执行入口：

```ts
executeQueryDsl(definition, dsl, deps?)
```

执行过程：

1. 解析 DSL
2. Resolver 生成 LogicalPlan
3. 根据根对象解析数据资源
4. 根据数据资源类型选择 SQL 编译器
5. 调用连接器只读执行
6. 归一化结果

结果形状：

```json
{
  "data_source": "数据资源名称",
  "data_source_kind": "ORACLE",
  "columns": ["地市编码", "条数"],
  "rows": [["371", 5]],
  "returned": 1,
  "row_limit": 100,
  "truncated": false,
  "elapsed_ms": 86,
  "warnings": []
}
```

安全：

- 只读事务
- 词法只读检查
- 参数绑定
- 超时
- 行数上限
- 截断必须明确返回
- 查询结果不作为本体实例证据

## 9. Agent / MCP 工具

工具名：

```text
run_query
```

入参：

```json
{
  "query": { "...": "DSL JSON" }
}
```

当前状态：

- 已加入工具目录
- 当前 `disabled: true`
- MCP 调试页可见
- 模型与外部客户端默认不可见
- 现有问答仍走 `run_sql`

迁移路径：

1. P0：编译器与执行器影子运行
2. P0.5：关系、多来源、基数保护、影子对拍
3. P0.6：真实问题集验证 DSL 生成成功率与结果一致性
4. P1：开放 `run_query`，提示词改为优先用 DSL
5. P1 后段：从模型工具集移除 `run_sql`，仅保留管理员排障用途

不允许在 DSL 失败时自动静默回退 `run_sql`；必须返回明确错误或按政策显式回退。

## 10. 错误分类

当前错误族：

- `UNKNOWN_ENTITY`
- `ENTITY_NOT_BOUND`
- `UNKNOWN_PROPERTY`
- `UNKNOWN_METRIC`
- `UNKNOWN_RELATIONSHIP`
- `RELATIONSHIP_UNSUPPORTED`
- `SECONDARY_SOURCE_UNSUPPORTED`
- `METRIC_SCOPE_MISMATCH`
- `METRIC_DIMENSION_MISMATCH`
- `CROSS_SOURCE_JOIN_UNSUPPORTED`
- `CARDINALITY_UNSAFE`
- `INVALID_QUERY`
- `UNSUPPORTED_OPERATOR`

错误应尽量带：

- 错误码
- 人话原因
- 修复建议
- 必要的可用属性 / 维度 / 关系清单

## 11. 知识库融合方向

知识库不是 SQL 编译器的替代品，而是未来规划器中的另一类数据源。

建议位置：

```text
LogicalPlan
  ├─ 结构化子计划 → SQL 编译器
  └─ 非结构化子计划 → 知识库检索适配器
```

未来可以增加：

```json
{
  "retrieve": {
    "source": "knowledge_base",
    "text": "互联网专线带宽口径",
    "top_k": 5
  }
}
```

融合步骤：

1. 知识库检索返回文档或片段
2. 通过实体键、对象引用或元数据映射回本体对象
3. 与 SQL 子计划做受控融合
4. 查询结果和知识片段分别标记来源
5. 不能等价的融合明确拒绝或降级，不静默假装等价

这项能力依赖后续的 embedding provider、向量索引和权限策略；当前不提前耦合。

## 12. 代码地图

```text
src/lib/query-dsl/
  schema.ts          DSL v1 规范与 Zod 类型
  errors.ts          错误码与 QueryDslError
  ast.ts             LogicalPlan / 类型化 AST
  resolve.ts         DSL → 逻辑计划
  compile/sql.ts     SQL 编译
  execute.ts         只读执行与结果归一化
  index.ts           公共出口

tests/lib/
  query-dsl.test.ts
  query-dsl-relationship.test.ts
  query-dsl-mdo.test.ts
```

相关接入点：

```text
src/lib/datasource/types.ts    连接器参数能力
src/lib/datasource/sql.ts      只读查询参数绑定
src/lib/reasoning/tools/registry.ts   run_query 工具目录
src/lib/reasoning/tools/dispatch.ts   run_query 分发
src/lib/reasoning/mcp.ts               MCP 分组与标题
src/lib/reasoning/tool-summary.ts      步骤摘要
```

## 13. 测试与验收

P0 验收：

- DSL 合法与非法输入
- 未知对象类型、属性、指标拒绝
- 指标聚合正确展开
- 指标固定过滤生成条件聚合
- 枚举标签不写入 SQL 原文
- 参数绑定生效
- records 与 aggregate 编译正确
- 执行器结果列序稳定
- 全量测试与类型检查通过

P0.5 验收：

- 外键式关系 JOIN
- 中间表式关系 JOIN
- 关系方向正确
- 多来源对象类型属性可查询
- 关系基数放大时聚合拒绝
- 跨数据资源关系明确拒绝
- 补充来源按主键对齐的 MDO JOIN
- 与 `run_sql` 真实问题集逐格对拍

## 14. 维护约定

1. 改 DSL 字段、操作符、错误码或语义时，必须同步更新本文。
2. 新增后端编译器时，必须补能力矩阵和限制。
3. 新增关系能力时，必须补连接计划和基数规则。
4. 新增工具或开放模型能力时，必须补迁移状态与安全边界。
5. 系统说明书只记录“系统是什么、怎么工作、边界是什么”，修复过程进历史记录。