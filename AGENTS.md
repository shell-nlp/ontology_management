# AGENTS.md

## AGENTS.md 记什么（2026-10-10 用户要求）

用户口径：「agent.md 是记录要求和代办的……里面有已经解决过的问题，这个也在里面是不对的」。

- 只记**要求**（口径 / 约定 / 禁令 / 当前接口与字段规格）与**待办**（Backlog）：以后干活要遵守的、还没做的。
- **不记**已解决的问题、修复过程、实测过程 —— 那些进 `docs/历史决策与踩坑.md` 或 git 提交信息。
- 写之前先问一句：这是「以后必须怎么做」还是「当时怎么修的」？后者不进这个文件。
- 「为什么这么设计」只留**一句结论式理由**，不写修复过程。

## 系统说明书维护（2026-10-10 用户要求）

- `docs/系统说明书/` 是项目最终系统说明书的长期载体，不是一次性设计稿，也不是修复日志。
- **随着功能实现和演进，要不断完善这份系统说明书**：新增功能、修改协议/数据结构、改变语义或安全边界、增加错误码、增加后端或工具接入时，必须同步更新对应章节。
- `AGENTS.md` 只记录“以后必须遵守的要求、口径和待办”，不搬运系统说明书内容；系统说明书的完整细节一律写在 `docs/系统说明书/`。
- 如果某次改动影响已有说明，不能只改代码，必须把说明书更新纳入同一次交付。

## 查询工具策略（2026-10-10 用户要求）

- **`run_sql` 必须保留，不删除、不改成不可用工具**：它是排障与 DSL 暂不支持场景的兜底能力。
- `run_query` 是结构化问数的优先入口；DSL 能用时优先走 DSL。
- 后续无论怎么调整 Agent 工具集、提示词或 MCP 暴露，都不能把 `run_sql` 从可用工具里移除。

## Git 约定
- 禁止使用 `git worktree`（含 `git worktree add/list/remove`）。不要创建多余的工作目录或把分支检出到别处。
- 所有分支变更（新建、切换、合并）都在本仓库目录 `D:\project\ontology_management` 内通过常规 `git checkout` / `git branch` / `git merge` 完成。
- 不要替用户提交：改动实现并验证后留在工作区，提交由用户自己执行（2026-09-11 明确要求）。

## 验证力度（2026-09-18 用户要求）

- **明确的小改动：做完一次针对性验证就交付。** 2026-09-18 用户原话：「以后这类明确的小改动，
  完成后做一次针对性验证就交付」。别叠流程 —— 不要「全量单测 + typecheck + lint + 浏览器多轮复核」
  全跑一遍才算完。
- 挑**最贴近改动**的那一种验证，够用就停：
  改文案 / 样式 / 页面结构 → 页面实测一次；改纯函数 → 跑对应单测；改类型签名 → typecheck。
- 只有动到跨层契约（schema / 存储 / 对外接口）或一次改多个互不相干的模块时，才升级到全量。
- **测试一律并行跑，别加 `--no-file-parallelism`**（2026-10-10 用户要求：「测试用并行要写进 agent.md，
  这样每次就用并行了」）：
  - 全量 = `pnpm test`（= `npx vitest run`，vitest 默认按文件并行）；单文件 = `npx vitest run <路径>`。
  - 实测：全量 469 条**并行 7.5 秒**，串行 30～80 秒。并行是默认动作，不是"可以试试"。
  - 只有出现"某条用例超时"这种抖动时，才**把那一个文件**单独串行重跑确认一次；历史上只有
    `tests/lib/graph/embedded.test.ts` 会这样（抢 CPU 时 5s 超时，单跑 1.4 秒过）。
  - 判定口径：**结果以并行那一次为准**，别因为一次抖动就把命令改回串行。
- 能并行的验证就并行发起（例如 `tsc --noEmit` 与 `vitest run` 同时跑），别串着等。

## CodeGraph（找代码优先用它）

记录时间：2026-09-18。用户要求「后面要记着常用这个工具，比较省 token」。

- 本仓库**已建索引**（`.codegraph/`，用 `codegraph status` 看统计）。找代码、定位符号、看调用关系时
  **先用它，再考虑 grep 或逐个读文件**。
- **走 shell，不要指望 MCP**（2026-09-18 复核）：`codegraph_explore` 这个 MCP 工具在本工作区**用不了**，
  但原因不是"没注册"——全局 `mcp.json`（`%APPDATA%\Trae CN\User\mcp.json`）里**有**一条 `codegraph`，
  只是它把路径写死成了 `-p d:/project/shangke-platform`，而**那个项目的索引是坏的**
  （`codegraph status` 报 `disk I/O error`），所以对本仓库无效。一个 MCP 条目只能钉一个项目，
  而 `d:/project` 下有 ~20 个项目 —— 这就是选 CLI 的根本原因，别再往 mcp.json 里加死路径。
  CLI 输出与 MCP 工具完全一样：`codegraph explore "<符号名或一句话问题>"`。同一个 CLI 还有
  `query`（按名字搜符号）、`node`（单符号源码 + 调用链）、`callers` / `callees` / `impact`（调用关系与影响面）、
  `context`（按任务拼上下文）、`status`（索引统计）、`sync`（增量更新）。
- **开工前先 `codegraph sync`**：索引落后于磁盘时会给出过期的调用方。本仓库索引建于 9/17 16:44，
  改过文件之后再 sync 才认得出新代码（2026-09-18 实测：12 个文件变更、+541 个节点，1 秒内完成）。
  2026-09-18 复核：索引健康（168 文件 / 3,155 节点 / 8,160 边 / 10.5 MB），`sync` 返回
  `Already up to date`。`sync` 会往 `~/.codegraph/telemetry-queue.jsonl` 写匿名遥测，被沙箱拦时会以
  exit code 1 结束（**同步本身已经成功**，别误判成失败）——**本机已于 2026-09-18 执行
  `codegraph telemetry off`**（配置在 `~/.codegraph/telemetry.json`），现在 sync 干净返回 exit 0，
  再看到那个沙箱报错就说明这条被改回来了。
- 实测省在哪（2026-09-18）：一条 `codegraph explore` 直接拿到 `validateVersionSnapshot`（6 个调用方）、
  `ontologyDefinitionSchema`（17 个调用方），以及哪些文件带测试 —— 省掉了先 grep 再逐个打开文件的往返。
- **什么时候不用**：只查精确字符串（改文案、排查界面术语）时 `rg` 更快；CodeGraph 是「找代码」用的，
  不是「找文本」用的。

## 依赖与实现原则
- 优先直接使用知名、成熟的库或现成组件，非必要不重复造轮子。只有现有库/组件确实不满足业务需求时，才自行实现，并在代码中说明理由。

## 工具输出：只砍"重复"，不砍"信息"，也不轻易改"读法"（2026-10-08）

三条口径按顺序来，缺一条都会做偏：

1. 用户先说：「工具输出都是 json，很多字段都是重复的，导致 token 很多」；
2. 紧接着补：「改的时候，有个原则，**不要丢失重要信息**」；
3. 第一版仍做过头（对象改位置数组、detail 里属性清单截断、常驻说明删掉），用户反问：
   「我要求只是缩短 token，但是你把整个输出的信息都改了，信息密度都变了」。
   —— **这三类改动性质完全不同，必须分开对待**：

| 类别 | 手段 | 信息量 | 读法 | 结论 |
| --- | --- | --- | --- | --- |
| **A** | 同一信息不重复出现：回显模型刚发过的 SQL、MCP 不缩进、DDL 注释内联、删"能由别的字段推出"的字段 | 不减 | 不变 | **放心做** |
| **B** | 同一信息换更紧凑的写法：对象数组 → 位置数组（列名放 `columns`） | 不减 | **变了** | **可以做，但列序必须写进工具 description**；这是省 token 的主力 |
| **C** | 真的少给内容：属性清单截断、默认值/空值不输出、常驻说明删掉 | **减了** | 变了 | **不要做**，除非用户明确点名要求 |

**为什么 C 特别危险**：模型每多绕一步，要把整个上下文重发一遍 —— 实测**每一步约 35,000 token**，
而一次 `search_schema` 的结果全量省下来只有约 3,000 token。**省一步 = 省十次结果**。
删掉模型用来做路由决策的内容（典型是"这个对象类型有哪些列"），省的是小钱、赔的是大钱：
2026-10-08 同一问题实测出现过 27 次工具调用（改动前 15 次），回退 C 之后回到原状。

执行要求：
- 做 B 之前先写死列序（工具 `description`），并在单测里断言"说明里含这个列序"——说明与实现对不上就是真丢信息。
- 做 A 时"能推出"≠"不重要"：`bound_object_types` 的 `primary_key`、边上的 `cardinality` 这类附属信息
  **不能顺手删**（2026-10-08 是测试先发现了这两个漏项）。
- **"能由别的字段推出"要先验证，不能凭感觉**：`bound_object_types.mapped_column_count` 看着像
  `mapped_columns.length` —— 2026-10-08 那会儿**确实不是**（列清单只列前 30 个，总数是真实值，37 vs 30）。
  **2026-10-10 起清单给全了**（见下一节），两者一致，计数仍保留。2026-10-08 是用**对拍**抓到的：
  把 tools.ts 临时切回改动前的提交采一份输出，再切回改后版本采一份，
  用脚本把位置数组还原成对象做逐字段深比较，唯一对不上的一项就是它。
**对拍做法（值得复用）**：`git show <改动前的提交>:src/lib/reasoning/tools/` 写到文件 →
  调 MCP 采整数份 `old-*.json` → 还原自己的版本再采 `new-*.json` → 脚本里按列序把数组还原成对象后深比。
  最终只剩这三类"预期差异"才算通过：运行时字段（`elapsed_ms`）、新增字段、以及 A 类里明确不改写就不回显的字段
  （`statement` / `read_only_transaction`，且要有测试证明改写时它们会回来）。
- 删任何东西之前先找到新家；改完逐条列一遍「删了什么、现在在哪」。
- 有争议就不做：自创紧凑编码（`k:n;s:45`）一律禁止 —— 优化方向是"少说重复的话"，不是"换一种说法"。

实测（2026-10-08，真实 MCP 调用六个工具一轮）：
**只做 A + B → 51,117 → 39,219 字符（-23%），信息量与改动前完全等价**；
功能侧的口径见 `docs/功能实现记录.md` 的「工具输出约定」一节。

## 代码与测试目录（2026-09-18）

- 源码放 `src/`，测试统一放 `tests/`，按源码相同的子路径组织（例如 `src/lib/framework/graph/embedded/index.ts`
  对应 `tests/lib/graph/embedded.test.ts`）。`vitest.config.mts` 只收集 `tests/**/*.test.ts`，
  **不要再在源码目录新增测试文件**。
- 本体存储各实现用自己的目录：`src/lib/framework/graph/jena/`、`src/lib/framework/graph/embedded/`；
  `graph/` 根目录只放公共接口、注册表与跨实现共享模块。新增多文件后端也按此结构隔离，
  不把不同后端的实现平铺在 `graph/` 根目录。

## 智能问答：运行归服务端 + 时间只认前端时钟（2026-10-10）

- **运行归服务端**：`src/lib/reasoning/run-registry.ts` 是运行登记处（起一轮、留存事件、订阅、取消）。
  端点：`POST /api/reasoning/runs`、`GET /api/reasoning/runs?targetId=`、
  `GET /api/reasoning/runs/[runId]/events?after=N`（SSE 接上）、`POST /api/reasoning/runs/[runId]/cancel`。
  `POST /api/reasoning/stream` 保留为「起一轮 + 就地看完」的薄壳，协议只有 `run-stream.ts` 一处实现。
- **断开 ≠ 停止**：关页面、切页、刷新都只是「不看了」，运行照常跑完并落进历史；真停只认 cancel。
  界面侧 `src/lib/reasoning/live-runs.ts` 是本机登记处，`qa-studio.tsx` 只订阅它 —— 组件卸载不中断运行。
- 界面三条规矩：「新对话」不停正在跑的那一轮（`detachRunningRuns()` 让到后台）；切走再回来要接回画面
  （`lastSeenConversation` + `openConversation`）；`busy` 只按**当前这一段**算，翻历史/开新对话不受影响。
- **时间一律用前端时钟**：展示耗时由浏览器算（`startedAtMs` → `Turn.liveElapsedMs`），
  服务端回的 `elapsedMs` 只写运行记录、**不用它显示**；侧栏的「今天/昨天 + 时刻」由 `conversationTimeLabel`
  在浏览器格式化 —— 别在服务端渲染里烤死时区（容器是 UTC，烤进去就差 8 小时）。
- 边界（要对用户讲清楚）：运行**只在内存**里，进程重启、容器重建都会丢掉正在跑的那些（已落库的不受影响）；
  跑完但没落库的记录留 10 分钟给界面接回。要跨重启继续跑就得把运行落库 —— Backlog 未排期。
- 实现细节（登记处挂 `globalThis`、补看游标含端点、先订阅再补看、`done` 会来两次）见
  `docs/历史决策与踩坑.md`。

## 列清单不设上限、不砍尾巴（2026-10-10 用户口径）

以后加任何 `list_*` / 数组类返回都按这三条：

1. **定义层清单默认给全**：映射列、字段清单这种「条数由本体/表结构决定」的数组**不加条数上限**。
   **检索类**（`search_schema` 按分数排序那种）另说：默认给前 50 条，但**必须**回 `total_matched` / `omitted`，
   并允许调用方把 `max_concepts` 调到 1000 拿全。**关键是「能不能看见」**：数量、被省掉多少、怎么拿全量，缺一个就是 bug。
2. **截了就必须说**：真要截（调用方传了上限、或后端有硬性量级控制），返回里要带**总数**与**被省掉的条数**，
   并说明省掉的是哪些、怎么才能拿到。**静默截断 = bug。**
3. **「够用就行」不是理由**：模型多绕一步要把整个上下文重发（约 35,000 token/步），
   而多给几十行清单只有几百 token。

## 耗时单位分级 + token 要分两个数（2026-10-10）

- 时间与条数的展示走 `src/lib/framework/format-units.ts`（**唯一出口**，纯函数，有单测）：
  `formatDuration(ms)`（`812ms` → `4.9s` → `1分52秒` → `1小时05分` → `2天03小时`，10 秒内留一位小数、再往上取整）；
  `formatCount(n)`（`950` → `5.7k` → `833.9k` → `1.2M`）。**别再写 `{x}ms` / `{x/1000}s`。**
- **token 要分两个数**：`ReasoningUsage.lastInputTokens` / `lastOutputTokens` = **最后一步这次调用**的用量
  （页脚显示「上下文 5.0k · 输出 239 tokens」，同时也是「离上下文上限还有多远」的度量）；
  `promptTokens` / `completionTokens` / `totalTokens` = 累计（页脚显示「累计 1.1M」），**计费口径**。
  旧运行记录没有 `last*` 就只显示累计 —— 别把累计冒充成「上下文」。
## 术语约定

**界面文本用 Palantir 的全称，两层结构各一套词，不混用。**

- **类型层**：**对象类型**（= Palantir 的 Object Type）、**关系类型**（= Link Type）
- **实例层**：**对象**（= Object）、**关系**（= Link）
- **「类」= 对象类型，只是口头简称**：对话和代码注释里可以写「类」，但**界面上不写「类」**，一律写「对象类型」。
  例外是复合词——分类 / 类型 / 子类型 等，按汉语习惯保留（「父类 / 子类」不算：类之间已经没有继承，见下）。
- 「关系」**不是**「关系类型」的短称——指类型时必须写全「关系类型」，因为「关系」已经是实例层的词。
- **关系类型是双向的**（2026-09-19，对齐 Palantir 的 link type）：一条关系类型只有**一个**定义、两个端点，
  建好之后两个方向都能走，**不配置、也不需要**两侧各自的名字（用户明确口径：「只要构建了关系，就是双向就行，
  不需要再配置这些正向、反向名字」）。所以**反向不要再建一条关系类型**；两条并列的关系类型表示的是两个不同的现实关系。
  界面上用 `↔` 表示这个双向；多跳遍历默认不分方向（`traverse_object_types` 的 `direction` 可以收窄成 `forward` / `backward`）；
  接口的关系约束也按双向判定 —— 实现方在这条关系的**任一头**都算满足（`@/lib/ontology/interfaces` 的 `satisfiesLinkConstraint`）。
- 与 Palantir 文档对齐时写成「对象类型（Object Type）」，不要在同一处来回切换两种叫法。
- 左侧导航按 **本体模型（本体建模 / 本体技能）· 本体实例（实例图谱 / 对象 / 关系）· 动力模型（动作 / 规则）** 分组（2026-09-18 更新）：本体列表已并入「总览」下方，当前本体状态在上方；总览「查看本体」进入本体建模。图谱只保留实例视图，不再有「查看本体」切换；类型定义和关系类型在本体建模画布查看、搜索。平台分组只有数据资源与设置，图引擎连接在「设置 → 图引擎配置」管理。
- **接口投影**（2026-09-19）：本体建模画布中，无数据源的对象类型可以「提取为接口」。平台保留原对象类型与底层关系作为兼容影子，新增接口记录 `promotedFromEntityTypeId`，并把原关系转成接口关系约束；**不根据关系另一端自动推断 `implements`**。画布隐藏影子节点、显示紫色接口节点与紫色虚线实现边；接口承接的关系用青绿色实线画出来（`showInterfaceLinks` 开关默认打开，"接口节点看着和谁都没连线"是用户报过的问题）。不要把这条 UI 投影误认为实例层数据被删除。
- **实现接口 = 继承接口的关系类型**（2026-09-19 用户明确的要求，语义与 Palantir 一致）：对象类型 A 实现了接口 B，A 就**有了 B 的全部关系类型**。
  落到三处，缺一处用户就会发现对不上：
  1. **画布**：默认这些关系挂在**接口节点 B** 身上（不点任何东西时只属于 B）；一旦选中实现方 A，就改挂到 A 身上
     （`inherited-link:<interfaceId>:<relationId>:<entityTypeId>`，见 `buildCanvasProjection`），让"点 A 就能看到 A 从接口集成来的关系类型"。
     **不要两份都画**（那会变成指向同一个对端的两条平行线），也不要只画在 B 上而不给 A。
2. **工具**：`interfaceDerivedLinks()`（`src/lib/reasoning/tools/`，投影逻辑在 `projection.ts`）把接口约束算成实现方的边，`get_object_type` 放在 `one_hop.via_interfaces`，
     `traverse_object_types` 直接进图并给边打 `via_interface`。只认 `relationshipTypes` 的话，实现方会显得孤立，模型就会答"走不到"。
  3. **弹窗/右栏**：关系类型的详情里要写清"由接口「B」承接"、哪些对象类型实现了它，并给「编辑接口」入口。

  变更时一起改的测试：`tests/lib/ontology-canvas.test.ts`（挂载归属）与 `tests/lib/reasoning/tools.test.ts`（遍历算上接口边）。
- 画布投影是**纯函数** `src/lib/ontology/canvas.ts` 的 `buildCanvasProjection()`（有单测 `tests/lib/ontology-canvas.test.ts`）：节点、连线、分组框、待补全清单都在那一处算，组件只负责渲染。两条硬规矩：**所有接口都要画出来**（紫色 + 虚线圈 + 标签 `◇`，不是"只画被选中的那个"）；**被提取成接口的节点留在原地** —— 接口接手影子对象类型在布局里的位置与手工拖过的坐标，转换前后不跳位。
- **虚线只给"实现接口"**（2026-09-19 用户口径：接口的联系不是全都虚线，实现了它的对象类型才是虚线）。接口节点自己画虚线圈；`entity → interface` 的实现边是紫色虚线；接口承接的关系（`interface-link`）用**青绿色实线**，只在展开时出现。
- **接口按对象类型那套方式编辑**（2026-09-19 用户口径：「我说的意思是形如这样」，指的就是「编辑对象类型」那个对话框）：画布右栏只放详情与「编辑」按钮，点开 `src/components/interface-edit-dialog.tsx` —— 和 `TypeEditDialog` 同一个壳（`ted-*` 样式、左栏表单 + 右栏画布预览 + 底部「取消 / 保存修改」），里面改名称、说明、继承的接口、属性、关系约束，并勾选"谁实现了它"（写回 `entityTypes[].implements`）。**不要改成"跳到接口标签去改"，也不要在右栏塞一套独立的行内编辑器**。「在『接口』标签里看」只作为完整视图（继承、实现缺口）的次要入口保留。
- 全局版本操作放页头右侧，不另占一整行：始终显示「当前版本 vN」（未发布时显示「尚未发布」），有草稿时再并列显示草稿版本；「创建草稿」「版本记录」及历史版本激活入口仍可用。
- **画布上每一条线都要能点开编辑，不允许"点了没反应"的连线**（2026-09-19 用户口径：「点击关系类型，可以实现编辑，不用跳转的那种」）：
  - 关系标签画在 `sigma-graph.tsx` 的 `EdgeDecorationLayer`（叠在 Sigma 画布上的 SVG）里，而 `.graph-sigma-canvas .sigma-self-loops` 是 `pointer-events:none`：
    Sigma 的 `clickEdge` 与"离边 9px 内算点中"的兜底都收不到落在标签上的点击，用户点标签等于点空。
    所以标签的 `<g>` 必须自己 `pointer-events:auto` + `cursor:pointer`，并在 `pointerdown` / `click` 上 `stopPropagation()`
    —— 不拦的话 Sigma 会在同一手势里再判一次，把刚选中的东西清掉。
  - 画布上有三类连线 id：草稿里的关系类型（UUID）、`implements:<entityId>:<interfaceId>`（紫色虚线 = 实现接口）、
    `interface-link:<interfaceId>:<relationId>`（青绿色实线 = 接口承接的关系）。后两类是画布算出来的，草稿里没有对应记录，
    用 `src/lib/ontology/canvas.ts` 的 `parseImplementationEdgeId` / `parseInterfaceLinkEdgeId` 翻回"能编辑的东西"：
    虚线选中接口、青绿线选中它承接的那条关系类型。**不许直接把这种合成 id 当关系类型 id 塞进选中态**（右栏会一片空白）。
  - 关系类型右栏里，若端点落在某个接口的影子上（`promotedFromEntityTypeId`），要写清"这条关系类型由接口「X」承接"并给一个
    「编辑接口」按钮（`setEditingInterface`），就地弹出接口对话框；**不要只留一句"去接口标签里改"**。
  - 单测：`tests/lib/ontology-canvas.test.ts`（id 解析）。改画布连线渲染时跑它，并在 `pnpm dev` 上把三类线各点一遍。
- **「界面」包括会显示给用户的消息**：校验结果、发布拦截原因、导入提醒、`notify()` / `throw new Error()` 里的文案。
  这些和按钮、标题一样按界面算，一律写「对象类型」。代码注释、测试名、内部变量名不受此限。
- 自查办法（提交前跑一遍，只应剩下"这类问题""这几类关系"这种普通汉语）：
  `rg -n "类「|新增类|类清单|起始类|终止类|该类的|这个类的" src`（剩下的命中应该只在代码注释或测试名里）

记录时间：2026-09-13。界面上的并列名词是 **对象类型 · 对象 · 关系类型 · 关系 · 动作**：

| 主术语 | 同义写法 / 出处 | 代码里的名字 | 含义 |
| --- | --- | --- | --- |
| 对象类型 | 口语简称「类」；Palantir 的 Object Type | `entityTypes` | 一组对象的定义：属性、主键、展示属性、实现的接口、数据来源 |
| 对象 | 实例；Palantir 的 Object / object instance | 图里的节点 | 类的一个具体实例，例如「张三」 |
| 关系类型 | 链接类型；Palantir 的 Link Type | `relationshipTypes` | 两个对象类型之间的关系的定义 |
| 关系 | 链接；Palantir 的 Link | 图里的边 | 两个具体对象之间的一条关系 |
| 动作 | 行动；Palantir 的 Action Type | `actionTypes` | 定义在某个类上的一组写操作 |
| 规则 | Palantir 的 submission criteria | `rules` | 挂在动作上的拦截与提示 |
| 数据资源 | 数据源；Palantir 的 datasource | `data_sources` | 业务数据在哪（Oracle / PostgreSQL / …）；与「本体存储」是两件事 |
| 本体存储 | 图数据库连接 | `graph_targets` | 本体（实例层）存在哪个图库里 |

两点提醒：

1. `entityTypes` 这个字段名是历史原因，读代码时一律理解成「类」，不要因为它叫 entity 就把它当成「实体」另一个概念。
2. 「对象类型」不等于「标签」。它在 Jena 里落成 `rdf:type` 的宾语，那只是它在图库里的形态；
   它本身是带属性、主键、实现的接口与数据来源的定义（见「本体核心模型」一节）。

**类之间没有父子继承**（2026-09-16 起，用户要求「暂时不需要这个功能和概念，可以删掉，后面只用接口」）：
`entityTypes[].parents`、`src/lib/class-hierarchy.ts`、`mergeInheritedProperties` 已全部删除，
界面上「父类（继承）」那一块也没了（`type-edit-dialog.tsx` 的编辑弹窗、可视化画布右栏、`ontology-builder.tsx` 一起改）。
**平台里的抽象机制只有一种：接口（`interfaces` + `entityTypes[].implements`）。**
要表达「这几种类型能被同一套应用按同一个形状消费」，就让它们都实现同一个接口 ——
不要再引入第二种抽象，也不要把它说成「父类 / 继承」（那是被删掉的概念，写了就是错的）。
`rdfs:subClassOf` 现在只剩两个用途：对象类型实现接口、接口继承接口。

## 验证约定
- 日常验证统一使用 `pnpm dev` 启动开发服务，在开发服务上进行页面与交互测试。
- 不运行 `pnpm build`；只有明确要求时才执行生产构建验证。

**和容器构建的关系**：上面这条约束的是"日常验证"，不是镜像构建。`docker compose up -d --build`
里的 `pnpm build` 是镜像构建的一部分（Dockerfile 的 builder 阶段），该跑就跑。

## 「本体建模」页的标签结构

记录时间：2026-09-16。**用户要求去掉「表单」标签**（原话："不要表单了，藏的太深了，直接把对象类型，和关系类型放到
表单的位置，替代表单"）—— 原来「对象类型 / 关系类型」是「表单」标签下的**二级**标签，要先点「表单」再点它们。

现在是一级标签一排，顺序固定：

```
可视化建模 · 概念分组 N · 对象类型 N · 关系类型 N · 接口 N · 指标 N
```

- **可视化建模放首位**（2026-09-16 用户补充确认），是默认档：`mode` 初始值 `"visual"`。
- `functional-workbench.tsx` 里的 `mode` 只有 `"visual" | "groups" | "entities" | "relations" | "interfaces" | "metrics"` 六档，
  每档一个组件：`OntologyBuilder` / `ConceptGroupManager` / 对象类型清单 / 关系类型清单 / `InterfaceManager` / `MetricManager`（2026-10-08 加最后一档）。
  旧的 `tab` / `switchTab` 二级状态与那个内嵌的 `graph-view-switcher` 已删掉，别再往回加。
- 后两档（对象类型 / 关系类型）是**清单 + 新增表单**两块，和原来「表单」标签里的内容一致，只是入口提上来了。
- 每个标签的副标题（那行 `.subtle`）按档位各写一句，别再写成"请先在下方切换到…"。
- 术语按上面的约定：标签写「对象类型」「关系类型」，不写「类」。

## 指标（Metric）与列画像（2026-10-08）

用户口径：「指标层也做」「列画像 … 只对被对象类型绑定的表、只对低基数列、按天缓存，这个也要做」。
两件事都是为了把**口径**从列注释里搬到定义层：模型答统计类问题时不必再一轮轮手写 GROUP BY 去探。

**指标 = 业务口径**（对齐 Palantir 的 Metric）：说清「这个数怎么算」——作用在哪个对象类型、按哪个属性怎么聚合、
固定过滤是什么、能按哪些维度分组、单位是什么。它**只描述口径，不是查询结果**；出数仍由模型落成只读 SQL。

- 定义与校验：`ontology.ts` 的 `metricSchema` / `metrics`（加这一项之前的老快照读出来是空数组）；
  发布前检查在 `src/lib/ontology/metrics.ts`（重名、作用类型不存在、聚合/过滤/维度/时间维度指向不存在的属性 → **挡发布**；
  没选作用类型、`SUM/AVG/MIN/MAX` 用在非数值属性 → WARN），由 `validateVersionSnapshot` 统一收口。
- 界面：`metric-manager.tsx`（左清单 + 右口径表单，与概念分组同一套 `manager-grid` + `split-pane` 骨架），
  标签排在「接口」之后（见上面「本体建模」页的标签结构）。`Definition` 多了 `metrics` 字段，`emptyDefinition` 要带上 `metrics: []`。
- 工具：`list_metrics`；`get_object_type` 的 `metrics`、prompt 概念清单里的「指标：…」一行也都要有 ——
  只加定义不加这两处，模型看不到指标就还会去猜口径。加/改工具名必须同步 `mcp.ts` 的 `TOOL_GROUP` / `TOOL_TITLES`。
- 出包：bundle 的 `definition.metrics[]`（格式见 `skills/ontology-bundle/references/bundle-format.md` 的 2.7）；
  blueprint 里 `metrics[].scope` 写**对象类型名**、`property` / `filters[].property` / `dimensions[]` 写**该类型的属性名**，
  由 `build-bundle.mjs` 翻成 id 并当场校验（`index(metrics, "指标")` 那一步负责发 id，漏了就整包空 id 报错）。
  `skills.test.ts` 的 token 列表里有 `metrics`，改了 schema 忘了改文档会直接红。
- 证据：`ReasoningEvidence.kind` 多了 `"METRIC"`，qa-studio 的「依据」那一行要把它算进概念类。

**列画像的成本红线**（`src/lib/datasource/column-profile.ts`，别改成精确统计）：只对**被对象类型绑定的表**做（`mappedColumnsFor`，
没绑定的表返回空 → 调用方跳过）；只**采样**前 1000 行（`ROWNUM <= 1000` / `LIMIT`），不做全表 `COUNT(DISTINCT)`；
采样里取值种数超过 50 的列按高基数列处理（不存取值）；写进 `column_profiles` 表（迁移 0003）后**按天复用**，
只有 `get_table_ddl` 带 `refresh: true`（或过期）才回源库重采。返回里必须如实写 `cached` / `sample_size` / 采样说明。

**`search_schema` v2**（2026-10-08，用户口径「默认可以大一点」）：默认 20 条、上限 50；
入参多了 `kinds` / `object_type` / `include_values`（`limit` 是 `max_concepts` 的别名）。每条命中有 `matched`
（`name` / `value` / `description` / `fallback`）与落点 `bound_table` / `source_column` / `object_type`。
检索面包括属性说明、接口说明、指标说明；**取值命中单独一档**（45 分，来自列画像），描述命中 30，
名字命中（100 / 70）不再叠加后两档；不传 `kinds` 时对象类型 / 指标 / 关系类型保底占一半名额（`applyTypeQuota`）。
改打分必须跑 `tests/lib/reasoning/tools.test.ts` —— 那里有旧断言钉着"名字命中不许回归"。
`search_schema` 的返回里还有一句「表只能通过对象类型到达」，别删（那是在挡模型退回枚举数据源表）。

**工具结果留存上限**：`steps[].result` 既是界面展开时看到的返回，也是**下一轮回放给模型的 tool-result**
（`history.ts` 的 `turnUIMessages` 直接用 `step.result`）。所以 `agent.ts` 的 `truncateForHistory` 放到 60k
并写明"原长多少、截到哪里"。以前截在 8000，模型会看到半截 `get_object_type`（66 个属性约 1.7 万字符），
然后在追问里说"某个字段没返回"。**别再单独在展示层截一刀** —— 两者共用这一份。

**跨表统计的三个补充（2026-10-08 晚，用户口径「补」）**：

- **关系类型的数量关系** `relationshipTypes[].cardinality`（`ONE_TO_ONE` / `ONE_TO_MANY` / `MANY_TO_ONE` / `MANY_TO_MANY`，
  空串 = 未标注，老快照读出来是空串）。说的是**起点端 → 终点端**，只回答"走一次会放大几倍"
  （一个客户 141 条专线，按客户聚合会重复计数）。**它不是正向/反向名字** —— "关系类型双向、不配正反向名字"的口径不变，
  别把它写成「正向基数/反向基数」两栏。纯逻辑在 `src/lib/ontology/relationship-cardinality.ts`（有单测），
  工具侧 `get_object_type` 的入边要 `reversed` 翻过来说（`cardinality_from_here`），改这里必须跑
  `tests/lib/reasoning/tools.test.ts` 的「数量关系」一组用例。bkn 导入没有这个字段，导入后是"未标注"。
- **`get_table_ddl` 的反向引用** `bound_object_types`：这张表被哪些对象类型绑定、各映射了哪几列、是主来源还是补充来源。
  纯函数 `objectTypesBoundTo`（零成本，不连库）。没绑定时返回空 + 一句"表只能通过对象类型到达，先确认表名" ——
  这是模型排查"表名写错了"的唯一线索，别删。用户明确否决过 `list_tables`，这个反向引用是它的替代。
- **`run_sql` / `get_table_ddl` 的 `elapsed_ms`**：让模型知道哪次查询贵、下次要不要合并成一条 CTE。
  `run_sql` 的工具说明里也写了"一次调用可以带多个 CTE"。没做 `scanned_rows`（Oracle 要 `EXPLAIN`，不稳）与结果缓存。

## 工具开关按本体分 + MCP 的两个地址（2026-10-08）

用户先问「工具的开关配置会根据不同的本体而不同吗」（当时是**平台级一份**），确认后要求「要做」；
紧接着指出「MCP 配置没区分这是哪个本体的，因为不同的本体，mcp 工具查的内容也不同」—— 两件一起做了。

### 工具开关：两层，覆盖优先

- 存储：`platform_settings` 表两行 —— 全局默认 `reasoning.toolPolicy`；本体覆盖 `reasoning.toolPolicy:<ontologyId>`。
- 规则（`resolveToolPolicy`，纯函数有单测）：**有覆盖行就按覆盖**（哪怕覆盖写的是空列表，也代表"这个本体明确什么都不关"），
  没有就跟着全局默认，两层都没有 = 全开。**别把"覆盖为空"当成"没配"**回落到全局。
- 读的地方必须带本体 id，否则就退化成全局：智能问答两处（`/api/reasoning/stream` 用 `scope.ontologyId`、
  `/api/reasoning/run` 用 `getOntologyByTargetId(target.id)`）、MCP 两处（见下）。
- 接口：`GET/PUT /api/reasoning/tools`（带 `ontologyId` = 改本体覆盖；带 `reset: true` = 撤销覆盖回到跟随全局）、
  `GET /api/mcp/info?ontologyId=`（回 `disabledTools` + `toolPolicySource` + `globalDisabledTools` + `overrideDisabledTools`）。
  界面（`mcp-studio.tsx`）据此显示「跟随全局默认 / 本体 X 单独配置」并给「跟随全局」按钮。
- 界面的 `ontologyId` 是**当前选中的本体**（由 `functional-workbench` 传进来）。以前它取的是 `ontologies[0]`
  ——多本体平台下会指向第一个本体，2026-10-08 一起修了。
- **能开关的工具名单在 `togglableToolNames()`**：`REASONING_TOOLS` 与 `MCP_ONLY_TOOLS`（只活在 MCP 目录里的
  `list_ontologies`）**两份都要算**。2026-10-08 用户报「这个 tool 为什么关不了」就是漏了后者 ——
  界面把名字发上来、`normalizeToolPolicy` 当脏数据丢掉、开关自己弹回去。
  同一个坑还有第二处：`callMcpTool` 的开关判定必须在 `list_ontologies` 那个分支**之前**，
  否则 `tools/list` 里没了、`tools/call` 照样能调。

### 访问令牌：界面上生成 / 查看 / 撤销，而且可以有多条（2026-10-08）

用户两个口径连着来：「mcp 接入的 token 现在只能通过配置文件进行配置，不行的，要实现，可以在这个界面生成，
也要支持查看和撤销」→ 做完之后立刻追加「token 应该能生成多个，可以管理 token，而不是现在的一个」。

- **多条是硬要求，别退回单条**：换个客户端、换台机器各配一条，撤销哪条只断哪条；
  只有一条的话"重新生成"就等于把所有人踢下线。
- 存储：`platform_settings` 一行 `mcp.apiTokens`，值是 `{ tokens: [{ id, name, ciphertext, createdAt, createdBy }] }`。
  密文用 `@/lib/framework/crypto` 的 AES-256-GCM（**和数据资源凭据同一把 `TARGET_ENCRYPTION_KEY`**，不引第二套密钥管理）。
  实现在 `src/lib/mcp/token.ts`：`listMcpTokens` / `revealMcpToken` / `createMcpToken` / `revokeMcpToken` / `verifyMcpToken`。
- **`.env.local` 的 `MCP_API_TOKEN` 还认**，作为清单里一条**只读**的兜底（`id: "env"`，撤销按钮禁掉）。
  取值来源对客户端透明，`/api/mcp/token` 的 `DELETE ?id=env` 会明确回一句"只能改配置文件"。
- 校验：`verifyMcpToken` **逐条恒定时间比较**（`timingSafeEqual`，别写 `===`），平台清单与环境变量那条都算数；
  返回 `configured` 让端点区分"令牌错"与"根本没配"。`mcp-endpoint.ts` 的 `authorization()` 只调它，别在那儿读 env。
- 接口：`GET /api/mcp/token`（清单，**不含明文**）、`GET ?reveal=<id>`（单条明文）、`POST { name }`（生成，明文只回这一次）、
  `DELETE ?id=<id>`（撤销）。**只有 ADMIN 能调**；`/api/mcp/info` 只回清单 + `canManage`，不回明文。
- 界面：`mcp-studio.tsx` 里只留**一行摘要 + 「管理令牌」按钮**，清单与明文在专用弹窗
  `src/components/mcp-token-dialog.tsx`（配 `mcp-token-dialog.css`）。用户口径：「访问令牌的管理可以专门弹出来一个界面进行管理」——
  令牌会越攒越多，别再铺回页面上。弹窗把 `(tokens, revealedToken)` 回传给页面，
  页面据此更新摘要，并把**刚查看的那条**写进接入配置片段（片段只能带一个令牌）。

### MCP：平台级 + 本体级两个地址

- 协议实现只有一份：`src/lib/reasoning/mcp-endpoint.ts`（`handleMcpRequest`）。两个路由都是薄壳：
  `src/app/api/mcp/route.ts`（平台级）与 `src/app/api/mcp/[ontologyId]/route.ts`（本体级）。
  **不要再复制一份协议实现**。
- **平台级** `/api/mcp`：一个端点覆盖所有本体。`tools/list` 按**全局默认**过滤（客户端连接时还没有本体上下文），
  `tools/call` 按**参数里的 `ontology_id`** 取那个本体生效的策略；没带 id 就退回全局。
- **本体级** `/api/mcp/<ontologyId>`：`tools/list` 按**这个本体**的策略过滤；`tools/call`
  **强制注入** `ontology_id`（客户端传了别的也以 URL 为准，`applyPinnedOntology` 有单测）；
  `initialize` 的 instructions 里写明绑定的本体名与 id。本体不存在 → 404 + 一句"到 MCP 调试页复制地址"。
- 路径段与静态路由 `/api/mcp/info` 并存：Next 优先匹配静态段，本体 id 是 UUID，不会撞。
- 界面「MCP 接入」档有一个作用域切换：**默认「当前本体」**（配置片段带上 `/api/mcp/<id>`，服务名带 id 前缀），
  也可以切到「平台级（全部本体）」。调试页的「运行」走的就是当前选中的那条地址（响应里会打出 `POST <路径>`）。

## 本体导入的两条路（2026-10-08）

用户口径：「前面已经导入过这个数据了，当时导入太久，能否实现一个脚本，方便这种格式的导入」。

- **服务端只有一条导入链路**：`POST /api/ontologies/import`（`src/app/api/ontologies/import/route.ts`）。
  它认三种输入：bkn 知识网络（`isBknKnowledgeNetwork` → `fromBknKnowledgeNetwork`）、
  平台自己的 `ontology.bundle`、以及「结构化清单编译出来的包」。转换、换 id、按表名接数据资源、
  写草稿全在这一条链路上 —— **不要给脚本另写一条导入路径**（两条路一定会漂移）。
- **`dryRun: true`**：解析 + 转换 + 绑定 + 统计跑完就返回，**不建本体、不写草稿**，并带
  `counts` / `warnings` / `pendingSources` / `timings`。回答"这个文件里到底有什么、会丢什么"用它，
  别为了看一眼先落一个本体再删。真导入的响应也带 `timings`（解析 / 规划 / 绑定 / 建快照）。
- **`scripts/import-ontology.mjs`**（Node 内置模块、无依赖）：登录 → 挑存储 → 一次请求导入；
  可选 `--dry-run` / `--publish` / `--name` / `--storage-target`，账号可走环境变量。
  两条实现约束别改回去：
  1. **候选存储要排除已被别的本体占用的**（`/api/targets` 与 `/api/ontologies` 一减）——
     每个本体在自己的 `graph_targets` 行上占位，拿别人的存储再导入会撞唯一键；
  2. **不要用 `process.exit()`**：Windows + Node 24 下 fetch 还挂着连接时硬退会撞 libuv 的
     `!(handle->flags & UV_HANDLE_CLOSING)` 断言（进程崩掉、退出码也不对），统一用 `process.exitCode`。
  契约测试在 `tests/lib/import-script.test.ts`（只跑不联网的那几条路径）。
- 实测（2026-10-08）：1MB 的 V5 bkn 文件 `--dry-run` 服务端 **0.05s**（解析 0.01 / 规划 0.01 / 绑定 0.03），
  真导入 **0.09s**（含建快照）。所以"导入很久"从来不是服务端慢 —— 是当时靠对话一步步建类型。

## 功能实现记录（2026-10-08 用户要求）

用户原话：「实现的功能都要记录下来，因为都是 AI 写的，记下来，后面我也知道都实现了什么」。
所以仓库根有一份**给人看的功能账本**：`docs/功能实现记录.md`（README 的目录里有链接）。

- **它记的是"平台有什么功能"，不是修复日志**（2026-10-09 用户口径：「不是所有的修复记录都加进去，
  而是记录平台有什么功能」）。所以：
  - 修 bug **不单独占一条** —— 修完只有"用户看得到的新能力"才写；纯粹的报错修复不进这份文档。
  - 新功能写进**对应的功能分区**（本体模型 / 本体实例 / 智能问答 / MCP 服务 / 数据资源 / 本体技能与出包 /
    平台与交付），别按日期往下堆条目。分区跟左侧导航对齐，读的人照着界面找得到。
  - 已有的能力变了口径，就**改那一条**，不另起一条。
- 每条写清：能做什么 + 入口在哪 + 有什么限制 + 怎么验证。它是"用户视角的功能清单"，不是提交日志，
  别抄 commit message。
- 分工：`git log` 是提交历史，`AGENTS.md`（本文）是工程约定与踩坑，`docs/功能实现记录.md` 是功能账本，
  `docs/adr/` 是架构决策。

## 登录态：`Authorization: Bearer`，不再用 Cookie（2026-10-09）

用户口径：「我感觉还是完全改为 Authorization吧，开始吧」。之前是 HttpOnly 会话 Cookie，换的理由是
**调试与对接**：cookie 方式下 Postman / curl 得先去浏览器里抄 value，跨机器、给同事、写脚本都别扭；
`Authorization: Bearer` 是调 API 的默认姿势。

**这是一次拿安全性换便利的改动，不是纯重构**：cookie 的 httpOnly 是唯一能把凭据从 JS 里藏起来的手段，
换成请求头之后令牌必须由前端自己存（`src/lib/framework/session-token.ts`，localStorage），XSS 能读走它。
取舍已经跟用户确认过；两条缓解手段不许拆：

- 令牌仍是**8 小时过期**的 JWT（`createSession` 的 `setExpirationTime("8h")`）；
- 服务端**每次都回平台库核对用户**（`userFromToken` → `findSessionUser`），删用户 / 改权限立刻生效。

落点：

- **签发**：`POST /api/auth/login` 在**响应体**里回 `token`（不再 `Set-Cookie`）。
- **携带**：`src/lib/framework/session-token.ts` 的 `authHeaders()` / `withAuth()`。所有请求都要带 ——
  `api-client.ts` 与 `graph-canvas` 的 `api()`、流式问答（`qa-studio`）、MCP 调试页、`downloadResponse`。
  **下载那条最容易忘**：它以前靠浏览器自动带 cookie，现在必须显式带头。
- **校验**：`src/lib/platform/auth.ts` 的 `currentUser()` 只读 `Authorization`（`bearerToken()` 解析、
  `userFromToken()` 验签 + 回库）。54 个路由都走 `currentUser()` / `requireRole()`，服务端只改这一处。
- **登出**：`POST /api/auth/logout` 是**空操作**（无状态 JWT），真正登出是前端 `clearSessionToken()`。
- **令牌作废的唯一信号**是 `/api/auth/session` 回 `user: null`（`functional-workbench` 开机检查时清本地那份）。
  **不要**在 `api()` 里见到 401 就清令牌：`requireRole("ADMIN")` 对查看者也是 401，
  那样会把"权限不足"当成"登录过期"，把查看者踢下线。
- **MCP 端点（`/api/mcp`）同一个头上认两套**：平台会话 JWT（带 `SESSION_AUDIENCE` 标记）与 `mcp_…`
  访问令牌。**先试 JWT** —— 令牌不是 JWT 时验签立刻失败、不查库；反过来先试 MCP 令牌则要对清单逐条解密。
- **Swagger `/docs` 的 Try it out 不再自动带凭据**：要手动点 Authorize 粘令牌
  （`PlatformToken` / `McpToken` 两个 scheme 分别对应平台接口与 `/api/mcp`；`persistAuthorization` 已开，粘一次会记住）。
- **命令行导入脚本**的 `--cookie` 已改名 `--token`（环境变量 `ONTOLOGY_TOKEN`）。
- **别把 cookie 兜底加回来**：两种来源并存会让"为什么这个客户端能调、那个不能"变得不可解释。
## 客户端代码约定

**不许直接用"只在安全上下文里存在"的浏览器 API。** 2026-09-14 用户报：用机器 IP 走 http 访问，
一点「本体草稿」整页变成 `This page couldn't load`（控制台是 `crypto.randomUUID is not a function`）——
`crypto.randomUUID` 只在 https 或 localhost 下存在，IP 访问时是 `undefined`，异常被 Next 的错误边界接住。

- `crypto.randomUUID` → 用 `@/lib/framework/ids` 的 `newId()`（优先原生，其次 `getRandomValues` 自己拼 v4，
  最差退回时间戳 + 随机数）。`resolveGroup` / `planBundleImport` 这类可注入生成器的函数，默认值也用它。
- `navigator.clipboard` → 用 `mcp-studio.tsx` 里那种"先 Clipboard API、失败退隐藏 textarea + execCommand"的写法。
- 同类还有 `crypto.subtle`、`navigator.geolocation`、`Notification`、Service Worker：都需要安全上下文。

**这些 API 在 https 与 localhost 下都在，所以只在本机用 `localhost` 测是查不出来的** ——
界面改动要在两个入口各过一遍：`http://localhost:<port>` 与 `http://<机器 IP>:<port>`。

**dev server 要用 IP 访问，必须先放开 `allowedDevOrigins`**（2026-09-16 补）。Next 的 dev server 默认只认
`localhost`：用机器 IP / 主机名打开时，跨来源的 `/_next/*` 与 `__nextjs` 请求被拦（HMR websocket 报
`ERR_INVALID_HTTP_RESPONSE`），页面**永远停在「正在加载 Ontology...」**，而且没有任何 4xx 响应、没有任何控制台报错
——只看网络面板会以为"没请求"。`next.config.ts` 现在写着
`allowedDevOrigins: ["127.*.*.*", "192.168.*.*", "10.*.*.*", "172.*.*.*", "*.lan", "*.local"]`，改完要重启 dev server。
实测 `http://localhost:<port>`、`http://127.0.0.1:<port>`、`http://<内网 IP>:<port>` 三个入口都能进；
**裸主机名（`http://<计算机名>:<port>`）仍会被拦** —— 它不在白名单里，要测就临时把机器名加进去。
生产构建（`next build` / Docker 里的 `next start`）不读这一项，不受影响。

**浏览器扩展注进来的属性不算我们的 bug**（2026-09-19）。用户报的 hydration 报错是
`<html>` 上多出 `data-immersive-translate-page-theme="light"`，来源是**沉浸式翻译**扩展在客户端改 DOM，
不是 SSR/CSR 分支写错。处理办法就是在 `src/app/layout.tsx` 的 `<html>` 上加 `suppressHydrationWarning`
（React 专用 prop，**不会渲染成 HTML 属性**，所以看服务端返回的 HTML 是看不出区别的）。
再见到 html/body 上被扩展加属性的报错，先看属性名认不认得出扩展，别去翻组件。

## 权限模型（RBAC，2026-10-09）

用户先问「现在系统没有 RBAC 是吗」，确认后说「做 1，2 吧」（用户管理 + 角色与权限）。
授权从「一列 `users.role`（ADMIN / VIEWER）+ 70 处 `requireRole()`」换成**13 个权限点 + 角色**。

### 模型

- 权限点是**代码里的常量**：`src/lib/platform/permissions.ts` 的 `PERMISSIONS`（13 个，按模块分组）。
  新增一个点必须同时有 `requirePermission` 在用它，否则是给人看的摆设。
- 角色 = 一组权限点，存在 `roles` 表（迁移 0004）。**内置三档**：管理员 / 编辑者 / 查看者，
  由 `BUILTIN_ROLES` 定义并**每次启动同步进库** —— 以后加权限点，`admin` 自动拿到，不用另写数据迁移。
- **`admin` 永远是全部权限**：`effectivePermissions(roleId, stored)` 对 `admin` 直接短路成 `ALL_PERMISSIONS`，
  不看库里那一行（用户口径：「admin 用户是拥有所有权限的」）。迁移没跑、那行被人手改坏，都锁不死管理员。
- `users` 挂 `role_id`（外键 RESTRICT）+ `disabled_at`；老 `role` 列按用户要求**直接删掉**，代码里不再有它。

### 守卫

- `requirePermission(code)`（`src/lib/platform/auth.ts`）：未登录 401，登录了没权限 **403**。
  `apiErrorStatus(error)` 把三种情况映成 401 / 403 / 原状态码 —— **路由的 catch 里别写死 `{ status: 400 }`**：
  2026-10-09 全库收口了 31 处，在那之前"权限不足"会显示成 400（文案对、状态码错）。
- 74 处 `requireRole` 逐个映射成了权限点，映射表现在就是每处 `requirePermission("…")`。几条容易记错的：
  发布 / 校验 / 激活历史版本 / **清空与重置图数据** / 删除本体 → `ontology.publish`；
  跑动作、建改对象与关系、重建检索索引、取进草稿 → `instance.write`；
  导出本体与下载技能 → `ontology.read`；`PUT /api/reasoning/tools`（工具开关）→ `mcp.token.manage`
  （工具开关和 MCP 令牌都是"对外暴露哪些能力"，归同一档治理动作，没有为它单开第 14 个点）。

### 防漏改的安全网（别删）

`tests/lib/authz-coverage.test.ts` 扫 `src/app/api/**/route.ts`：

1. 每个非公开路由都必须有 `requirePermission(` / `requireUser(`；
2. 代码里出现的权限点必须都在 `PERMISSIONS` 里（拼错当场红）；
3. 内置角色的权限点也必须存在；
4. 三条边界：管理员全权、编辑者不能管用户/令牌/图引擎、查看者只读。

公开路由白名单与"自守卫"白名单（MCP 端点自己认双凭据）都在那个测试里，**往里加白名单要慎重**。
2026-10-09 它当场抓到 `/api/query` 用的是手写 `currentUser()` 判断。

### 用户管理

- 接口：`/api/users`、`/api/users/:id`（改角色 / 重置密码 / 停用 / **真删**）、
  `/api/roles`、`/api/roles/:id`、`POST /api/auth/password`（改自己的密码，不占 `users.manage`）。
- **删除是真删**，所以指向 `users` 的 4 条外键改成了 `ON DELETE SET NULL`（那几列本来就可空）。
  代价说清楚：删掉一个人，他历史的审计记录会保留、但"操作人"变空 —— 所以路由额外写一条
  `USER_DELETED` 审计，里面带邮箱，人名还追得回来。
- **最后一个能管用户的账号**不许降级 / 停用 / 删除（`countActiveManagers`），否则平台当场锁死。
- 建号时管理员直接给初始密码；**不做首登强制改密、不做密码强度策略**（用户明确要求）。

### 踩过的坑：迁移必须幂等

迁移 0004 第一版把"按老 `role` 列回填 `role_id`"的 UPDATE 写在无条件路径上。第一次跑没问题，
**第二次启动就炸**：`role` 列已经删了，那句 UPDATE 直接 `column "role" does not exist`，
而这抛在建库阶段 —— 表现是整个平台 500、**连登录都进不去**（2026-10-09 用户报「登不上了」）。
规矩：`PLATFORM_MIGRATIONS` 每支**每次启动都会跑**，数据回填、删列这类操作必须挂在
"那一列还在不在"的检查上（`hasColumn`）。
## 「还没读到」不等于「是空的」（2026-10-09）

2026-10-09 用户报「点进『对象』立马弹出一个红色的东西然后很快消失」。不是请求失败，
是**首帧的假告警**：`EntityManager` 里"本机已登记的数据资源 id"初值写成了 `useState<string[]>([])`，
而 `brokenSourcesOf(definition, knownSourceIds)` 判的是"这个 `dataSourceId` 在不在已知清单里" ——
清单还是空的时候，52 个对象类型里那 42 个**已经绑好**的来源全被判成"没绑"，
于是渲染出一句"42 个来源还没绑到数据资源…"；`/api/data-sources` 一回来填上真名单，告警又自己消失。

规矩：**参照另一份清单才算得出的判断，先分清「清单还没回来」和「清单是空的」**。

- 用 `T | null` 表示"还没读到"，`null` 时**不要下判断**（`sourceIds` 改成 `string[] | null`，
  `brokenSources = version && sourceIds ? … : []`）。
- 只有**读到了的空数组**才代表"确实一个都没有" —— `[]` 在 JS 里是真值，判断照跑，
  所以真正的"资源被删了"仍然会报，语义一点没弱。
- 反过来也成立：拉清单失败时保持 `null`（宁可少提示一次），不要用 `[]` 去顶 —— 那会报一条"全都绑飞了"的假警。
- 这类 bug 只在**首帧**出现，`pnpm dev` 上手动点是能看到的，但抓证据要靠 `MutationObserver`
  盯 `.notice.error` 的插入/移除（先塞一个假节点确认观察器确实会记录，再判"没记录"）。

## 本体技能（AI Skills 构建）

记录时间：2026-09-16。用户要求「参考 bkn-foundry（后端）与 bkn-studio（前端），实现一套构建本体的 skill
在本系统中，方便用户使用，最好是直接生成 json 的，这样方便导入」。对标 bkn-studio 首页的「AI Skills 构建」
（编号技能 + 适用场景 + 主要产物 + 「获取 Skills」弹窗），**但技能内容就在本平台里**，不指向外部仓库。

技能是什么：一组 Markdown，教 Agent "怎么按本平台的规范建模、怎么出包"。
三条链路 —— 需求澄清（`ontology-requirement`）→ 本体设计（`ontology-builder`）→ 出包交付（`ontology-bundle`）；
最终产物是**平台能直接导入的本体包 JSON**（`format: ontology.bundle`）。
技能可以整套下载成 zip，解压进 `~/.codex/skills/` 或 `~/.agents/skills/` 就能用。

- 文件在仓库根 `skills/`：**是数据不是源码**。`skills/README.md` + 三个技能目录，每个目录一个
  `SKILL.md`（带 `name` / `description` front-matter）与 `references/`（格式说明、示例包、建模细则）。
- **交付契约就是平台自己的本体包格式**，所以文档与示例必须跟着 schema 走：`skills.test.ts` 会
  拿 `ontology-bundle/references/example.bundle.json` 跑
  `readOntologyBundle` → `planBundleImport` → `validateVersionSnapshot`，要求**零违规**（连 WARN 都不能有），
  并断言 `bundle-format.md` 里出现关键字段名与枚举。**改 `ontology.ts` 的 schema 就要同步改文档与示例**，
  否则测试直接红 —— 这是防止"技能教的格式平台不认"的唯一机制。
- 服务端 `src/lib/skills/index.ts`：目录扫描、front-matter 解析（借 `@/lib/framework/markdown`）、
  `resolveSkillFile` 防目录穿越（`..` / 绝对路径 / 越界一律 null）。接口只有两个：
  `GET /api/skills`（清单 + 文件表）与 `GET /api/skills/archive`（**全部技能**打成一个 zip）。
  `SKILL_CATALOG` 只放界面文案（编号 / 场景 / 产物 / 图标），**正文一律读盘**，别抄进代码。
  **按套下载已于 2026-09-17 全部删掉**（用户原话："不要支持一个一个下载，要只支持整体下载"）：
  `GET /api/skills/:id`（正文全文）、`GET /api/skills/:id/file`（单文件）、`GET /api/skills/:id/archive`（单套 zip）
  都没了，`src/lib/skills/index.ts` 里也只剩 `readSkillsArchive()` 一个打包入口。
  要正文就下整包 —— 别再为"按套下载 / 预览原文"把这些口子加回来。
- 打包用 `src/lib/framework/zip.ts`：自己实现的 store + deflate 子集（UTF-8 文件名、无 zip64）。
  验证方式是实测：单测比对 CRC32 与 zip 结构，端到端用 `Expand-Archive` 解一次（2026-09-16 验过）。
- 界面 `src/components/skill-studio.tsx`（侧栏「语义模型 → 本体技能」）：**只给清单，正文不进页面**
  （2026-09-17 用户要求"太不简洁了…不需要看到细节，想看整体下载下来看就行"）。
  一行一套技能：编号 + 图标 + 「〈名称〉 Skill：〈技能名〉」+ 两列 `适用场景` / `主要产物`。
  顶部只有一个「获取 Skills」按钮；弹窗里**只列三套技能做说明**（名称 / 技能名 / 适用场景，行内不带按钮），
  底部一个「下载全部 Skills (.zip)」；**弹窗里不要出现示例包**（用户明确说"这里不用看示例"）——
  示例本体包在 `ontology-bundle/references/` 里随整包一起下发。
  **不要把技能正文、文件页签、复制按钮、按套下载搬回页面或弹窗** —— 要那些就整体下载。
- **Dockerfile 的 runner 必须 `COPY --from=builder /app/skills ./skills`**（2026-09-16 已加）：
  技能是运行时读盘的数据，不拷进镜像这一页就是空的；`.dockerignore` 也别把 `skills` 挡掉。
- 顺带抽出来的共用件（别再各写一份）：
  - `src/lib/framework/markdown.ts`：front-matter 解析 / 剥离（纯函数，客户端也要用）。
  - `src/components/markdown-view.tsx`：Markdown 渲染器，问答页（`qa-markdown`）与技能页共用，
    支持围栏代码块与 `- [ ]` 清单；自研而非引库（只渲染我们自己产出的文本）。
  - `src/lib/framework/clipboard.ts`：`copyText`（Clipboard API + execCommand 兜底）与 `downloadResponse`
    （Blob 下载、读 `Content-Disposition` 文件名）—— MCP 页复制、本体导出、技能下载共用同一份。

### 技能同时发布为 MCP（免令牌，2026-09-18）

用户要求：「本体技能这里，现在是让用户下载 skills 自己配置，请继续实现，直接发布为一个 mcp 的方式，
且这个 mcp 不需要 token 就可以访问」；随后补充口径「就是 skill 和 mcp 都支持的那种」——
**下载与 MCP 两条路都留**，不是二选一。别把 `/api/skills/archive` 关掉。

**平台里现在有两个 MCP 服务端，职责与鉴权都不同，别混：**

| | `/api/mcp` | `/api/skills/mcp`（本次新增） |
| --- | --- | --- |
| 发什么 | 本体数据（对象类型 / 关系类型 / 动作…） | 建模方法（三套技能的 Markdown） |
| 鉴权 | 平台会话 或 `Bearer <MCP_API_TOKEN>` | **无**（免令牌） |
| 实现 | `reasoning/mcp.ts` + `reasoning/tools.ts` | `skills-mcp.ts` |

- **免令牌的依据**：技能是随仓库下发的公开文档，读的只是 `skills/` 目录里的文件，不含凭据、不碰数据库。
  代价是**技能里永远不许出现凭据**（那是这个端点能不鉴权的前提）。
- 能力：`tools`（`list_ontology_build_skills` / `get_ontology_build_skill` / `get_ontology_build_skill_file`）
  + `prompts`（每套技能一条，客户端里就是斜杠命令；正文就是它的 `SKILL.md`，放在 **user 消息**里 ——
  斜杠命令的语义是"把这段说明当我这一轮的输入"）。`list_ontology_build_skills` **只给清单不带正文**
  （正文单独用 `get_ontology_build_skill` 取，别让一次往返背上几百 KB）。
- **工具名与说明怎么定**（2026-09-18 用户口径：「这些 mcp tools 的名字不太好，agent 不知道它们的干什么的，
  别人配置了都不知道是干什么的」+「mcp 和 skills 要有区别，tools 要让模型一下知道是干什么用的，怎么用，
  用它的输入是什么，产出是什么」）。客户端会把**两个 MCP 服务端的工具摊在同一张表里**，所以：
  - **名字必须自带 `ontology_build_skill`**：既说清"这是本体**构建技能**"，又与查本体数据那个服务端的
    `list_ontologies` / `get_object_type` / `search_schema` 一眼分得开。别退回 `list_skills` / `get_skill`
    这种光看名字不知道是谁家的短名（`skills.test.ts` 有两条用例钉着这一点）。
  - **`description` 按「用途：… 输入：… 产出：… 怎么用：…」写**，把"拿到结果之后下一步调谁"也写进去，
    模型不点开 inputSchema 就知道怎么用。工具名、`title`、说明都改在 `src/lib/skills/index/mcp.ts` 一处，
    界面上的工具卡片与 `/api/skills` 返回的 `mcp.tools` 自动跟着变。
- 代码分工：`src/lib/skills/index/mcp.ts` 写"提供什么"（工具与提示词定义 + 执行，纯函数级、可单测）；
  `src/app/api/skills/mcp/route.ts` 写协议面（`initialize` / `ping` / `tools/*` / `prompts/*`、通知回 202、
  GET 回 405、CORS `*`）；正文一律走 `@/lib/skills/index`，这里只写协议文案。
- **`src/lib/mcp/protocol.ts` 是特意抽出来的**：协议版本两个服务端共用一份。技能 MCP 若 import
  `@/lib/reasoning/mcp`，会连带把 Jena / oracledb / pg 的驱动拉进一个公开端点；实测不加载时
  `/api/skills/mcp` 单次调用 ~13ms。改协议版本只改这一个文件（`reasoning/mcp.ts` 原样再导出，路由不用动）。
- `GET /api/skills` 多返回一段 `mcp`（`absoluteUrl` / `protocolVersion` / `transport` / `tools`），
  界面据此渲染，不必再开一个 info 接口。
- 界面 `skill-studio.tsx`：**顶部两档切换器**（`技能清单 N` / `MCP 接入`），用 `globals.css` 的
  `.view-switcher`（`aria-pressed` + `active`），页头与副标题常驻、副标题跟着档位走。
  2026-09-18 用户口径：「放下面不好，页面太长了，直接做成可切换的页面」—— **别再往同一列里堆叠**。
  MCP 那一档是：地址 + 复制、协议 / 服务名 / 工具数、三个工具说明，以及三段可复制配置 ——
  **顺序是「通用 mcp.json / Claude Code / Cursor」，且默认选中「通用 mcp.json」**
  （2026-09-18 用户要求："默认是通用 mcp.json，并且要放到前面"；它是各客户端共用的那一段）。
  **配置里故意不带 `Authorization` 头** —— 服务端不校验令牌，写上去反而让人以为要申请 token。
  弹窗改成"两条路"的说明，**「下载全部 Skills (.zip)」保留**。
- **`mcp-studio.tsx`（MCP 调试）也是两档**（2026-09-18 用户口径：「上面的 MCP 配置的信息也参照本体技能那里
  一样可以切换，默认看的是工具的页面，而且 MCP 配置那里，默认是通用 mcp.json」）：
  1. **工具（默认）**：左边工具清单 + 右边被选中那个的说明 / 参数 / 请求体 / 响应；
  2. **MCP 接入**：服务地址 + 三段配置片段，**默认选中「通用 mcp.json」**（与技能页同一口径，
     `connectTabs` 里它就是第一项，`connectTab` 初始值也是 `generic`）。
  接入配置原来常驻在工具清单上面，页面太长 —— 别再挪回去。
- **分档切换器只有一份样式**：`globals.css` 的 `.view-switcher`。以前「本体草稿」用
  `graph-view-switcher`、技能页抄了一份 `sk-switcher`，2026-09-18 收到一处（`.sk-switcher` 已删）。
  **再加页面就用 `.view-switcher`，别抄第三份。**
- **MCP 地址必须跟着前端 URL 变**（2026-09-18 用户报的：「不能只是 localhost，要根据前端 url 变化才对」）。
  两端各一层，缺一层就会在某种部署形态下露出 localhost：
  1. **服务端**：`@/lib/framework/public-origin` 的 `publicOrigin(request)` —— 认 `x-forwarded-host` / `host`
     （只看第一段），协议认 `x-forwarded-proto` / 请求自己的协议，口径与 `sessionCookieSecure` 一致。
     **别用 `request.nextUrl.origin`**：它在 dev 与容器里会落回服务端自己认的 `localhost:port`。
  2. **界面**：拿到数据后再用 `window.location.origin` **覆盖** `absoluteUrl`。端口转发 / 反代会把 Host
     也改写成 localhost，那种情况只有浏览器自己知道真实地址。
  `/api/mcp/info` 与 `/api/skills` 都改了，`mcp-studio.tsx` 与 `skill-studio.tsx` 都覆盖 ——
  **两个 MCP 页别一个对一个错**。单测在 `tests/lib/public-origin.test.ts`。
- 防漂移（`skills.test.ts` 新增 9 条）：工具名与 `skill_id` 枚举、**名字必须带 `ontology_build_skill`
  且不与 `/api/mcp` 的工具重名**、**说明必须含「用途 / 输入 / 产出」且写出下一步调谁**、清单不带正文、
  取参考文件、目录穿越与不存在的技能被挡、prompts 正文来自 SKILL.md；另有两条**直接调 route 的 `POST`**
  （请求里没有 Cookie、也没有 Authorization），钉住"免令牌"与"工具报错走 `result.isError` 而不是 JSON-RPC error"。

## 出包改成「清单 → 编译」（2026-09-18）

用户要求：「让模型只输出**结构化清单**，然后最终由脚本编译生成，而且这个脚本要支持 window/linux/mac 的不同系统。」

背景：让模型直接吐 `ontology.bundle` 的 JSON，最容易错的两件事是**手写 UUID 与 id 引用**（对不上就整包报错）
和**格式漂移**（忘字段、写错枚举）。现在把这两件事从模型手里拿走。

| 谁产出 | 文件 | 内容 |
| --- | --- | --- |
| 模型写 | `<标识>.blueprint.json` | **结构化清单**：引用一律写名字（「客户」），不写 id / UUID / format |
| 脚本编译 | `<标识>.ontology.json` | **本体包**，平台「导入本体包」认的就是它 |

- 脚本在 `skills/ontology-bundle/scripts/`：`build-bundle.mjs`（编译）、`check-bundle.mjs`（手写包的结构自检）。
  **只用 Node 内置模块**（不装依赖、不联网、不读环境变量）；调用一律 `process.execPath` + 脚本路径、**不经过 shell**，
  所以 Windows / Linux / macOS 同一套命令：`node scripts/build-bundle.mjs <清单.json> [--out …] [--check] [--stdout]`。
- 编译器负责：按名字解析引用（解析不了就报错，并**把当前清单里可用的名字列出来**）、生成全部 UUID、
  补齐默认值与 `format` / `formatVersion` / `exportedAt` / `generator` / `statistics`。
  它**不判断建模好坏** —— 那仍是 `ontology-builder/references/modeling-rules.md` 与平台「建模体检」的活；
  它只把几条"到导入才炸"的检查（空壳对象类型、展示属性悬空、主键列没映射、必填属性没映射列、关系端点没选、规则无条件）
  提前报成 `⚠` 提醒，**用体检的同一套规则码**，不挡编译。
- 跟着一起下发的参考：`references/blueprint-format.md`（清单格式与全部枚举）、`references/example.blueprint.json`（可编译的例子）、
  `references/example.bundle.json`（编译产物长什么样，仍是发布前校验零违规的样板）。
- `ontology-builder` 的初稿也从 `*.ontology.json` 改成 `*.blueprint.json`（`SKILL_CATALOG` 里那句界面文案同步改了）。
- 防漂移（都在 `tests/lib/skills.test.ts`）：用**真子进程**跑编译脚本编译示例清单，再把产物走
  `readOntologyBundle → planBundleImport → validateVersionSnapshot` 要求零违规，并断言接口实现也满足契约；
  另有一条用例断言引用写错时退出码为 1、且把可选名字列出来。同一处还把「SKILL.md 里点名的 `references/…`」
  扩成「`references/…` 与 `scripts/…` 都必须真的存在」。
- 边界：平台**只认** `ontology.bundle`；`.blueprint.json` 不是导入格式（拿清单去导入会被 `format` 检查拦下并提示先编译）。
  环境里没有 Node 时退回手写包 + `check-bundle.mjs`。

## 内置类型图与 Jena 并存（2026-09-18）

用户确认：类型图只包含对象类型、关系类型、接口等定义，不把将来海量对象放入内存图；
先新增 JS/TS 内置后端，**保留 Jena/Fuseki 与旧数据**。充分验证后再讨论清理，不得提前删掉 Jena。

- `GraphStore` 仍是统一抽象：`JENA` 和 `EMBEDDED` 两个实现由 `src/lib/framework/graph/index.ts` 分发。
  内置存储入口由代码虚拟提供，不在 `graph_targets` 创建根记录；新建本体默认选它，并为该本体持久化独立的受管目标。入口不能手工创建、编辑、删除、清空或重置，
  但本体仍必须由用户显式新建或导入。`ensureDefaultOntologies` 旧逻辑已移除，不能把资源自动变成本体。
  外部 Jena 连接仍可按需新建；现有目标**不能靠修改 kind 原地切换**（那会把旧目标指向一份空存储）。
  需要迁移时先导出本体包、在新存储上导入并核验；目前本体包只含定义，不带实例数据。
- 正式定义保留在版本快照 `definition.json`，发布的当前图由平台 PostgreSQL 的
  `ontology_platform.embedded_graphs` 原子保存；Graphology 类型图与 N3.js RDF 数据集按请求从当前版本重建，
  Comunica 仅提供只读 SPARQL 查询。内存视图不是第二份事实来源，服务重启后也无需恢复内存状态。
- 为兼容现有手工实例页面，当前发布视图仍可带少量快照节点和关系。这条 JSONB 整行存储**不是**未来海量业务对象方案；
  大量对象须另做对象服务、按业务主键定位并在 PG/业务源按需读取，不能装进 N3.Store 或版本快照。
- Jena 的 SPARQL 工作台、类型传播与发布路径保持原样。内置后端只验证当前实际用到的
  SELECT/ASK/CONSTRUCT/DESCRIBE 和接口传递，不声称 OWL/RDFS 完整蕴含、SHACL 强约束已经可用。
- Docker Compose 只部署平台 `app`；Jena/Fuseki 仍受支持，但作为可选的外部图引擎单独部署。移出编排不删除已有 Jena 本体或 Fuseki 数据。

## 数据资源的结构缓存（2026-09-19）

用户口径：「不用每次点都真查，建议将这部分保存到数据库中……只有手动点击刷新的时候才再次去查」，并明确「完全可以复用 `data_sources` 这张表」。

- 缓存就存在 `ontology_platform.data_sources.catalog`（JSONB，`ADD COLUMN IF NOT EXISTS`，形状
  `{ catalog: { "<范围>": { fetchedAt, objects } }, views: { "<模式.表>@<行数>": { fetchedAt, fields, preview } } }`）。
  **不要另开一张缓存表**，也别把这份数据塞进 `graph_targets` / 版本快照。
- 取数口径：`src/lib/datasource/structure-cache.ts` 的 `cachedStructure()` —— 命中平台库就直接返回，**没有 TTL**；
  只有 `refresh=1`（「刷新结构 / 重新取数」）或库里还没有时才连源库，读完顺手写回。失败时不写缓存。
- 路由：`GET /api/data-sources/:id/views`（清单，按范围分片）与 `.../views/:name?limit=N`（字段 + 样本行，按「模式.表@行数」分片）
  都走这一层，响应里带 `fetched_at` / `from_cache`，界面据此显示"结构存于平台库 / 刚回源重读 · 时间"。
- **改连接信息要作废缓存**（`[sourceId]/route.ts` 的 PATCH 比对 kind/host/port/库/模式/账号/密码后才清）；删资源时随行删除。
- 单测：`tests/lib/data-source/structure-cache.test.ts`（命中不回源、未命中回源并写回、refresh 覆盖、两个桶互不干扰、失败不写）。

## 接口文档（OpenAPI / Swagger UI）（2026-09-19）

用户要求：「现在没有实现自动生成 openapi docs 的功能，类似于 fastapi 的 docs，next.js/ts 有吗」。选了
**next-openapi-gen**（扫代码型：扫 `src/app/api` 下每个 `route.ts`，从路由里的 zod schema 推断请求体），
UI 用 **Swagger UI**（就是 FastAPI 默认那套，自托管静态资源，不连 CDN）。

- **怎么跑**：`pnpm openapi`。`pnpm dev` 与 `pnpm build` 前面都会先跑它，所以文档不会和代码脱节；
  只想快速起服务用 `pnpm dev:only`。生成产物是 `public/openapi.json` 与 `public/swagger-ui/`，
  两个都在 `.gitignore` 里（构建产物，不入库）。
**怎么跑**：生成入口是 `scripts/openapi-fresh.mjs` —— `pnpm openapi`（强制）、`pnpm dev`、`pnpm build` 都走它，
  所以文档不会和代码脱节；只想快速起服务用 `pnpm dev:only`。生成产物是 `public/openapi.json` 与 `public/swagger-ui/`，
  两个都在 `.gitignore` 里（构建产物，不入库）。
**`pnpm dev` 不再每次都重新生成**（2026-09-19，用户要求「降低启动时间」）：这一步要 1~2.6s，还会把几十条诊断刷满屏，
  而产物只有接口相关的东西变了才会变。现在把 `src/` 下全部 TS + `openapi-gen.config.ts` + 两个 scripts + `package.json`
  算成哈希存进 `.data/openapi-fresh.json`，对得上就跳过（实测 2.6s → **0.07s**），对不上（或产物被删了）才真的生成。
  判定故意**宁滥勿缺**（整个 `src/` 都进哈希）：多算只是多花一次生成时间，漏算才会让文档过期。
  `pnpm build` 传 `--force`，生产/容器里永远是全新生成的。
- **文件分工**：
  - `openapi-gen.config.ts`：标题、描述、`servers`（**相对路径 `/api`**，本机 3001 / 容器 3000 / 内网 IP 都跟着走）、
    扫描范围、失败响应形状（我们的路由统一是 `{ error }`）。能在这里表达的别写进脚本。
  - `scripts/openapi-build.mjs`：生成之后的本地化 —— 英文分组换中文（`TAG_RENAME` / `TAG_ORDER` / `TAG_DESCRIPTION`）、
    声明两套鉴权、给每个接口补通用成功响应、清掉空 schema、把 Swagger UI 资源从 devDependency 拷进 `public/`。
    只用 Node 内置模块，不联网。**幂等**：重复跑不会重复叠加。
  - `src/app/docs/route.ts`：文档页面（手写 HTML + Swagger UI），访问路径 **`/docs`**。**不要**改用生成器自带的 UI 脚手架，
    那套默认从 jsDelivr CDN 拉前端 bundle，内网/容器里会白屏。
- **鉴权**：文档页 `/docs` 与契约 `/openapi.json` 都是**公开**的（只是一份"有哪些接口"的说明书，不含业务数据）；
  接口本身照旧要鉴权。schema 里声明了 `PlatformToken`（平台会话 JWT）与 `McpToken` 两套，**两个都是
  `http` + `bearer`**（2026-10-09 起不再有会话 Cookie）；全局默认要平台令牌，
  `/auth/*`、`/bootstrap`、`/skills/mcp` 标成公开，`/mcp`、`/mcp/info` 是「平台令牌或 MCP 令牌」。
  文档页右上角的 Authorize 是**要手动点、手动粘令牌**的（浏览器不会再自动带凭据），粘一次会记住。
  要收口就改 `scripts/openapi-build.mjs` 的 `PUBLIC_PATHS`，并给那个 route 加 `requireRole`。
- **命名约定（最容易踩的坑）**：生成器**按变量名合并 schema**，两个路由里都叫 `inputSchema` 就会互相覆盖、
  文档里张冠李戴。2026-09-19 已经改掉 7 个 `inputSchema`、2 个 `patchSchema`、2 个 `createInput`
  （改成语义化名字：`entityCreateInput` / `relationshipPatchInput` / `reasoningRunInput` / `draftCreateInput` …）。
  **写新路由时 zod schema 别再叫 `inputSchema`、`patchSchema`、`createInput` 这类泛用名**，
  按「对象 + 动作 + Input」起名；`@/lib` 里共享的 schema（如 `dataSourceInput`）本来就只有一份，不用动。
- **已知缺口**（想在文档里补齐就按需给路由加 JSDoc，标签表见包内 README）：
  1. 响应体没有 schema —— 路由返回的是手写对象，页面上给的是通用 200；要精确就写 `@response`；
  2. 请求体没有 `required`、路径参数类型都是 `string`、部分查询参数是推断无类型 —— 分别用 `@requestBody required` / `@path` / `@query`；
  3. 分组名是从路径首段推的，`@tag` 可以逐个覆盖（现在统一在 `openapi-build.mjs` 里映射）。
- **部署**：Dockerfile 的 runner 必须 `COPY --from=builder /app/public ./public`（2026-09-19 已加）——
  少了它容器里 `/docs` 打不开、`/openapi.json` 404。生成发生在 builder 阶段的 `pnpm build` 里。
- **依赖与版本**：`next-openapi-gen` 与 `swagger-ui-dist` 都是 **devDependency**（运行时只有静态资源，不进 node_modules）；
  它要求 Node >= 24（Docker 基镜像已经是 `node:24-bookworm-slim`）；peer 上写着 TypeScript >= 5.9，
  本项目是 5.8，实测能跑（它自带 TS6 兼容编译器兜底），哪天出问题先升 TS。
  `pnpm-workspace.yaml` 里给 `@scarf/scarf` 显式写了 `false`（swagger-ui-dist 带的匿名统计脚本，不跑）。
- **入口**：**侧栏不放链接**（2026-09-19 用户看到后要求「不要显示这个 API 文档」）——
  它就是 `functional-workbench.tsx` 里那段 `section.label === "平台" && <a href="/docs">`，加过又去掉了，
  别再往侧栏加；`/docs` 直接敲地址访问。

## 关系类型的键映射（2026-09-19）

用户要求：「关系类型的设置起和始的属性的映射，可以是多映射」。对齐 Palantir 的 link type **Key**
（一条 link type 要说明两个对象类型的哪些键对得上），所以在关系类型上加了两份映射。

- 数据：`relationshipTypes[].sourceKeyMappings / targetKeyMappings`，每行 `{ linkProperty, entityProperty }` ——
  前者是**关系类型这一侧**的连接属性（连接表的列名，可留空 = 外键长在对象类型上，两侧按顺序一一对应），
  后者是**这一侧对象类型**的属性名。多行就是复合键。schema 在 `src/lib/ontology.ts`
  （`relationshipKeyMappingSchema`），纯函数与校验在 `src/lib/ontology/relationship-keys.ts`。
- **默认空、空不算错**：平台只在类型层建模，键映射是给实例层、数据绑定与模型推理用的声明，
  老快照读出来就是空数组（`.default([])`），发布校验不会因为"没配"报任何东西。
- **发布前校验**（`validateVersionSnapshot` 调用 `relationshipKeyViolations`）：
  `entityProperty` 指到对象类型上**不存在的属性**是**挡发布**的（换台机器导入就是悬空引用）；
  指到的属性**不是主键**、同一侧**重复映射**、外键式**两侧条数对不齐**只是 WARN。
  主键怎么认：优先按 `sources[].primaryKey` 的列反查属性（属性用 `sourceField` 指回列），
  没绑来源的对象类型退回"必填 + 唯一"（导入外部本体就是这么记主键的）。
- 界面：`type-edit-dialog.tsx` 的关系类型分支里新增「两端的键映射」一节（起始端 / 终止端两栏并排，
  左边是连接属性的输入框带 datalist 候选，右边是该侧对象类型属性的下拉，主键带「· 主键」标记）；
  画布右栏（`ontology-builder.tsx`）只读展示 `CUST_ID → 客户标识` 这样的摘要。
  **两个入口共用同一个 `TypeEditDialog`**，别再各写一份。
- 工具：`get_object_type` 的 `one_hop` 每条边上带 `key_mapping: { source, target }`（只在配过时才带）。
- 出包/导入：本体包与 blueprint 里字段同名（`sourceKeyMappings` / `targetKeyMappings`），
  `build-bundle.mjs` 原样编译并顺手报"指到不存在的属性"；`check-bundle.mjs` 也会查一遍。
- 单测：`tests/lib/relationship-keys.test.ts`（10 条）+ `tests/lib/version-snapshot.test.ts` 的发布门禁用例。

## 数据表与字段必须有注释（2026-10-10 用户要求）

用户口径：「构建数据库的时候，字段注释一定要有」「表也要有注释，因为我也不知道表是干什么的」
「注释中不要出现形如 2026-10-10 之前定义是磁盘上的 definition.json……这是我的要求，而不是表的功能、作用」
「重点是描述它的作用，不要啰嗦」。

- **建表必须写表注释，加列必须写字段注释**，而且注释要进 PG（`COMMENT ON`）—— 只写在代码里不算。
- 只写**作用**：表注释一句话说清「一行代表什么」；字段注释写「是什么 / 取值 / null 含义 / 指向哪张表」。
  **不写改动史、背景、用户口径、日期**，也不要把字段名翻译一遍当注释。
- 唯一出处是 `src/lib/platform/db/comments.ts`，迁移 `0006` 由它生成 `COMMENT ON`（幂等）；新增表或列先在那里补一条。
- PG 专有列（`object_entries` / `ontology_concepts` 的 `search_doc`、`embedding`）由代码按扩展可用性补建，
  注释写在**创建它们的那段代码**里。
- 核对：查 `pg_description` / `information_schema`，**表与字段的注释一个都不能缺**。
## 平台库统一走 TypeORM（2026-09-19 用户要求）

**口径：操作数据库一定要用 ORM，不能直接写 SQL；以前写在业务代码里的 SQL 也要改掉。**
这条是硬约束，改任何数据访问前先看这一节。

**平台库（PostgreSQL，schema `ontology_platform`）**：全部走 `@/lib/platform/db`。

- 实体在 `src/lib/platform/db/entities.ts`，表结构在 `src/lib/platform/db/migrations/`（**幂等**，按数组顺序执行；
  加表 / 加列就追加一支迁移类，不要在业务代码里写 DDL）。
- 读写用 `platformRepo(Entity)`（事务内用 `repoIn(manager, Entity)`）；事务用
  `withPlatformTransaction(manager => …)`。`src/lib/platform/platform-db.ts` 只留业务口径与领域类型转换。
- **仓储一律按"实体名"解析**（`repositoryFor`）：dev 的 HMR 会让同一份代码存在多个模块副本、
  各自换一批实体类，按类身份判断会互相重建 DataSource，表现为随机的
  `No metadata for "…Entity" was found`。所以 DataSource 只按配置建一次，仓储按名字找 target。
- **TypeORM 1.x 的 PG 查询器只接受位置参数**（`$1` + 数组）；传对象（`:name`）会直接抛
  `Your driver does not support named placeholders.`
- **联表不要写 `leftJoin(EntityClass, "别名", 条件)`**：TypeORM 1.x 会走"把目标类当关系实例化"那条路，
  实测在审计列表上直接抛 `Class constructor PlatformUserEntity cannot be invoked without 'new'`
  （`/api/ontology/:id/decisions` 整页 400）。改传表名字符串（`metadata.tablePath`）也不行 ——
  它把 `ontology_platform` 当成了别名，报 `"ontology_platform" alias was not found`。
  现在的做法是**不联表**：主表按条件查出来，再拿 `In(actorIds)` 补一次操作人邮箱在内存里合
  （`listAuditEntries`）。真要联表就先把关系（`@ManyToOne` + `@JoinColumn`）声明到实体上，
  然后 `leftJoinAndSelect("a.actor", "u")`，别再试上面两种写法。
- **`.delete()` 不能接带别名的 where**（2026-10-08 用户点「删除历史」报
  `missing FROM-clause entry for table "c"`）：`scopedConversations(repo.createQueryBuilder("c"), …)`
  是给 SELECT 用的，条件里带别名 `c`；直接 `…delete().execute()` 会生成
  `DELETE FROM … WHERE c.created_by = …`，而 DELETE 里没有这个别名。删除要单独用
  `repo.delete({ id, createdBy, ontologyId })`（无本体的那支用 `IsNull()`）—— 条件用
  `FindOptionsWhere` 表达，列名交给实体映射。**归属校验一条都不能少**：删除、读取、列表三处的
  范围条件必须一致，否则会出现"能删别人的记录"。

**业务数据源**：对象服务不拼 SQL，只声明"要哪些列、什么条件"。接缝是连接器的
`selectRows` / `countRows`（`DataSourceRowQuery`），实现里用 TypeORM 的 **QueryBuilder**：
表名交给 `.from()`（**传裸名**，预转义会变成 `"""GISTOOLS"""`），值走 `setParameter`。

**允许保留的显式 SQL**（都在各自文件的注释里写明原因，别再扩散）：

1. `src/lib/platform/db/migrations/*`：建表 / 改列 / 数据回填（迁移本来就是干这个的）；
2. `@/lib/platform/db` 的 `withAdvisoryLock`：PG 会话级 advisory lock，TypeORM 没有等价 API；
3. `object-index/postgres.ts` 的**表结构与全文 / 向量检索**：GIN、tsvector 生成列、pgvector、
   `@@` / `ts_rank` / `<=>` —— PG 专有，换搜索引擎就是换这个文件；
4. `data-source/sql.ts` 的 **DDL 还原、Oracle 数据字典、只读 SQL 工作台**：
   前两个是驱动能力（TypeORM 对旧 Oracle 的 ALL_TABLES 支持有问题），第三个功能本身就是"执行用户写的 SQL"。

### 对象身份与对象服务（S1 / S2 / S3，2026-09-19）

**身份 = (对象类型, 主键)**：`@/lib/instance/object-identity` 是唯一定义处（纯函数、有单测）。

- `objectIdOf(entityType, primaryKey)`：SHA-1 派生的**确定性 UUID**（v5 风格）。同一主键永远同一个 id，
  发布 / 动作写入 / 导出快照 / 索引键四处共用；主键不全时返回空串，调用方退回"快照里的那一行"。
  **命名空间常量不要随手改**：改了等于把所有对象换一批身份。
- `objectKeyOf` 是索引里的唯一键（`[对象类型, 规范化主键]` 的 JSON），主键值里的 `\` `&` `=` 会转义，
  避免 `{a:"b&c=d"}` 与 `{a:"b",c:"d"}` 撞键。没有主键的对象退回 `id:<objectId>`（唯一，但**不是身份**）。
- 主键值统一**去空格**：Oracle 的 CHAR 列取回来带尾空格（`"371       "`），身份、索引键、
  按主键查询都用去空格后的值。
- **主键重复挡发布**：`validateVersionSnapshot` 会报"同一个对象类型里主键必须唯一"（`primaryKeyConflicts`）。

**对象服务**（`@/lib/instance/object-service`）是"按对象类型 + 主键取对象"的唯一入口：

| 入口 | 说明 |
| --- | --- |
| `getObject(context, 类型, 主键, {origin})` | 索引里有就走索引（快），没有就按 `sources[]` 回源（全）；`origin` 可强制 |
| `queryObjects(context, {text, filters, limit, offset})` | `auto`：索引里这个对象类型有数据就用索引，否则回源；总数拿不到时是 `null`，不编造 |
| `syncObjectsToIndex(context, 类型, {keys?, limit?})` | 增量写索引（只 upsert 不 prune；发布才 prune） |
| `GET /api/objects` | `?targetId&entityType` + `key=列=值&列=值`（单个），或 `text` / `filter=列:算子:值`（列表） |
| `POST /api/objects/index` | 增量同步：给 `keys` 就只同步这几条 |

来源是可替换的一层：`ObjectSource` 目前只有"数据资源"一个实现（`data-source.ts`），
将来接物化对象层 / ES / REST 只加实现，门面与界面不动。

**界面与 AI 都已接上（2026-09-19）**：

- **对象页**：选了具体对象类型后走对象服务，工具栏可切「来源：自动 / 已物化 / 业务库」
  （`origin` 透传），表头显示"共 N 条"。草稿视图也走对象服务（回源是只读的），
  `versionId` 传当前工作版本，草稿里刚补的绑定当场生效；不选对象类型时仍读快照。
  列表里来自业务库的对象（`origin=source`）是**只读**的，详情页给一个「取进草稿」按钮。
- **取进草稿**（`POST /api/objects/materialize`）：按主键把业务对象写进草稿快照。
  因为身份是确定性的，这一步**幂等** —— 取两次还是同一条，不会造出两份。动作与属性编辑都作用在草稿上，
  所以要先取进来（这仍是**平台自己的草稿写入**，不写业务库）。
- **图谱页**：工具栏「业务对象 / 从数据源加载」按类型实时取一批对象作为节点。
  这些节点**没有连线** —— 关系类型还没有数据来源（backlog D2），界面上要如实说明，别让人以为关系丢了。
- **动作页**：主对象选择器改走对象服务（选中项标"数据源"），提交时带 `subjectRef`（`对象类型/主键串`）；
  服务端发现这个对象不在草稿快照里就先取进草稿再执行（入参里的对象同理，走 `inputs[].entityRef`）。
- **AI**：`query_object_instance` / `query_instance_subgraph` 已解除 `disabled`，实现改走对象服务
  （索引优先、没有就回源），并在返回里带 `_origin` / `_primary_key`，让模型知道这条是不是实时读来的。

### 导入时补齐数据资源绑定（2026-09-19）

问题：bkn 知识网络只写了「SCHEMA.TABLE」，本体包里的资源 id 又属于导出端环境，
于是导入进来的对象类型常常"有表名、没资源"，对象服务只会回一句"没有绑定数据资源"。

口径（`@/lib/datasource/source-binding.ts`，纯函数 + 单测）：

1. **表名唯一命中某个本机资源的表清单** → 自动绑（表清单来自结构缓存：`catalog` 桶 + 看过的视图键）；
2. 命中多个 → 不猜，导入响应里给 `pendingSources`，导入弹窗列出候选让人选一次；
3. 表清单里都没命中、但**模式名唯一命中** → 退一步自动绑（弱匹配）；
4. 都不确定 → 留空 + 给候选，导入后在对象类型里改。

配套：`POST /api/ontologies/:id/bind-sources` 把界面上选的绑定写回**草稿**（不重新导入、不动已发布版本）。
实测：把本体包里的资源引用全部抹掉再导入，9 个对象类型全部按表名自动绑上，`pendingSources` 为空。

**导入之后也能补（2026-09-19 补，之前这里是死路）**：原来只有导入弹窗能选绑定，
导入时点了「先不绑」就再没有第二次机会 —— 表现是对象页在那个对象类型上一条都读不出来、
动作页说「绑定的数据资源不存在」，而界面上**没有任何地方能改**。

- `GET /api/ontologies/:id/bind-sources[?versionId=]` 列出**所有还差绑定的来源**；不传版本号就挑
  "当前该改的那个"（有草稿取草稿，否则取已发布）。候选排序：表名命中在前、模式命中在后。
- 界面入口：**对象页**顶部的红色提示条「N 个来源还没绑到数据资源」+「补齐数据资源绑定」按钮
  → 弹窗（`@/components/bind-sources-dialog.tsx`）→ 写进草稿。点按钮会先 `ensureDraft()`。
- **查绑定必须把所有没绑好的都吐出去，不能只吐"判不出来"的**（`planSourceBindingsFor`）：导入可以静默
  自动绑，因为紧接着就写进草稿了；查询没有"紧接着"，只回 pending 的话，能自动判定的那些会变成
  "界面上没得选、库里也还是空的"（实测踩过一次：`pending=0` 但 9 条还是悬空）。
- **悬空引用也要算待补**：`brokenSourcesOf(definition, knownSourceIds)` 既收「`dataSourceId` 为空」，
  也收「指向本机已不存在的资源」——换过平台库的本体就是这样，只按空值判断会显示成"绑好了但读不出数据"。
  `unboundSourcesOf`（只有空值那一种）仍是导入时用的那个，两者别混。

**对象服务读路径不跟草稿绑定（2026-09-19 修）**：对象页原来写 `objectServiceView = !draft`，
于是"补齐数据资源绑定"一建草稿，对象页就立刻读不出业务数据了 —— 得先发布才看得到，顺序全反。
现在回业务库取数在草稿视图下也能用（它是只读的，草稿只决定能不能**编辑**行），
`/api/objects` 带上 `versionId`（草稿 id），草稿里刚补的来源绑定当场生效。图谱页的
「从数据源加载」同样要带 `versionId`，否则它按**已发布**版本解析来源，节点一个都出不来。

**同一次点检还修掉两个"看着像 1–5 坏了"的坑**（都在对象页，2026-09-19）：

- `POST /api/objects/materialize` 返回的是对象服务的 `ObjectRecord`（主键叫 **`objectId`**），
  界面按图库行的形状写成 `record.id` —— 取进草稿那一刻把选中项顶成 `undefined`，详情直接跳回
  "选择一条对象"，看起来像"点了没反应"。**这两个形状别混**：图库行是 `EntityRow.id`，
  对象服务记录是 `ObjectRecord.objectId`。
- `origin` 说的是"这一行**从哪读的**"，不是"本体里有没有副本"。按「业务库」看时，刚取进草稿的对象
  仍然读自业务库，于是详情里还挂着「取进草稿」。现在对象页会再对一次草稿快照：这一版里有这个对象
  （id 相同，因为身份是确定性的）就当"已物化"处理 —— 可编辑、可删；从草稿删掉后再拉一次列表，
  它回到只读业务对象（**不要**在本地 `filter` 掉它：业务库里它还在，删了会显得"业务库也没这条"）。

**会话历史与审计这两处也是同一次点检发现的 TypeORM 坑**：`repo.manager.find(EntityClass, …)`
绕过了 `repositoryFor` 的"按实体名兜底"，dev 下报 `No metadata for "ConversationMessageEntity" was found`
（对话历史整页 401 —— `apiErrorStatus(error, 401)` 把内部错误当成了未授权）。**一律用
`repoIn(repo.manager, Entity)`**；`listAuditEntries` 的 `leftJoin(EntityClass, …)` 同理，
见上面「平台库统一走 TypeORM」一节。

### 关系类型的数据来源（D2，2026-09-19）

对齐 Palantir 的 **link type backing datasource**：关系实例（边）从哪儿读。定义层加
`relationshipTypes[].linkSource`，**不配也合法**（那条关系类型只在类型层存在，图上看不到它的边）。

```ts
linkSource: { mode: "JOIN_TABLE" | "FOREIGN_KEY", dataSourceId, schema, view, foreignKeySide: "SOURCE" | "TARGET" }
```

| 模式 | 用在哪 | 连接行从哪张表读 | 两侧键映射怎么写 |
| --- | --- | --- | --- |
| `JOIN_TABLE` | 多对多，有一张中间表 | `linkSource.view`（中间表） | 左框（`linkProperty`）写中间表的列，右框（`entityProperty`）挑该端对象类型的主键属性 |
| `FOREIGN_KEY` | 多对一 / 一对一，外键长在某一端的表上 | `linkSource.view`，**留空就用外键端对象类型的主来源表** | 两侧左框**都留空**，外键端右框填外键属性，被引用端右框填被引用的（主键）属性 |

**分工（别把这三层混在一起）**：

- `@/lib/ontology/link-source`：**纯函数**，把 `linkSource` + 两侧键映射翻译成一次取数计划
  （`planLinkSource`），失败给"人话原因"。它负责属性名 → 真实列名的换算，以及"这一步之后 SQL 长什么样"。
  `linkSourceViolations` 接进 `validateVersionSnapshot`，配了但取不出实例只报 **WARN**（不挡发布）。
- `@/lib/instance/object-service/links.ts`：`queryLinks(context, { relationshipType?, seed?, limit })` ——
  取行、拼对象身份（复用 S1 的确定性 id）、去重、如实告知。边两端的 id 与对象页/索引**同一套身份**。
- `GET /api/links?targetId&versionId&relationshipType&entityType&key=…&limit=`：`key` 可重复传，
  表示"以这一批对象为起点"；过滤会**下推到业务库**（单值 `EQ`、多值 `IN`），不是把整张连接表拉回来再筛。

**关键约束：键映射必须覆盖该端对象类型的全部主键列**。少一列算出来的对象 id 跟对象服务对不上，
边就会挂到不存在的节点上 —— 计划阶段直接拒绝并说清缺哪一列，宁可不给边也不给错的边。

**界面**：

- 关系类型编辑弹窗（`type-edit-dialog.tsx`）多一块「关系的数据来源」：怎么连（两种模式）/ 数据资源 /
  表（外键式可留空）/ 外键长在哪一端。选完资源读表清单、选完表读字段，字段名进「连接属性」的下拉。
  外键式下点「添加映射」**左框留空**（填了会被当成中间表式并报错）。
- 图谱页「从数据源加载」现在是**一跳展开**：种子对象 → 以它们为起点取边（下推过滤）→
  另一端的对象也取成节点（**按对象类型分组 + `IN` 批量取，一个类型一个请求**；一条边一个请求会把
  Oracle 打爆）→ 一起画上去。另一端取不到（业务库里确实没这条记录）的边不画，也不假装它在。
- 图谱计数（`graph-canvas.tsx` 的 `30/0 个节点`）分母取"快照总数"与"当前图里实际有多少"的**大者**：
  数据源来的节点不在快照里，只按快照算会出现除以 0 那种读不通的计数。
- AI 工具 `query_instance_subgraph` 也吃这些边（节点走对象服务、边来自索引 + 配了来源的关系类型）。
  **注意 MCP / 问答读的是已发布版本**：草稿里刚配好的数据来源，发布之后 AI 才看得到。

顺带抽出来的共用件：`@/lib/ontology/fields.ts` 的 `propertyForColumn` / `columnForProperty`
（属性 ↔ 列的换算）。**单独一个文件是因为客户端也要用它** —— 原来的家 `@/lib/instance/object-identity`
依赖 `node:crypto`（算确定性 id），进不了浏览器包；服务端那边从 `object-identity` 转出去，实现只有一份。

**实测**（2026-09-19，Oracle 测试库）：新建关系类型「网格属于县区」（政企网格编码字典 → 县区编码字典，
外键式，外键在起始端的 `SALE_DISTRICT_ID`），图谱页对「政企网格编码字典」取 30 个对象 →
**30 个节点 + 24 条「网格属于县区」边 + 5 个自动补出来的县区节点**（另有 5 节点 / 6 边被 30 节点上限隐藏）。
`/api/links` 单测 12 条（两种模式的计划、条数对不齐、外键式填了连接列、种子过滤的 EQ/IN/无关/对不上）。

**已知边界**：复合主键的端点不铺开（一跳展开只处理单列主键的邻居）；关系类型自己的属性目前只从连接行按
`sourceField` 读同名列，没做别名映射。

### 对象详情与「扩展一度邻居」也吃 D2 的边（2026-09-19，D2 收尾）

D2 当初只接了「从数据源加载」与 AI 子图，留下两处对不上的地方：对象详情里看不到关系；点节点展开时只有图库快照里的边。
现在两处都补上，共用同一段客户端逻辑。

- **对象 id 不可逆**：对象 id 由 `(对象类型, 主键)` 哈希而来（S1），点一个节点时手上只有 id，反推不出主键，
  也就没法去问关系类型的数据来源。所以图谱页多了一张 `keysByNodeId`（`functional-workbench.tsx` 的 `GraphManager`）：
  「从数据源加载」的种子对象与自动补出来的邻居对象都把 `(对象类型, 主键)` 登记进去，展开时靠它还原。
- **两条来源合起来才算完整的一度**：`/api/instances/neighbors`（已发布 / 草稿快照里的边）+ `/api/links`（D2 的业务边），
  客户端共用 `readBusinessLinks()`。**别只接一条** —— 那会出现"从数据源加载能看到边、点节点展开却还是孤立点"。
  实测（Oracle 测试库，8 个「政企网格编码字典」种子）：点一个**县区**节点扩展，图从 10/10 节点·关系涨到 16/16，
  提示「又从业务库取到 10 条关系、10 个相邻对象」，请求是 `/api/links?entityType=县区编码字典&key=SALE_DISTRICT_ID=…`。
- **对象详情多一块「一跳关系」**（`ObjectLinkList`，与图谱同一个组件文件）：数据同样来自 `/api/links`，
  每行写清「关系类型 + 方向 + 另一端的引用」，点一行跳到那个对象（不在本页列表里就先切到它的对象类型再选）。
  空的两种原因要分开说（`linkHint`）：**没配 `linkSource`** vs **真的有零条边**。
- **客户端也要算主键**：`primaryKeyFromProperties` / `primaryKeyColumns` / `normalizeKeyValue` 从
  `@/lib/instance/object-identity` 搬到了 `@/lib/ontology/fields`（那边带 `node:crypto`，客户端引不了），
  前者原样再导出，服务端调用点一行没改。**别再各写一份主键换算。**
- 已知边界同 D2：复合主键的端点不做一跳展开；关系类型自己的属性只按 `sourceField` 同名列读。

### 数据源取行的 Oracle 坑（都已在代码里处理，别再踩）

1. **11g 没有 `FETCH NEXT`**：TypeORM 的 `.limit()/.offset()` 在 Oracle 上生成 `FETCH NEXT n ROWS ONLY`，
   旧服务端直接 `ORA-03001: unimplemented feature`。现在 Oracle 走 `ROWNUM <= take + skip` 条件限行，
   深翻页在内存里丢掉前几页（`ORACLE_MAX_OFFSET = 5000`）。
2. **CHAR 列的绑定值不补空格**：`WHERE CUST_ID = :1`（绑 `'1654…'`）匹配不到，`= '1654…'`（字面量）却匹配，
   绑**带空格的原值**才匹配。所以定长 CHAR 列的等值比较写成 `RTRIM(col) = :p`
   （`paddedColumnsFor` 按视图缓存列类型，5 分钟）。代价是这一列用不上普通索引 —— 正确优先。
3. **Oracle 的绑定名必须是数字键**（`{"1": v}`）：TypeORM 的 `getSql()` 已经把 `:p1` 变成 `:1`，
   再把 `getParameters()`（`{p1: …}`）交给驱动会"参数没传进去、过滤静默返回空"。
   正确做法是 `getQueryAndParameters()` 拿位置化 SQL + 值数组，再转成数字键对象。
4. 取数失败时错误信息里会附上语句（截断 800 字符）：排障靠这一段就能判断是列名、分页还是绑定。

## 检索索引的后端边界收口（2026-09-19）

用户问「未来切换其它存储，比如 es/opensearch，好切换吗」。结论：**接口这一层是干净的**（所有调用方都走
`getObjectIndex()`，没人碰表或 `pg`），真正要花时间的是 ES 缺的两件事 —— **原子整表替换**（PG 有事务，ES 得靠
alias 切换）与 **按缺失键 prune 的增量同步**（PG 一条 `DELETE … WHERE NOT IN`，ES 要 sync token + delete_by_query）。
顺手做了三件收口，把切换成本固定在这个水平：

- **PG 专用件不再从公共 barrel 转出**：`escapeLike` / `normalizeSearchQuery` / `planObjectSearch`
  是 PostgreSQL 的查询规划与 LIKE 转义，留在 `@/lib/instance/object-index/sql`（要单测就直接引它）。
  以前从 `@/lib/instance/object-index` 转出去，等于把"索引后端 = PostgreSQL"写进公共契约。
- **实例改成注册表 + 按 kind 缓存**：`src/lib/instance/object-index/index.ts` 的 `factories` 是唯一的扩展点
  —— **加后端 = 实现 `ObjectIndex` + 扩 `ObjectIndexKind` + 加一行**；没登记的 kind 会报
  「还没有 X 的检索索引实现…」。缓存挂 `globalThis`（`__ontologyObjectIndexes`）：dev 下模块被反复求值不会漏实例
  （和 D3 的连接池一个教训）。
- **新增后端契约测试**（换后端时先跑它，别靠人肉比对）：
  - `tests/lib/object-index/contract.ts` 的 `runObjectIndexContract()` 是**后端无关**的：upsert 不新增、
    prune 只留这一批 / 只增不删、按对象键读、`deleteObjects` 计数、`replaceTargetObjects` 整体替换、
    按标签过滤与精确总数、分页不重不漏、`EQ / IN / CONTAINS / EXISTS`、关键字命中（**没有全文能力时如实报
    `textMode: "none"`**）、`deleteTargetObjects` 与 `stats`。
  - `tests/lib/object-index/postgres.contract.test.ts` 拿真 PostgreSQL 跑这一组：**默认跳过**
    （`pnpm test` 不依赖数据库；vitest 不会把 `.env.local` 灌进 `process.env`，实测确认过）。
    要跑用 `pnpm test:object-index`（= `node --env-file=.env.local vitest run <那个文件>`）。
    用例只写随机 `contract-<uuid>` target 的索引行（`object_entries` 对该列没有外键），跑完自己清干净 ——
    实测 **15 passed / 848ms**，跑完库里 `contract-%` 为 0 行；平台库连接由该文件自己 `initialize()`
    （应用里是启动流程 `ensurePlatformSchema()` 做的，测试不该顺带跑迁移）。

**当前事实**（同一轮实测）：对象检索索引只有 PostgreSQL 一个后端，表 `ontology_platform.object_entries`，
和平台库同库；扩展 `pg_trgm` + `vector` 已装，索引有 GIN(labels/search_doc/properties)、
GIN(search_text gin_trgm_ops)、HNSW(embedding)、唯一键 `(target_id, object_key)`。
表结构由 `postgres.ts` 在运行期自建（**不在 migrations 里**），所以新后端有自己的建表位置。
索引里目前只有 2 行历史遗留（target `5446bc14-…`，该 target 已不在 `graph_targets`），当前本体 0 行
—— 这正好说明 S4 要补的是"谁进索引"。

## 数据资源的连接池与并发闸门（D3，2026-09-19）

动的只有 `src/lib/datasource/sql.ts` 的 `withConnection()`：以前是**每次操作连一次、断开一次**
（`new DataSource()` → `initialize()` → `destroy()`），试连 ~400ms、点开一张表 ~500ms 基本都花在建连接上。现在：

- **按连接指纹缓存连接池**：指纹 = `buildConnectionOptions()` 的结果（除 `name`）做 SHA-256。
  主机 / 端口 / 库名 / 模式 / 用户名 / 密码 / 池参数改任何一项都是另一条池。
- **状态挂 `globalThis`（`__ontologyDataSourcePools` / `__ontologyDataSourceGates`）**：dev 下模块会被反复求值，
  挂模块变量会漏掉上一份池子（连接收不回来）。和平台库连接池一个思路。
- **回收规则**：池子上限 8 条、空闲 10 分钟回收；`entry.inUse` 计数，**正在用的池子不收**（空闲 sweep 与 LRU 都跳过它）。
  改连接信息与删来源时调 `releaseDataSourcePool(sourceId)`（挂在 `data-sources/[sourceId]` 的 PATCH / DELETE 里）。
- **并发闸门**：每个来源最多 4 个操作在跑（`MAX_CONCURRENT_PER_SOURCE`），多的排队；等超过 30 秒直接报
  「这个数据资源正同时处理 4 个请求…」。名额是**直接转交**的（不经过 active++/--），排队不会漏名额。
- **超时**：PG `connectTimeoutMS` + `extra.max`；MySQL `connectTimeout` + `poolSize`；Oracle
  `poolSize` + `extra.{connectTimeout,queueTimeout,poolMax,poolMin:0}`。`poolMin` 保持 0：空闲时不留会话。
- **Oracle 原生状态也挂 `globalThis`（`__ontologyOracleClient`）**：`initOracleClient` 一个进程只能调一次，
  dev 下模块重求值会让模块变量归零、第二次初始化直接抛错 —— 这正是"改了别的代码之后 Oracle 突然连不上"的根因。
- **只有连接坏了才丢池**：`withConnection` 仅在 `!connection.isInitialized` 时丢掉这条池；
  语句自己报错（只读检查、列名写错）不动池子。
- 实测（Oracle 测试库 `oracle-test`）：试连 1677ms（首次，含编辑后的编译）→ **58ms → 47ms**；
  取一张表 `refresh=1` 1487ms → **194ms**；8 个并发试连全部 200、合计 349ms；
  `/api/links` 按网格主键取边仍返回 1 条（`GRID_ID=DD002 → SALE_DISTRICT_ID=DD`）；`pnpm test` 363 全绿。
- 没做（有意）：没给用户开"池大小 / 只读"这类旋钮 —— 只读靠 `sql-guard` 的语句检查 + 只读事务，
  跟连接池不是一回事；要调池参数直接改 `sql.ts` 顶部那几个常量。

## 审计记录（U2，2026-09-19）

发布 / 失败 / 图引擎与数据资源变更 / 草稿写入 / 动作执行，本来只在 PostgreSQL `audit_entries` 里躺着。
现在有界面了：**设置 → 审计记录**（第三档，仅管理员可见）。

- **范围切换是核心**：`src/lib/platform/audit.ts` 的动作目录（`AUDIT_ACTIONS`）一处定义中文名、分组与失败标记，API 与界面共用。
  四档范围：`changes`（默认：本体 / 版本 / 草稿 / 索引 / 图引擎 / 数据资源）、`all`、`actions`、`reads`（问答与图查询）。
  **默认把 `REASONING_RUN` / `GRAPH_QUERY_READ` 排除在外** —— 一次提问好几条，混进来会把真正的变更淹掉；要看就切「全部记录」。
- `GET /api/audit`：`scope` / `action` / `actorId` / `targetId` / `from` / `to` / `limit`（默认 50，上限 200）/ `offset`。
  过滤、排序、分页全在服务端（`listPlatformAudit()`：TypeORM `findAndCount`，`total` 是精确值），
  顺带返回 `targets` 与 `actors`（`listPlatformUsers()`）给下拉框。
  `action` 必须落在当前 `scope` 内，越界返回 400 —— 不然会出现"范围写着变更、列表全是问答"。
- **只有 ADMIN 能读**：审计里有操作人邮箱、数据资源主机名这类信息，查看者没有理由看到；界面上那一档也只给管理员。
- 目录里没登记的动作码不会被吞：标签退回显示原始码（`auditActionLabel`），「全部记录」里照样看得到。
- 展开一行看 `details` 原文（JSON），失败类动作用红色标出（`isAuditFailure`）。
- 实测（真浏览器 1680×1000）：变更记录 46 条 / 全部记录 56 条 / 过滤「发布成功」5 条；展开能看到 `details`；全程无 4xx。

## 部署（Docker Compose）

当前编排只启动本体平台 `app`。PostgreSQL（平台库）、业务数据源以及可选的
Jena/Fuseki 图引擎均不进编排，按各自现有方式部署；保留 Jena 适配器和旧数据。

- 文件：`Dockerfile`（builder 做 `pnpm build`，runner 只装生产依赖用 `next start` 起）、
  `docker-compose.yml`（仅 `app` 服务）、`.env.docker.example`（连接信息与密钥模板，
  真文件 `.env.docker` 已在 `.gitignore` 里）、`.dockerignore`。
- **不用 `output: "standalone"`**：`next.config.ts` 把 oracledb / typeorm / pg / mysql2 交给运行时加载，
  而 oracledb 是按平台拼文件名 require 预编译二进制的，Nft 追踪容易漏 → 会出现"装得上、连不上 Oracle"。
  宁可镜像大一点，也要保证原生驱动在。
- 密钥一律运行时注入（`.dockerignore` 把 `.env*` 挡在构建上下文外）；版本快照挂持久卷
  （默认改为绑定项目 `.data/ontology-versions`，与本机开发服务共用同一份；写卷名才用命名卷。
  Linux 上绑定挂载要 `chown -R 1000:1000`，容器里的 node 用户是 uid 1000）。
- **容器里的 `localhost` 是容器自己**：`DATABASE_URL` 要写 `host.docker.internal`
  （compose 已加 `host-gateway` 映射）。宿主机上的 Jena 端点可用下面的主机别名保留原登记。
- **`TARGET_ENCRYPTION_KEY` 必须与库里已有数据一致**：数据资源凭据是加密存的，换钥匙就解不开。
- **版本快照目录是状态，不是缓存**（2026-09-14 实测）：平台库只记"某本体发布了 vN"，
  定义本身在 `ONTOLOGY_VERSION_DIR`（容器内 `/data/ontology-versions`）。空卷 + 有版本的库
  会表现成"模型工具答**本体还没有发布版本**、图库与版本对不上"。要么把旧目录带过来
  （compose 的 `VERSION_SNAPSHOT_DIR` 指向它），要么部署完重新发布一次。
  **同一个平台库上并行跑本机开发服务与容器时，两边的快照目录必须是同一个**（把
  `VERSION_SNAPSHOT_DIR` 指到项目里的 `.data/ontology-versions`），否则一边发布的版本另一边读不到。
- **Oracle 只能走 Thick 模式**（2026-09-14 实测）：要连的服务端会直接拒掉驱动 Thin 模式
  （NJS-138），所以镜像里内置 Linux 版 Instant Client（`docker/oracle/install-instantclient.sh`，
  构建时优先用 `docker/oracle/*.zip`，没有才去 Oracle 官网下载），并同时设
  `ORACLE_CLIENT_LIB_DIR` 与 **`LD_LIBRARY_PATH=/opt/oracle/instantclient`** ——
  只设前者在 Linux 上会报 `DPI-1047 ... libnnz.so`（libclntsh.so 不带 `$ORIGIN`）。
  这与 `D:\project\shangke-insight` 的做法一致，改这块先去看那边的 Dockerfile。
- `APP_PORT` / `VERSION_SNAPSHOT_DIR` / `NODE_IMAGE` 是给 compose 做**变量替换**的。
  `env_file:` 里的变量不参与替换，所以四个 `docker:*` 脚本统一带 `--env-file .env.docker`
  （同一个文件既注入容器、又做替换）；手动敲 `docker compose` 时必须自己带上这个参数。
- **登录态不再和 cookie / `Secure` / 协议有关**（2026-10-09 全量改成 `Authorization: Bearer`）：
  以前用 HttpOnly 会话 cookie，踩过"容器里 `NODE_ENV=production` 恒成立 → http 访问发出 Secure cookie
  → 浏览器丢掉 → 登录一下就被踢回登录页"（只见于非 localhost 的地址）。现在令牌走请求头，
  `src/lib/session-cookie.ts` 已删除、`AUTH_COOKIE_SECURE` 不再有意义。**别把 cookie 兜底加回来**。
- `platform-db.ts` 的连接池挂了 `error` 监听：远端平台库的空闲连接被网络设备掐断时，
  没有监听者就是未捕获的 error 事件（进程可能直接退出，日志还会打出整个连接对象）。
- **Jena 端点主机名由 `GRAPH_ENDPOINT_HOST_ALIAS` 改写**：平台库里若登记的是宿主机地址
  `http://localhost:3030/ds`，容器里默认用 `localhost=host.docker.internal` 保持可达。
  远端 Jena 直接登记真实地址或显式覆盖别名；实现位于 `src/lib/framework/graph/jena/index.ts` 的
  `resolveSparqlEndpoints`（`applyEndpointHostAlias` 有单测），不要绕过唯一出口。
- **现存 Fuseki 数据不清理**：旧 `ontology-fuseki` 容器可能在更新 Compose 后成为孤儿，本次只改编排，
  不自动停止或删除容器，也不删 `.data/fuseki`。旧 `.env.docker` 的 `FUSEKI_*` 不再配置服务，
  但仍被 `env_file` 注入 app，建议用户自行清除这些旧变量，尤其是管理员密码。

## 待办事项（Backlog）位置与规则（2026-10-10 用户要求）

- 项目详细待办清单位于 `docs/待办事项.md`，**这里不再展开具体条目**。
- 任何未完成功能、已知缺口、后续优化、协议演进和验收工作，都必须登记到该文件。
- Backlog 条目必须包含：编号、状态、前因后果、功能作用、设计细节、已完成、未完成、验收标准、影响范围、关联文档。
- 只写“待办 xxx”是不够的；必须说明为什么做、做完有什么用、做到哪里、还差什么、怎样算完成。
- 完成项不要从文件中静默消失：先更新其状态、已完成内容和验收结果，再按维护规则归档。
- `AGENTS.md` 只负责声明 Backlog 的位置、格式和强制要求，不承载详细待办内容。

## 左侧导航的权限可见性（2026-10-10）

（`functional-workbench.tsx` 的 `NAV_SECTIONS` / `mayEnterView` / `firstEnterableView`）。

- `NavItem` 是 4 元组 `[View, 标签, 图标, 权限点 | null]`；`null` = 所有登录用户可见（目前只有「设置」）。
  映射：总览 / 本体建模 / 本体技能 / 动作 / 规则 → `ontology.read`；实例图谱 / 对象 / 关系 → `instance.read`；
  智能问答 / MCP 调试 → `reasoning.use`；数据资源 → `datasource.read`。
- 当前视图没权限时**自动落到第一个能进的视图**（改角色 / 换账号立刻生效），不留空白页。
- 「设置」里三个标签各自判：图引擎配置 = `target.read`、审计记录 = `audit.read`、用户与角色 = `users.manage`。
- **本体列表不许被别的权限带崩**：`loadTargets` 里 `/api/ontologies` 与 `/api/targets` 分开调
- 没有 `target.read` 也能看本体：`targetFromStorage()` 用本体列表里的 `storage` 拼一个只读 Target 兜底；
  `loadVersions` 在没有 `instance.read` 时**不发** `/api/instances/types`（免得顶栏顶一条 403）。
- 加视图时别忘了第 4 项：`tests/lib/nav-visibility.test.ts` 扫源码对账（视图清单 ↔ 导航登记 ↔ 权限点存在）。

## 权限点的前端落点（2026-10-10）


- **入口级**（导航）按 `NAV_SECTIONS` 的第 4 项过滤：总览 / 本体建模 / 本体技能 / 动作 / 规则 = `ontology.read`；
  实例图谱 / 对象 / 关系 = `instance.read`；智能问答 / MCP 调试 = `reasoning.use`；数据资源 = `datasource.read`。
- **按钮级**一律走 `may(user, code)`：建模页的 校验 / 发布 = `ontology.publish`，画布与清单增删改 = `ontology.write`，
  图引擎配置里的 新建 / 测试 / 编辑 / 删除 = `target.write`（`TargetManager` 收 `canWrite`），
  动作的 干跑 / 执行 = `instance.write`（`ActionStudio` 收的是 `canRun`，和改定义的 `canEdit` **不是一回事**），
  MCP 工具开关与「跟随全局」= `mcp.token.manage`（`info.token.canManage`），
  对象页的「补齐数据资源绑定」= `ontology.write`（它写的是本体草稿，不是实例）。
- **不好藏的给提示**：智能问答引用里的对象链接在缺 `instance.read` 时回一句「没有查看对象与关系的权限」；
  对象页在没有草稿又缺 `ontology.write` 时，把「首次修改会自动建草稿」改写成「先补哪个权限」。
- **容易漏的一类**：写接口要的权限和按钮看起来要的权限不一致。动作执行、补齐绑定、
  建草稿（`POST /api/ontology`）都是这类 —— 加新按钮前先看服务端那一行 `requirePermission`。
- 验证办法：用一个只读角色（`ontology.read + instance.read + datasource.read + target.read + reasoning.use`）
  把每个页面点一遍，确认写按钮全是 disabled、页面没有 403（2026-10-10 实测通过）。

## 全局提示：浮层吐司，不占页头（2026-10-10）


- 工作台的全局提示（`notify()` / `fail()` 写进 `message` / `error` 状态的那些）统一走 `Toast`，
  **底部居中浮层**，样式在 `globals.css` 的 `.toast-stack` / `.toast`（z-index 200，高于 `.dialog-backdrop` 的 120，
  弹窗里保存失败也看得见）。
- **别放右下角**：Next.js 开发模式那个圆形 dev 按钮就压在右下角，会挡住关闭按钮（2026-10-10 实测点不动，
  Playwright 报 `<nextjs-portal>` intercepts pointer events）。
- 时间语义别改：成功类提示由 `notify()` 的 5 秒计时器收起，错误类等用户自己点 ×。
- 行内 `Notice` 只留给「长在内容里」的地方（登录卡片、面板里本来就在版面上的提示条）；
  工作台页头那一行**不要再塞提示条**。

## 界面层的文件划分（2026-10-10）


- `src/components/functional-workbench.tsx`（约 250 行）只剩**壳**：登录态、导航表（`NavItem` / `NAV_SECTIONS` /
  `mayEnterView`）、跨页面的加载与视图切换（`FunctionalWorkbench`），以及两个常量 `emptyDefinition` / `typeOptions`。
- `src/components/workbench/` 一个页面一个文件：

  | 文件 | 内容 |
  | --- | --- |
  | `shared.tsx` | 共享类型（`User` / `View` / `Target` / `Version` / `EntityRow` / `RelationshipRow`…）、`may()`、`Toast` / `Notice`、`ResizableManagerGrid`、图渲染与列表条数两个设置 hook、`graphNoun` / `entityTitle` / `propertySummary` / `relationshipEndpoints` 这类小工具 |
  | `ontology-manager.tsx` | 本体建模页（可视化 / 分组 / 对象类型 / 关系类型 / 接口 / 指标六个标签都在里面） |
  | `graph-manager.tsx` | 实例图谱 + 清空图数据 + SPARQL 工作台（`CypherEditor`）+ 渲染限制弹窗 |
  | `entity-manager.tsx` | 对象页（含新建弹窗、`ScopedActions`、`ObjectLinkList`） |
  | `relationship-manager.tsx` | 关系页（含新建弹窗、`EndpointCard`） |
  | `target-manager.tsx` | 图引擎配置（清单 + 新建向导 + 编辑弹窗 + 试连） |
  | `settings-manager.tsx` | 设置 → 常规设置 |
  | `overview.tsx` | 总览的「本体控制室」 |
  | `version-bar.tsx` | 页头的版本条 |
  | `login-screen.tsx` | 登录卡片 |

- 规矩：**新页面加一个 `workbench/<名字>-manager.tsx`，不要再往 `functional-workbench.tsx` 里塞**；
  跨文件共享的东西放 `shared.tsx` —— 两个 manager 之间**不要互相 import**（会绕成分叉依赖）。
- 拆分脚本留在 `.data/ui-check/split-workbench.mjs`（按顶层声明切块）+ `fix-split.mjs`（重算 import），
  以后再拆类似的大文件可以照着改。
- 连带改的测试：`tests/lib/nav-visibility.test.ts` 现在同时扫 `functional-workbench.tsx` 与
  `workbench/shared.tsx`（`type View` 搬到了 shared，`NAV_SECTIONS` 还在壳里）。

## src/lib 的目录划分（2026-10-10）

用户口径：「通用的公共中间件或者抽象代码要和业务的拆开，不然放到一层目录太不好了」。现在是四档：

| 目录 | 放什么 | 代表文件 |
| --- | --- | --- |
| `src/lib/framework/` | **与本平台业务无关的通用件**：能不能整包搬去别的项目，是这里的准入门槛 | `crypto` `zip` `ids` `datetime` `format-units` `markdown` `clipboard` `api-client` `public-origin` `session-token` `local-layout` `graph-palette`；`graph/` 是图存储抽象（`types.ts` 接口 + `index.ts` 注册表 + `jena/` `embedded/` 两个实现 + `schema-inference.ts`） |
| `src/lib/platform/` | **平台自身**：账号、权限、审计、平台库 | `auth` `users` `permissions` `audit` `targets`（图引擎连接登记）、`platform-db`（平台表仓储）、`db/`（连接、实体、迁移） |
| `src/lib/<业务模块>/` | 本体业务，按模块分目录 | `ontology/`（本体模型：定义、草稿、画布、接口、指标、分组、体检、bkn 导入、关系键/基数）、`versioning/`（快照与发布）、`instance/`（对象服务与索引）、`datasource/`（数据资源与 SQL）、`reasoning/`（智能问答与工具）、`mcp/`（协议、schema、令牌）、`skills/`（本体技能） |

两条硬规矩：

1. **新代码先问「它跟本体业务有关吗」**：无关 → `framework/`；是平台自己的账号/权限/审计/平台库 → `platform/`；
   是本体业务 → 对应的业务模块目录。**不要再往 `src/lib/` 根下加文件**（根下只剩目录）。
2. **外部一律 import 目录**（`@/lib/ontology`、`@/lib/reasoning/tools`），目录里用 `index.ts` 做 barrel（`export * from "./xxx"`）。
   换文件位置只改 barrel，不动调用方。

## 领域目录不许碰持久化（2026-10-10）

**规矩**：按依赖方向，`src/lib/<业务模块>/` 只许依赖两类东西 ——
`framework/` 里的纯工具（`ids` / `format-units` / `graph-palette` 这种），以及同层模块的**纯函数**；
**不许出现** `platform/db`、`platform/*`（仓储与配置）、`versioning/snapshot`（写文件）这类持久化/副作用调用。
需要落库的，把那段编排放到 `src/app/api/**/route.ts` 或 `src/lib/platform/`。

现存的最后一处跨模块依赖是 `ontology/link-source.ts` → `instance/object-identity`（借实例层的列识别规则），
两边都是纯函数，暂不算破例；真要收紧，把那两个纯函数提到 `framework/` 共用。

## 独立任务拆给子智能体并行做（2026-10-10 用户要求）

用户口径：「如果任务是独立的可以拆给子智能体并行做，可以加速」；
「**在执行主任务的过程中，如果用户又提出了其它任务，且这个任务与主任务独立不相关、不冲突，就要使用子智能体来并行执行**」。

- **主任务进行中收到新的独立任务 → 默认派给子智能体并行做**，主线不放下手上的活。
- 判据是「文件与关注点都不重叠」：子任务要**自己拥有一组文件**（例如只写 `tests/**` + `package.json`）；
  两边不编辑同一份文件 —— 会碰同一份文件的只能排队做（并行改同一个文件必然互相覆盖）。
- 派活时说清三件事：**交付物**（哪几个文件）、**验证命令**、**不许提交**（提交永远是用户自己做）。
- 别拆的：同一份文件的连续改动、需要看全局状态的编排、以及**对主任务改动的验证**
  （验证必须由改代码的人做，否则没人对结果负责）。
- **定位**：子智能体与主线共用同一个工作目录，所以「谁能改哪些文件」必须在派活时说清楚。
- 最值得拆的是文档/测试这类「顺手活」：主线在跑 tsc、起服务、点页面的那几分钟，它们能并行写完。