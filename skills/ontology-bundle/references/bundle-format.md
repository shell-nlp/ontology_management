# 本体包格式（ontology.bundle v1）

一份本体包就是**一个 JSON 文件**，后缀 `.ontology.json`。平台「本体 → 导入本体包」直接吃它；
平台「本体 → 导出」产出的也是这个格式，两者可以互相往返。

字段级规范以本文为准。**完整可用的例子**见同目录的 `example.bundle.json`（它保证能通过平台的导入与发布前校验）。

## 1. 顶层结构

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `format` | 字符串 | ✅ | 固定 `"ontology.bundle"`，写错会被拒："这不是本体包" |
| `formatVersion` | 整数 | ✅ | 目前 `1`；大于平台支持版本会提示升级平台 |
| `exportedAt` | 字符串 | ✅ | ISO 8601 时间，例如 `2026-09-16T10:00:00.000Z` |
| `generator` | 对象 | | `{ "name": "...", "version": "..." }`，写清楚是谁生成的 |
| `ontology` | 对象 | ✅ | 本体自身：`identifier`(≤64) / `name`(1–100) / `description`(≤500) / `color`(≤32) / `tags`(≤24 个，每个 ≤32) |
| `statistics` | 对象 | | 只用于展示：`objectTypes` / `relationTypes` / `actionTypes` / `rules` / `objects` / `relationships`，都是非负整数 |
| `dataSources` | 数组 | | 数据资源的**连接坐标**，见第 3 节 |
| `definition` | 对象 | ✅ | 本体结构，见第 2 节 |

`statistics` 与实际数量不一致不影响导入（平台自己会重算），但别故意写错。

## 2. definition

### 2.0 一条总规则：id 是 UUID，引用靠 id

`groups` / `interfaces` / `entityTypes` / `relationshipTypes` / `actionTypes` / `rules`
以及接口的关系约束 `linkConstraints[]`，**每一个元素都要有 `id`，且必须是 UUID 字符串**
（形如 `xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx`）。不能用中文、序号、表名当 id。

这些 id 共用同一个空间，互相引用时只写 id：

```
entityTypes[].groupId                → groups[].id
entityTypes[].implements[]           → interfaces[].id
interfaces[].extends[]               → interfaces[].id
interfaces[].linkConstraints[].targetId → interfaces[].id 或 entityTypes[].id（看 targetKind）
relationshipTypes[].sourceEntityTypeId / targetEntityTypeId → entityTypes[].id
actionTypes[].scopeEntityTypeId      → entityTypes[].id
actionTypes[].params[].entityTypeId  → entityTypes[].id（kind = ENTITY_REF 时）
actionTypes[].edits[].entityTypeId / relationshipTypeId → entityTypes[].id / relationshipTypes[].id
rules[].actionId                     → actionTypes[].id
```

导入时平台会给这些 id **全部重发新号**，所以不用担心和已有本体撞号；但**引用必须指得到东西**，
指不到的在发布前校验会被拦下来。

### 2.1 `groups[]`（概念分组）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 业务域名，1–40 字符 |
| `color` | 可选，`#rrggbb`；留空按位置取调色板色 |

概念分组只影响图谱怎么摆、怎么画框，不进图库、不参与推理。一个对象类型最多属于一个分组。

### 2.2 `interfaces[]`（接口）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 1–100 字符；接口重名会被拦 |
| `description` | ≤500 字符 |
| `properties[]` | 同属性结构（见 2.3）；只有 `required` 有意义：实现方必须有**同名**属性 |
| `extends[]` | 继承的接口 id 列表（可多个）；不能绕成环 |
| `linkConstraints[]` | 关系约束，见下 |

`linkConstraints[]`：

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 约束名（接口视角下这条关系叫什么），1–100 |
| `description` | ≤300 |
| `targetKind` | `"OBJECT_TYPE"` 或 `"INTERFACE"`，默认 `OBJECT_TYPE` |
| `targetId` | 目标 id（按 targetKind 解释）；**不能为空**，否则会被拦 |
| `cardinality` | `"ONE"` 或 `"MANY"`，只做建模提示，图库不强制 |
| `required` | `true` 时，实现方必须有一条「起点=实现方、终点=目标」的关系类型，否则发布被拦 |

接口**不绑数据、不能被实例化**，也不能有父子继承的说法 —— 平台里的抽象只有接口一种。

### 2.3 `entityTypes[]`（对象类型）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 业务名词，1–100；同一次导入里不能重名 |
| `description` | ≤500 |
| `displayProperty` | 图上/列表展示的属性名（必须是自己的属性之一），≤120 |
| `groupId` | 概念分组 id，或空串（不归组） |
| `implements` | 实现的接口 id 列表 |
| `properties[]` | 属性，见下 |
| `sources[]` | 数据来源，见第 3 节；不接数据就写 `[]` |

`properties[]`：

| 字段 | 说明 |
| --- | --- |
| `name` | 机器名，1–120；同一类型内不能重复。建议与数据列对齐 |
| `displayName` | 给人看的中文名，≤120；留空退回 `name` |
| `description` | 这是什么、口径怎么算，≤300 |
| `dataType` | `TEXT` / `INTEGER` / `DECIMAL` / `BOOLEAN` / `DATE` / `DATETIME` / `TEXT_ARRAY` / `JSON` |
| `required` | 必填 |
| `unique` | 唯一（主键列必须写）。**值超过 8KB 的字段不要写 unique**，发布前会被拦 |
| `indexed` | 会被筛选/检索 |
| `sourceField` | 值取自哪一列（可选） |
| `sourceId` | 取自哪一份来源（`sources[].id`）；不写 = 主来源 |

### 2.4 `relationshipTypes[]`（关系类型）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 动词短语，1–100，例如「客户拥有专线产品用户」 |
| `description` | ≤500 |
| `sourceEntityTypeId` | 起点对象类型 id |
| `targetEntityTypeId` | 终点对象类型 id（起点=终点表示自环） |
| `properties[]` | **这条关系自己的事实**（订购时间、角色…），结构同 2.3 的属性 |

对象类型之间**没有继承**：不要写 `parents`、`rdfs:subClassOf` 这类字段（写了会被忽略，也会误导读者）。

关系类型是**双向**的：一条关系类型只有一个定义、两个端点，建好之后两个方向都能走 ——
不要为了"反向"再建一条关系类型（Palantir 的 link type 也是这样：一条 link type 两侧都能走）。
两条并列的关系类型表示的是两个不同的现实关系（「执飞」与「检修记录」），不是正反向。

### 2.5 `actionTypes[]`（动作）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 1–100 |
| `code` | 稳定机器名（将来暴露给 AI 工具时用它），1–100 |
| `description` | ≤500 |
| `scopeEntityTypeId` | **作用的对象类型**：动作定义在这个类型上，也只能在这个类型的对象上执行。空值会被拦 |
| `params[]` | 入参：`code`(1–80，同动作内不重复) / `name`(1–120) / `kind`(`ENTITY_REF` \| `VALUE`) / `entityTypeId`（`ENTITY_REF` 必填）/ `dataType` / `required` |
| `edits[]` | 写操作，三种 `op`：`CREATE_ENTITY` / `SET_PROPERTY` / `CREATE_RELATIONSHIP` |

`edits[]` 的公共字段：`alias`（`CREATE_ENTITY` 必填，供后续步骤引用）、`entityTypeId`、`relationshipTypeId`、
`entityRef` / `sourceRef` / `targetRef`（`{ "kind": "SUBJECT" | "PARAM" | "EDIT", "code": "..." }`）、
`assignments[]`（`{ "property": "<属性名>", "value": { "kind": "PARAM"|"CONST"|"NOW", "code": "", "value": "..." } }`）。

- `SUBJECT` = 动作的主对象（接受动作的那个对象），`code` 留空。
- `PARAM` = 引用某个入参，`code` 写参数 `code`。
- `EDIT` = 引用前面某一步 `CREATE_ENTITY` 的 `alias`。
- `SET_PROPERTY` 的赋值属性必须在目标对象类型上存在；关系的赋值同理要在关系类型上存在。

### 2.6 `rules[]`（规则）

| 字段 | 说明 |
| --- | --- |
| `id` | UUID |
| `name` | 1–100 |
| `effect` | `BLOCK`（拒绝，给原因）/ `WARN`（只提示）/ `HIDE`（动作在满足条件的对象上不出现） |
| `priority` | 整数，越大越先判 |
| `enabled` | 布尔 |
| `actionId` | 绑定的动作 id；空串表示对所有动作生效 |
| `conditions[]` | 条件，至少一条 |
| `message` | 拦截/提示时给用户看的原因，≤500 |

`conditions[]`：`subject`（`kind` + `code` + 可选 `relationshipTypeId` + `direction`）、`property`、`operator`、`compareValue`。

`operator` 只能是：`EQUALS` / `NOT_EQUALS` / `IS_TRUTHY` / `IS_FALSY` / `IS_EMPTY` / `IS_NOT_EMPTY`。

两条硬约束：

- `HIDE` 规则**必须**绑定具体动作（隐藏是"动作在这个对象上出不出得来"），条件也只能看主对象自身属性。
- 条件里 `subject.kind` 不是 `SUBJECT` 时，`code` 不能为空。

## 3. `dataSources` 与来源绑定

```json
"dataSources": [
  {
    "id": "f1000000-0000-4000-8000-000000000001",
    "name": "Oracle 测试",
    "kind": "ORACLE",
    "host": "10.0.0.10",
    "port": 1521,
    "databaseName": "orcl",
    "schemaName": "GISTOOLS"
  }
]
```

- `kind`：`ORACLE` / `POSTGRES` / `MYSQL`（平台已支持的关系库）。
- **绝不写账号密码**。这里只有连接坐标。
- 导入时平台按「kind + host + port + databaseName + schemaName」五项全等匹配本机已登记的数据资源；
  只差模式时放宽一次并给提醒；匹配不到就把这条来源的绑定**留空**，并在导入结果里点名是哪个对象类型需要重选表。

定义里的绑定写在对象类型上：

```json
"sources": [
  {
    "id": "primary",
    "dataSourceId": "f1000000-0000-4000-8000-000000000001",
    "schema": "GISTOOLS",
    "view": "TB_MK_GRP_LINE_LIST_DAY",
    "primaryKey": ["USER_ID"],
    "titleField": "USER_NAME"
  }
]
```

- `sources[0]` 是**主来源**：对象身份取 `primaryKey`（支持复合主键），标题取 `titleField`。
- 后面的来源是**补充来源**：按主键逐列对齐连接（列数必须与主键一致、顺序一一对应），只往对象上补属性。
- `dataSourceId` 为空串 = 这份来源还没接上（纯建模也允许，发布前只会 WARN 提示）。
- 属性上的 `sourceField` 写的是**列名**，`sourceId` 写这份来源的 `id`（不写就是主来源）。

## 4. 导入时平台做了什么

1. 校验 `format` / `formatVersion` 与整体结构（字段类型、枚举、长度上限）。
2. 把 `bundle.dataSources` 按坐标接回本机已登记的数据资源（见第 3 节）。
3. 给**所有** id 重发新号，并按 id 映射改写全部引用（不用担心撞号）。
4. 建一个新本体 + 一个**草稿**版本，写入这份定义。**不会**碰图库、**不会**自动发布。

所以导入成功后要做的两步是：**「校验」→ 看有没有被拦 → 「发布」**。

## 5. 发布前校验会拦什么（对照清单）

导入时只做结构校验；**语义**校验发生在「校验 / 发布」那一步。写出包之前先自己过一遍，能省一轮往返：

| 校验项 | 会看到的提示 |
| --- | --- |
| 属性映射了列但类没挂来源 | 属性「X」映射了数据列，但对象类型「Y」还没有数据来源（**提示，不拦**） |
| 主来源没选表 / 没主键 | 对象类型「Y」的主来源还没选表 / 还没指定主键列（**提示，不拦**） |
| 补充来源连接键数量与主键不一致 | 填了 N 个连接键，主键有 M 列，两边要对齐（**拦**） |
| 同一张表挂了两次 | 把同一张表 X 挂了两次（**提示，不拦**） |
| 接口重名 / 属性重复 | 接口「X」重复定义 / 接口「X」里属性「Y」重复 |
| 接口继承缺失或绕环 | 接口「X」继承了一个不存在的接口 / 继承绕成了环 |
| 关系约束没选目标 | 接口「X」的关系约束「Y」还没选另一端 |
| 实现了不存在的接口 | 对象类型「X」声明实现了一个不存在的接口 |
| 实现接口缺必填属性 | 对象类型「X」实现接口「Y」，还缺必填属性：A、B |
| 实现接口缺必填关系 | 对象类型「X」实现接口「Y」，还缺关系约束「Z」（指向…的关系） |
| 动作没选作用对象类型 | 动作「X」需要选择作用的对象类型 |
| 动作参数重复 / 引用不存在的参数 | 动作「X」的参数标识「Y」重复 / 引用了不存在的参数「Y」 |
| 动作新建对象没有别名 | 动作「X」新建「Y」时需要填一个别名 |
| 动作赋值的属性不存在 | 动作「X」给「Y」赋值的属性「Z」不存在 |
| 规则没条件 / 绑了不存在的动作 | 规则「X」还没有配置条件 / 绑定的动作不存在 |
| `HIDE` 规则没绑动作 | 规则「X」的处置是「隐藏」，需要绑定到一个具体动作 |
| 唯一属性值超长（> 8KB） | 唯一属性「X」有 N 个值的长度超过 8191 字节，不适合当唯一键 |
| 关系端点不符合契约 | 关系端点不符合草稿中的对象类型契约（关系两端对象的类型必须是关系类型声明的类型） |

## 6. 最小可用骨架

```json
{
  "format": "ontology.bundle",
  "formatVersion": 1,
  "exportedAt": "<ISO 时间>",
  "ontology": { "identifier": "<英文标识>", "name": "<本体名>", "description": "", "color": "", "tags": [] },
  "dataSources": [],
  "definition": {
    "groups": [],
    "interfaces": [],
    "entityTypes": [],
    "relationshipTypes": [],
    "actionTypes": [],
    "rules": []
  }
}
```

`entityTypes: []` 也能导入（得到一个空草稿），但真正有用的包至少要有对象类型；
只有对象类型、没有任何关系类型的本体能在平台上打开，只是图谱里会是一堆孤岛。

## 7. 常见错误 → 原因 → 修法

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 导入报"这不是本体包" | `format` 写错或不是这个文件 | 顶层 `format` 必须是 `"ontology.bundle"` |
| 导入报字段类型/长度错误 | 某个字段超长或枚举拼错 | 对照本文第 2 节的上限与枚举逐项检查 |
| 导入成功但提示"来源绑定已留空" | 包里 `dataSources` 的坐标在本机没有登记 | 在本机「数据资源」里登记同一坐标，或导入后重新选表 |
| 校验报"动作「X」需要选择作用的对象类型" | `scopeEntityTypeId` 是空串或指向不存在的类型 | 动作必须定义在某个对象类型上 |
| 校验报"还缺必填属性" | 实现接口的类型少了同名属性 | 给实现方补同名属性，或去掉接口里的 `required` |
| 校验报"还缺关系约束" | 实现方没有「起点=自己、终点=约束目标」的关系类型 | 补一条关系类型（方向要对） |
| 图上什么都没有 | 只导入了类型，没导入实例 | 正常：本体包不带实例数据；实例来自发布时的快照或后续写入 |
