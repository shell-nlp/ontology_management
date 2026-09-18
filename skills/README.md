# 本体构建 Skills（ontology-engineering）

这套技能让 AI 助手（Codex / Claude 等带 Skills 能力的 Agent）按本平台的建模规范，
**从业务材料一步一步构建出一个本体**，最后产出一个可以直接导入平台的 JSON —— 本体包
（`format: "ontology.bundle"`，后缀 `.ontology.json`）。

出包分两步：模型只写**结构化清单**（用名字引用、不写 UUID），再由技能自带的编译脚本编译成包。

平台里对应的入口：**本体技能**（侧栏「语义模型」下），能看技能原文、逐文件下载、整套打包下载。

## 三条技能

| 顺序 | 技能名 | 解决的问题 | 主要产物 |
| --- | --- | --- | --- |
| 1 | `ontology-requirement` | 材料还是散的（PRD / 访谈纪要 / 流程说明 / 口述），先明确业务目标、范围、规则与验收 | `01-需求澄清.md`：对象类型 / 关系类型 / 接口 / 动作 / 规则的候选清单 + 落地线索 + 待确认问题 |
| 2 | `ontology-builder` | 清单要变成可评审的建模方案：粒度、命名、主键、属性类型、方向、约束 | `02-建模方案.md` + `*.blueprint.json` 初稿（结构化清单） |
| 3 | `ontology-bundle` | 出包、自检、交付：产物必须能通过平台的导入与发布前校验 | `<标识>.ontology.json`（技能自带的脚本从清单编译产出，可直接导入） |

三条可以连起来用，也可以单用第 3 条把已有方案落成 JSON。**平台的「导入本体包」只认本体包 JSON**，
所以无论从哪一步开始，最终交付物都是那个 `.ontology.json`。

## 安装

技能就是一组 Markdown + 参考文件，不需要装依赖、也不需要连平台。放到 Agent 的技能目录里即可：

- Codex：`~/.codex/skills/<技能名>/SKILL.md`
- 通用 Agent Skills 目录：`~/.agents/skills/<技能名>/SKILL.md`

在平台的「本体技能」页点「获取 Skills」下载 zip，解压后把三个目录整个放进去，重启会话即可使用。

**也可以不装，直接连**：平台把这三套技能同时发布成了一个**免令牌的 MCP 服务**（地址在「本体技能」页的
「MCP 接入」里，形如 `http://<平台地址>/api/skills/mcp`）。把它填进 Agent 的 MCP 配置，Agent 就能自己
`list_ontology_build_skills`（看有哪些技能）→ `get_ontology_build_skill`（取某套的完整说明）→
`get_ontology_build_skill_file`（取它自带的参考文件与脚本）取用这三套技能，也能当斜杠命令用 ——
不用下载、不用配技能目录。MCP 里提供的是同一份内容，两条路等价，按你的环境挑一条即可。

## 出包怎么走：清单 → 编译

模型**不直接写包**，只写一份**结构化清单**（`*.blueprint.json`：引用写名字，不写 UUID、不写格式字段）；
再用技能自带的编译脚本把清单编译成平台能导入的**本体包**（`*.ontology.json`）：

```bash
node scripts/build-bundle.mjs <清单.json> --check   # 只校验：引用能不能解析、结构对不对
node scripts/build-bundle.mjs <清单.json>           # 产出 <标识>.ontology.json
```

Windows / Linux / macOS 一样（Node 18+，脚本只用内置模块、不装依赖、不联网）；路径带空格就加引号。

- 为什么这么分：手写 UUID 与 id 引用最容易错（对不上就整包报错），格式字段也容易漂 —— 这两件事交给脚本。
- 清单格式见 `ontology-bundle/references/blueprint-format.md`；可照抄的例子见 `ontology-bundle/references/example.blueprint.json`
  （编译出来的结构就是 `ontology-bundle/references/example.bundle.json` 的样子）。
- 手写包也能交付：按 `ontology-bundle/references/bundle-format.md` 写，再用 `node scripts/check-bundle.mjs <包.json>` 过一遍结构。

## 交付契约（为什么产物是 JSON）

- 一个本体包 = **一份结构**（对象类型 / 关系类型 / 接口 / 概念分组 / 动作 / 规则）+ 数据资源的连接坐标。
  不含实例数据，也不含任何账号密码。
- 导入时平台会**重发所有 id**，并按「类型 + 主机 + 端口 + 库 + 模式」把数据资源接回本机已登记的资源；
  接不上的来源绑定**留空并点名**，不会静默丢。
- 导入后停在**草稿**：先「校验」，再「发布」。发布前校验会检查来源绑定、端点契约、必填/唯一、
  接口实现与动作规则。
- 字段级规范与全部枚举见 `ontology-bundle/references/bundle-format.md`；
  一份**能通过校验的完整示例**见 `ontology-bundle/references/example.bundle.json`。

## 平台侧的建模体检

出包之后、发布之前，平台会给草稿做一次**建模体检**（本体草稿页头「建模体检」）：空壳与孤悬的对象类型、
主键列没属性接、必填属性没映射列、命名打架、关系端点没选、接口没人实现这类问题，会按「该改 / 可以更好」
两档列出来。**它不挡发布**，是建议层；硬性门禁仍然是发布前校验。它只在平台界面上跑，没有对应的 MCP 工具
（外部 Agent 照着 `ontology-builder/references/modeling-rules.md` 第 9 节的规则码自查即可）。

## 术语（与平台界面一致）

| 平台里的词 | 含义 | 代码里的字段 |
| --- | --- | --- |
| 对象类型 | 一组对象的定义（主键、属性、展示属性、数据来源） | `entityTypes[]` |
| 对象 | 对象类型的一个实例，例如「张三」 | 图里的节点 |
| 关系类型 | 两个对象类型之间的关系的定义 | `relationshipTypes[]` |
| 关系 | 两个具体对象之间的一条关系 | 图里的边 |
| 接口 | 抽象契约：实现它的对象类型必须有哪些属性与关系 | `interfaces[]` |
| 动作 | 定义在**某个对象类型**上的写操作 | `actionTypes[]` |
| 规则 | 挂在动作上的拦截 / 提示 / 隐藏（BLOCK / WARN / HIDE） | `rules[]` |
| 概念分组 | 业务域，只影响图谱怎么摆、怎么画框 | `groups[]` |
| 数据资源 | 业务数据在哪个库里（Oracle / PostgreSQL / MySQL…） | `dataSources[]` |

**「类」= 对象类型**，只是口头简称；写进 JSON 与界面文案时一律用「对象类型」。
**类之间没有父子继承**：平台里的抽象机制只有接口一种。