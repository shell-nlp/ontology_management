---
name: ontology-bundle
description: >-
  把本体方案落成**可以直接导入平台**的 JSON —— 本体包（format: ontology.bundle，后缀 .ontology.json），
  并在交付前做自检（id、引用完整性、接口实现、动作与规则），给出导入与发布步骤、常见报错的修法。
  当用户说"帮我生成能导入的 json""导出的格式是什么""这套本体怎么导进平台""包怎么校验"时使用。
  已经有 JSON、只是想改内容或直接导入时不必用本技能。
---

# 本体出包与交付

**产物只有一个**：`<标识>.ontology.json`。它就是平台「本体 → 导入本体包」认的文件，
也是平台「导出」产出的格式 —— 两边可以互相往返。

字段级规范见 `references/bundle-format.md`，**可直接照抄的完整例子**见 `references/example.bundle.json`。
不确定怎么组织时：先复制例子，改名字、属性与引用，删掉不需要的部分。

## 步骤

### 1. 先把结构定下来

在写 JSON 之前，用一句话把这几件事说清（说不清就先回去做设计）：

- 有几个**对象类型**，各自的主键与标题是什么；
- 有哪些**关系类型**，方向和自带属性是什么；
- 有没有**接口**（至少两个实现方 + 能说出谁按它消费）；
- 有**动作**吗？动作定义在哪个对象类型上、写什么；
- 有**规则**吗？拦谁、什么条件、给用户看什么原因；
- **数据来源**：哪些对象类型已经知道表和列，哪些还不知道（不知道的就留空，不要编）。

### 2. 生成 JSON

- 所有 id 现生成 UUID（`xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx`）。**不要**用中文、序号、表名。
- 引用只写 id（`groupId` / `implements` / 端点 / `scopeEntityTypeId` / `actionId`）。
- 数据来源只写连接坐标（kind / host / port / databaseName / schemaName），**绝不写账号密码**。
- 不确定的字段宁可不写（绝大多数字段有默认值），但 `format` / `formatVersion` / `exportedAt` /
  `ontology` / `definition` 必须有。

### 3. 自检（**必做**，别跳）

先跑一遍机器能查的（存成 `check.mjs`，`node check.mjs <文件>`）：

```js
import { readFileSync } from "node:fs";
const bundle = JSON.parse(readFileSync(process.argv[2], "utf8"));
const d = bundle.definition ?? {};
const fail = [];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (bundle.format !== "ontology.bundle") fail.push("format 必须是 ontology.bundle");
if (!bundle.exportedAt) fail.push("缺 exportedAt");
if (!bundle.ontology?.name) fail.push("缺 ontology.name");

const ids = new Set();
const addId = (id, where) => {
  if (!uuid.test(id ?? "")) return fail.push(`${where} 的 id 不是 UUID：${id}`);
  if (ids.has(id)) fail.push(`${where} 的 id 重复：${id}`);
  ids.add(id);
};
(d.groups ?? []).forEach((g, i) => addId(g.id, `groups[${i}]`));
(d.interfaces ?? []).forEach((x, i) => { addId(x.id, `interfaces[${i}]`); (x.linkConstraints ?? []).forEach((c, j) => addId(c.id, `interfaces[${i}].linkConstraints[${j}]`)); });
(d.entityTypes ?? []).forEach((x, i) => addId(x.id, `entityTypes[${i}]`));
(d.relationshipTypes ?? []).forEach((x, i) => addId(x.id, `relationshipTypes[${i}]`));
(d.actionTypes ?? []).forEach((x, i) => addId(x.id, `actionTypes[${i}]`));
(d.rules ?? []).forEach((x, i) => addId(x.id, `rules[${i}]`));

const need = (id, where) => { if (id && !ids.has(id)) fail.push(`${where} 指向不存在的 id：${id}`); };
(d.entityTypes ?? []).forEach((e) => { need(e.groupId, `${e.name}.groupId`); (e.implements ?? []).forEach((i) => need(i, `${e.name}.implements`)); });
(d.relationshipTypes ?? []).forEach((r) => { need(r.sourceEntityTypeId, `${r.name} 起点`); need(r.targetEntityTypeId, `${r.name} 终点`); });
(d.interfaces ?? []).forEach((x) => { (x.extends ?? []).forEach((i) => need(i, `${x.name}.extends`)); (x.linkConstraints ?? []).forEach((c) => need(c.targetId, `${x.name}.${c.name}`)); });
(d.actionTypes ?? []).forEach((a) => { need(a.scopeEntityTypeId, `${a.name}.scopeEntityTypeId`); (a.params ?? []).forEach((p) => { if (p.kind === "ENTITY_REF") need(p.entityTypeId, `${a.name}.${p.code}`); }); });
(d.rules ?? []).forEach((r) => { need(r.actionId, `${r.name}.actionId`); if (!(r.conditions ?? []).length) fail.push(`规则「${r.name}」没有条件`); });

console.log(fail.length ? "❌\n" + fail.join("\n") : "✅ 结构自检通过");
process.exit(fail.length ? 1 : 0);
```

再人工过一遍**语义**（机器查不出来的）：

- [ ] 接口里 `required` 的每个属性，实现方都有**同名**属性。
- [ ] 接口里 `required` 的关系约束，实现方都有一条「起点=自己、终点=约束目标」的**方向正确**的关系类型。
- [ ] 动作的 `scopeEntityTypeId` 是业务上真正接受这个动作的对象类型（不是随便挑一个）。
- [ ] 规则条件里的 `property` 在主对象类型上存在；处置档位选对（拒绝用 `BLOCK`，只提示用 `WARN`）。
- [ ] 名称都是业务语言，没有 `tb_` 前缀、没有中文列名。
- [ ] 属性 `dataType` 与真实数据一致（金额 `DECIMAL`、时间 `DATETIME`…）。
- [ ] 表名、列名来自材料；**没有**凭空编造。
- [ ] 交付说明里写清"导入后先校验再发布"，以及哪些对象类型还需要重新选表。

### 4. 交付

给用户的说明应该包含：

1. 文件（`<标识>.ontology.json`）与它的 `ontology.name`；
2. 结构规模：对象类型 / 关系类型 / 接口 / 动作 / 规则的数量；
3. **导入路径**：平台左侧「本体」→「导入本体包」→ 选文件 → 选存储资源 → 导入；
4. 导入后的两步：**校验**（看有没有被拦）→ **发布**（发布后图库才会有结构，实例另算）；
5. 已知待确认项：没有绑上来源的对象类型、没有实现的接口、待确认的表/列。

## 最低限度的骨架

只有对象类型和关系类型也能导入：

```json
{
  "format": "ontology.bundle",
  "formatVersion": 1,
  "exportedAt": "2026-09-16T10:00:00.000Z",
  "ontology": { "identifier": "line-service", "name": "专线服务本体", "description": "", "color": "", "tags": [] },
  "dataSources": [],
  "definition": {
    "groups": [],
    "interfaces": [],
    "entityTypes": [
      {
        "id": "<UUID>",
        "name": "专线产品用户",
        "description": "开通了专线产品的用户实例。",
        "displayProperty": "USER_NAME",
        "groupId": "",
        "implements": [],
        "properties": [
          { "name": "USER_ID", "displayName": "用户标识", "dataType": "TEXT", "required": true, "unique": true, "indexed": false },
          { "name": "USER_NAME", "displayName": "用户名称", "dataType": "TEXT", "required": false, "unique": false, "indexed": false }
        ],
        "sources": []
      }
    ],
    "relationshipTypes": [],
    "actionTypes": [],
    "rules": []
  }
}
```

（`groups` / `interfaces` / `entityTypes` / `relationshipTypes` / `actionTypes` / `rules` 都是数组，
不写的字段会取默认值；`properties` 里没写的 `displayName` / `description` / `unique` / `indexed`
也会取默认值。）

## 常见报错

| 报错 | 原因 | 修法 |
| --- | --- | --- |
| 这不是本体包：format 应该是「ontology.bundle」 | `format` 写错 | 改顶层 `format` |
| 这个本体包是更新版本导出的（vN）… | `formatVersion` 大于平台支持 | 用 v1 字段集重新生成 |
| 数据资源「X」在本机没有登记…来源绑定已留空 | 包里坐标在本机没登记 | 在本机「数据资源」登记同一坐标，或导入后重新选表 |
| 动作「X」需要选择作用的对象类型 | `scopeEntityTypeId` 空或指向不存在 | 把动作绑到一个对象类型上 |
| 对象类型「X」实现接口「Y」，还缺必填属性：Z | 少了同名属性 | 补属性，或去掉接口里的 `required` |
| 对象类型「X」实现接口「Y」，还缺关系约束「Z」 | 没有方向正确的实现关系 | 补一条关系类型（起点=实现方、终点=约束目标） |
| 规则「X」还没有配置条件 | `conditions` 空 | 补条件；不需要这条规则就删掉 |
| 关系端点不符合草稿中的对象类型契约 | 关系两端对象的类型与关系类型声明不一致 | 这是**实例数据**的问题（不是包本身）；先发布干净的结构 |

## 边界

- 本体包**不带实例数据**（`statistics.objects` 只是统计）。实例来自发布时的图库快照或后续在「对象」页写入。
- 平台**不从绑定自动取数**：`sources` 说明"这些对象的属性从哪来"，不是取数脚本。
- 导入**不会发布**，也不会改动已有本体；同一份包可以反复导入成多个本体（id 会重发）。