# 结构化清单（blueprint）

这份文件是 `ontology-bundle` 的参考：**模型写的那份清单**长什么样。

清单是编译器的输入，包（`ontology.bundle`）是输出。两者表达的是同一套本体，
差别只有三点 —— 这三条就是"让模型少犯错"的全部理由：

| | 清单（模型写） | 包（脚本产出） |
| --- | --- | --- |
| id | **不写** | 每个实体一个 UUID，引用按 id 改写 |
| 引用 | 写**名字**（「客户」） | 写 id |
| 格式字段 | 只写业务，`format` 可省 | `format` / `formatVersion` / `exportedAt` / `generator` / `statistics` 由脚本补齐 |

所以清单里**不会出现 UUID**，也不会出现 `dataSourceId` 这种"要先知道平台里有什么"的字段 ——
数据资源按**连接坐标 + 名字**引用，平台导入时自己去匹配本机登记的资源。

## 顶层结构

```json
{
  "format": "ontology.blueprint",
  "formatVersion": 1,
  "ontology": { "identifier": "line-service", "name": "专线服务本体", "description": "", "color": "", "tags": [] },
  "dataSources": [],
  "groups": [],
  "interfaces": [],
  "objectTypes": [],
  "relationTypes": [],
  "actionTypes": [],
  "rules": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `format` | 建议写 | 固定 `ontology.blueprint`。写了脚本会核对，防止把包当清单喂进来 |
| `formatVersion` | 否 | 现在是 `1` |
| `ontology.name` | **是** | 本体名，界面上显示的就是它 |
| `ontology.identifier` | 否 | 机器标识（小写连字符）；不写就按名字生成 |
| `ontology.description` / `color` / `tags` | 否 | 说明 / 强调色 / 标签 |
| `dataSources` | 否 | 数据资源的**连接坐标**（`name` / `kind` / `host` / `port` / `databaseName` / `schemaName`）。**绝不写账号密码** |
| `groups` | 否 | 概念分组：`name` / `color` |
| `interfaces` | 否 | 接口：`name` / `description` / `properties` / `extends` / `linkConstraints` |
| `objectTypes` | 否 | 对象类型：`name` / `description` / `displayProperty` / `group` / `implements` / `properties` / `sources` |
| `relationTypes` | 否 | 关系类型：`name` / `description` / `source` / `target` / `properties`。关系类型是**双向**的：只写一条，反向不用再建 |
| `actionTypes` | 否 | 动作：`name` / `code` / `description` / `scope` / `params` / `edits` |
| `rules` | 否 | 规则：`name` / `effect` / `priority` / `enabled` / `action` / `conditions` / `message` |

## 哪些字段按名字引用

| 写在哪儿 | 引用什么 |
| --- | --- |
| `objectTypes[].group` | 概念分组名 |
| `objectTypes[].implements[]` | 接口名 |
| `objectTypes[].sources[].dataSource` | 数据资源名（`dataSources[].name`） |
| `relationTypes[].source` / `.target` | 对象类型名 |
| `interfaces[].extends[]` | 接口名 |
| `interfaces[].linkConstraints[].target` | 对象类型名或接口名（默认按对象类型找，找不到再按接口找；想强制就写 `targetKind`） |
| `actionTypes[].scope` | 对象类型名（动作定义在它上面） |
| `actionTypes[].params[].entityType` | 对象类型名（只对 `kind: "ENTITY_REF"` 有意义） |
| `actionTypes[].edits[].entityType` / `.relationshipType` | 对象类型名 / 关系类型名 |
| `rules[].action` | 动作名（空 = 对所有动作生效） |
| `rules[].conditions[].subject.relationshipType` | 关系类型名（先沿这条关系跳到邻域再比属性） |

**解析不了就报错**，并把当前清单里可用的名字列出来 —— 照着改就行，不用猜。

两个例外，写的是**类型内部的局部 id**（不是名字）：

- `objectTypes[].sources[].id`：这份来源在本类型内的标识，默认 `primary`（第 2、3 份是 `source2`、`source3`）。
- `objectTypes[].properties[].source`：这个属性取自哪一份来源，写上面那个局部 id；不写 = 主来源。

`actionTypes[].edits[].entityRef` / `.sourceRef` / `.targetRef` 与 `assignments[].value` 也不按名字引用，
它们指的是**动作自己的入参或上一步的别名**：`{ "kind": "SUBJECT" | "PARAM" | "EDIT", "code": "<参数 code 或 alias>" }`。

## 枚举

| 字段 | 可选值 |
| --- | --- |
| `properties[].dataType` | `TEXT` / `INTEGER` / `DECIMAL` / `BOOLEAN` / `DATE` / `DATETIME` / `TEXT_ARRAY` / `JSON`（不写默认 `TEXT`） |
| `dataSources[].kind` | `ORACLE` / `POSTGRES` / `MYSQL` |
| `interfaces[].linkConstraints[].cardinality` | `ONE` / `MANY`（默认 `MANY`） |
| `actionTypes[].params[].kind` | `ENTITY_REF`（指向一个已有对象）/ `VALUE`（字面量） |
| `actionTypes[].edits[].op` | `CREATE_ENTITY` / `SET_PROPERTY` / `CREATE_RELATIONSHIP` |
| `actionTypes[].edits[].assignments[].value.kind` | `PARAM` / `CONST` / `NOW` |
| `rules[].effect` | `BLOCK`（拒绝）/ `WARN`（只提示）/ `HIDE`（动作在满足条件的对象上不出现；必须绑具体动作） |
| `rules[].conditions[].operator` | `EQUALS` / `NOT_EQUALS` / `IS_TRUTHY` / `IS_FALSY` / `IS_EMPTY` / `IS_NOT_EMPTY` |

## 最小例子

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

完整例子（4 个对象类型、接口、动作、规则、数据来源都有）见 `example.blueprint.json`。

## 编译

```bash
node scripts/build-bundle.mjs <清单.json> --check   # 只校验
node scripts/build-bundle.mjs <清单.json>           # 产出 <标识>.ontology.json
```

- 退出码：`0` 成功、`1` 清单有问题、`2` 用法不对。
- 报错信息会指出**哪一条、缺什么、可选的有哪些**。
- 提醒（`⚠`）是建模建议，用的是平台「建模体检」的规则码（见 `ontology-builder/references/modeling-rules.md` 第 9 节）。
- 编译器**只保证引用与结构**；"这个对象类型该不该建""命名是不是业务语言"这类判断它做不了 ——
  那部分靠 `ontology-builder/references/modeling-rules.md` 的细则，导入后还有平台的「建模体检」兜底。
