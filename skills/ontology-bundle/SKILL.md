---
name: ontology-bundle
description: >-
  把本体方案落成**可以直接导入平台**的 JSON。分两步：先写**结构化清单**（ontology.blueprint：
  用名字引用、不写 UUID），再用技能自带的编译脚本（scripts/build-bundle.mjs，一条 node 命令，
  Windows / Linux / macOS 通用）编译成本体包（format: ontology.bundle，后缀 .ontology.json）。
  含结构自检、导入与发布步骤、常见报错的修法。
  当用户说"帮我生成能导入的 json""导出的格式是什么""这套本体怎么导进平台""包怎么校验"时使用。
  已经有 JSON、只是想改内容或直接导入时不必用本技能。
---

# 本体出包与交付

**模型只写清单，JSON 由脚本编译。** 两步各自的产物：

| 谁产出 | 文件 | 说明 |
| --- | --- | --- |
| 模型写 | `<标识>.blueprint.json` | **结构化清单**：引用写名字（「客户」），不写 id、不写 UUID、不写格式字段 |
| 脚本编译 | `<标识>.ontology.json` | **本体包**，平台「本体 → 导入本体包」认的就是它 |

为什么不让模型直接写包：手写 UUID 与 id 引用最容易错（对不上就整包报错），格式字段也容易漂。
清单把这两件事交给脚本 —— **引用按名字解析、UUID 由脚本生成、默认值与格式字段由脚本补齐**。

- 清单格式：`references/blueprint-format.md`
- 可照抄的清单：`references/example.blueprint.json`（编译出来的结构就是 `references/example.bundle.json` 的样子）
- 包格式（只有手写时才需要看）：`references/bundle-format.md`
- 脚本：`scripts/build-bundle.mjs`（编译）、`scripts/check-bundle.mjs`（手写包的结构自检）

## 步骤

### 1. 先把结构定下来

在写清单之前，用一句话把这几件事说清（说不清就先回去做设计）：

- 有几个**对象类型**，各自的主键与标题是什么；
- 有哪些**关系类型**，方向和自带属性是什么；
- 有没有**接口**（至少两个实现方 + 能说出谁按它消费）；
- 有**动作**吗？动作定义在哪个对象类型上、写什么；
- 有**规则**吗？拦谁、什么条件、给用户看什么原因；
- **数据来源**：哪些对象类型已经知道表和列，哪些还不知道（不知道的就留空，不要编）。

### 2. 写结构化清单

- 只写业务：对象类型、属性、关系类型、接口、动作、规则、数据资源坐标。
- 引用一律写**名字**（对象类型名 / 关系类型名 / 接口名 / 分组名 / 数据资源名 / 动作名），**不要写 UUID**。
- 属性上的 `source` 写的是**本类型内**那份来源的局部 id（默认 `primary`）；数据资源在 `sources[].dataSource` 上按名字引用。
- 数据来源只写**连接坐标**，绝不写账号密码。
- 不确定的字段宁可不写（大多有默认值），但 `ontology.name` 必须有。
- 没把握就复制 `references/example.blueprint.json` 改名字、属性与引用。

### 3. 编译 + 自检（**必做**，别跳）

```bash
node scripts/build-bundle.mjs <清单.json> --check   # 先只校验：引用能不能解析、结构对不对
node scripts/build-bundle.mjs <清单.json>           # 产出 <标识>.ontology.json
```

Windows / Linux / macOS 一样（只要有 Node 18+），路径带空格就加引号；`--out` 指定产物路径，`--stdout` 打到标准输出。

- **报错（退出码 1）** = 清单有问题：未知名字、重名、枚举写错、必填缺失。编译器会**把可用的合法名字列出来**，照着改就行。
- **提醒（`⚠`）** = 建模层面的建议，不挡编译；用的是平台「建模体检」的规则码，导入后平台会说同样的话。

再人工过一遍**语义**（机器查不出来的）：

- [ ] 接口里 `required` 的每个属性，实现方都有**同名**属性。
- [ ] 接口里 `required` 的关系约束，实现方都有一条「起点=自己、终点=约束目标」的**方向正确**的关系类型。
- [ ] 动作的 `scope` 是业务上真正接受这个动作的对象类型（不是随便挑一个）。
- [ ] 规则条件里的 `property` 在主对象类型上存在；处置档位选对（拒绝用 `BLOCK`，只提示用 `WARN`）。
- [ ] 名称都是业务语言，没有 `tb_` 前缀、没有中文列名。
- [ ] 属性 `dataType` 与真实数据一致（金额 `DECIMAL`、时间 `DATETIME`…）。
- [ ] 表名、列名来自材料；**没有**凭空编造。
- [ ] 交付说明里写清"导入后先校验再发布"，以及哪些对象类型还需要重新选表。
- [ ] 手边连着平台（MCP 可用）时，导入后调一次 `review_model` 做**建模体检**：空壳与孤悬的对象类型、
      主键列没属性接、必填属性没映射列、命名打架、关系端点没选这类问题，它会按「该改 / 可以更好」列出来。
      它**不挡发布**，是建议层；全部规则码与判据见 `ontology-builder/references/modeling-rules.md` 第 9 节。

**环境里没有 Node**（或用户不让跑脚本）时退回手写：按 `references/bundle-format.md` 直接写 `.ontology.json`，
写完用 `node scripts/check-bundle.mjs <包.json>` 过一遍结构；连 Node 都没有就只能靠平台的导入校验兜底。

### 4. 交付

给用户的说明应该包含：

1. 文件（`<标识>.ontology.json`）与它的 `ontology.name`；
2. 结构规模：对象类型 / 关系类型 / 接口 / 动作 / 规则的数量；
3. **导入路径**：平台左侧「本体」→「导入本体包」→ 选文件 → 选存储资源 → 导入；
4. 导入后的两步：**校验**（看有没有被拦）→ **发布**（发布后图库才会有结构，实例另算）；
5. 已知待确认项：没有绑上来源的对象类型、没有实现的接口、待确认的表/列。

## 清单骨架（最小可编译）

```json
{
  "format": "ontology.blueprint",
  "formatVersion": 1,
  "ontology": { "name": "专线服务本体" },
  "objectTypes": [
    {
      "name": "专线产品用户",
      "description": "开通了专线产品的用户实例。",
      "displayProperty": "USER_NAME",
      "properties": [
        { "name": "USER_ID", "displayName": "用户标识", "dataType": "TEXT", "required": true, "unique": true },
        { "name": "USER_NAME", "displayName": "用户名称", "dataType": "TEXT" }
      ]
    }
  ]
}
```

各段（`groups` / `interfaces` / `objectTypes` / `relationTypes` / `actionTypes` / `rules`）都是数组，
不写就是空；`properties` 里没写的 `displayName` / `description` / `unique` / `indexed` 取默认值。

> 这份骨架只有对象类型，编译时会有一条 `ENTITY_ORPHAN`（孤悬）提醒 —— 补上关系类型或数据来源就没了。

## 常见报错

| 报错 | 原因 | 修法 |
| --- | --- | --- |
| （编译器）`对象类型「X」的 target 指向了不存在的对象类型「Y」。当前清单里有：…` | 引用名写错 | 照它列出的名字改；名字要一字不差 |
| （编译器）`对象类型重名：「X」` | 同名定义 | 改成不重复的名字（名字是清单里唯一的引用方式） |
| （编译器）`dataType 不认识：X` / `op 不认识` / `operator 不认识` | 枚举写错 | 见 `references/blueprint-format.md` 的枚举表 |
| 这不是本体包：format 应该是「ontology.bundle」 | 把**清单**当包导入了 | 先跑编译脚本产出 `.ontology.json`，再导入 |
| 这个本体包是更新版本导出的（vN）… | `formatVersion` 大于平台支持 | 用 v1 字段集重新生成 |
| 数据资源「X」在本机没有登记…来源绑定已留空 | 包里坐标在本机没登记 | 在本机「数据资源」登记同一坐标，或导入后重新选表 |
| 动作「X」需要选择作用的对象类型 | `scope` 空或指向不存在 | 把动作绑到一个对象类型上 |
| 对象类型「X」实现接口「Y」，还缺必填属性：Z | 少了同名属性 | 补属性，或去掉接口里的 `required` |
| 对象类型「X」实现接口「Y」，还缺关系约束「Z」 | 没有方向正确的实现关系 | 补一条关系类型（起点=实现方、终点=约束目标） |
| 规则「X」还没有配置条件 | `conditions` 空 | 补条件；不需要这条规则就删掉 |
| 关系端点不符合草稿中的对象类型契约 | 关系两端对象的类型与关系类型声明不一致 | 这是**实例数据**的问题（不是包本身）；先发布干净的结构 |

## 边界

- 本体包**不带实例数据**（`statistics.objects` 只是统计）。实例来自发布时的图库快照或后续在「对象」页写入。
- 平台**不从绑定自动取数**：`sources` 说明"这些对象的属性从哪来"，不是取数脚本。
- 导入**不会发布**，也不会改动已有本体；同一份包可以反复导入成多个本体（id 会重发）。
- **清单不是导入格式**：平台只认 `ontology.bundle`；`.blueprint.json` 必须先过编译脚本。
- 编译器**只管引用与结构**：命名是否业务化、粒度是否合适这类判断它做不了 —— 那靠
  `ontology-builder/references/modeling-rules.md` 的细则，导入后还有平台的「建模体检」兜底。