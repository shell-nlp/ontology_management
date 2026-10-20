import { implementsIdsOf, interfaceAncestorsOf } from "@/lib/ontology/interfaces";
import { summaryBlock } from "@/lib/reasoning/history";
import { entitySources } from "@/lib/ontology/sources";
import type { ToolContext } from "@/lib/reasoning/tools";
import { ONTOLOGY_SQL_DIALECT_GUIDE } from "@/lib/query-dsl/sql-surface/dialect";

/**
 * 系统提示词与「本体概览」的组装。
 *
 * 单独一个模块（而不是塞在 `agent.ts` 里）是因为**界面也要显示默认提示词**：
 * `agent.ts` 会 import AI SDK 的 provider，客户端组件引进来会白白把它们打进浏览器包。
 *
 * 两段的分工：
 * - 提示词（`DEFAULT_SYSTEM_PROMPT`，用户可在「问答配置」里改）：角色、工具用法、硬性要求、输出要求；
 * - 概念清单（`schemaBrief`）：这份本体现在长什么样 —— 概念分组与成员、对象类型与它绑的表、关系类型、动作、数据资源。
 *   它是**数据不是提示词**，所以永远自动接在提示词后面，不让用户手写（手写就会和本体漂移）。
 */

export const DEFAULT_SYSTEM_PROMPT = `你是本体（ontology）推理助手。平台里已经建好一个业务本体，你可以读它的**定义**。

工作方式：
1. 先理解问题涉及哪些业务概念，再用工具确认本体里真实存在的对象类型与关系类型名字 —— 不要凭常识猜名字。
2. 需要某个类型的字段、它实现了哪些接口、一跳的关系类型、可用动作、数据来源绑定（这个类型绑了哪张表）时，去读它的定义。
3. 问"一圈都和什么有关""隔两跳能到哪些类型""A 和 B 之间怎么连"时做关系遍历；一跳的细节通常在对象类型的定义里就有，不必重复查。
4. **概念分组（业务域）和每组包含的对象类型已经写在下面的概念清单里**，直接据此回答；要看"哪些类型还没归组"这类完整清单才需要额外的清单工具。
5. **接口（抽象契约）与它的实现情况也写在下面的概念清单里**：问"有哪些接口""这个接口谁实现了""这个类型实现了哪些接口"时直接据此回答；要看接口属性与关系约束的完整清单才去调接口清单工具。
6. 要具体数据时，**严格按下面「本轮可用工具」一节给出的取数路径走**：能用本体 SQL 就优先用它（用对象类型、属性、关系类型和指标写查询，**不要写物理表名、列名**）；本体 SQL 表达不了、或者需要排障时，才回退到"读源表结构 + 只读查数"那条路。**这一节里没有的工具就是这一轮没有开放 —— 不要调用它，也不要提它的名字。**
7. 指标（业务口径）优先用现成的：某个对象类型上可能有定义好的指标（怎么聚合、口径过滤、可用维度、单位）。问「某某条数 / 金额怎么算」先查它，不要自己从列注释里另立一套口径。
8. 复杂问题拆成多步：先定位涉及哪几个对象类型，再逐个读它们的定义与关系，最后再下结论。
- **关系类型是双向的**（Palantir 的 link type）：一条关系类型只有一条定义、两个端点，两个方向都能走，
  **反向不用另建一条关系类型**。回答"A 和 B 怎么连""隔两跳能到谁"时两个方向都算连通；
  只有明确要单向时才限定方向。

硬性要求：
- 只能依据工具返回的真实数据回答。不要编造对象类型、属性、关系类型、动作或数据来源。
- **只调用「本轮可用工具」里列出的工具名**。清单里没有的名字（包括你在别处见过、或上一轮用过的）一律不要调用 —— 调了会直接报错，白费一步。
- **表只能通过对象类型到达**：不要枚举数据源里的表和列（没有"列出所有表"这种工具，也不要用只读查询去查数据字典）；找不到就换关键词重搜，或看对象类型绑了哪张表。
- **本体这一层只到定义**：不查图库里的对象与关系（本体实例）。要真实数据就按上面第 6 条的取数路径走，用对象类型绑定的那张表。
- 被问到"本体里有哪些对象""某个具体对象是什么"这类实例问题时，说明这一版不提供实例推理，并给出可行的替代：查它绑定的表，或到平台的「对象」「图谱」页看。**不要凭空编一个对象。**
- 写操作一律不做：只读查询只能读，动作只描述不执行。
- 如果本体里确实没有这个概念，直接说明"当前本体没有这个对象类型 / 关系类型 / 动作"，并指出缺的是哪一项，不要用常识猜测。
- 结果被截断（返回里出现 truncated 提示）时，不要当成完整数据；用更精确的条件再查一次。

输出要求：用中文回答，先给结论，再列依据（引用了哪些对象类型 / 关系类型 / 动作）。结论要能追溯到上面的工具结果。`;

/**
 * 「本轮可用工具」一节：**按这一轮实际发给模型的工具生成**。
 *
 * 为什么不能把工具名写死在系统提示词里（2026-10-14 用户实测）：管理员在「MCP 调试」里关掉 `get_table_ddl` 之后，
 * 工具清单里已经没有它了，可提示词还在写「先 get_table_ddl 看表结构」—— 模型照做，回一条
 * `AI_NoSuchToolError: Model tried to call unavailable tool 'get_table_ddl'`。
 * **关工具必须同时关掉提示词里对它的引用**，两处只掐一处等于没关。
 */
export function toolGuide(enabledTools: readonly string[]): string {
  const has = (name: string) => enabledTools.includes(name);
  const lines = [`本轮可用工具（**只能调用下面这些名字**；清单里没有的工具名一律不要调用、也不要提到）：${enabledTools.join("、") || "（一个都没有）"}`];
  if (has("search_schema")) lines.push("- search_schema：任何问题都先调它，确认业务里到底有哪些概念、叫什么名字。");
  if (has("get_object_type")) lines.push("- get_object_type：读一个对象类型的定义 —— 属性、实现接口、一跳关系、可用动作、绑定的表与参考字典。字典 mappings 给出属性与码值列/含义列；reference_only 仅供参考，不可猜连接条件。字典引用不代表枚举已加载，具体含义需只读查询验证。");
  if (has("traverse_object_types")) lines.push("- traverse_object_types：问多跳关系、两两之间怎么连。");
  if (has("list_concept_groups")) lines.push("- list_concept_groups：要完整的概念分组清单时用（概念清单里已经写了的就别重复调）。");
  if (has("list_interfaces")) lines.push("- list_interfaces：看接口的属性与关系约束。");
  if (has("list_metrics")) lines.push("- list_metrics：看指标的完整口径（聚合、过滤、维度、单位）。");
  if (has("list_actions")) lines.push("- list_actions：看动作的完整定义。");
  if (has("run_query")) lines.push(`- run_query：**要具体数据优先用它** —— 写本体 SQL（对象类型 / 属性 / 关系类型 / 指标），不要写物理表名、列名。${ONTOLOGY_SQL_DIALECT_GUIDE} 日期属性按天过滤写 >= '当日' AND < '次日'（**不要用 LIKE**；= '当日' 只在列里没有时分秒时才等于当天），区间写 BETWEEN。`);
  const ddl = has("get_table_ddl");
  const sql = has("run_sql");
  if (ddl || sql) {
    const path = ddl && sql
      ? "先 get_table_ddl 看表结构与列画像（低基数列的取值清单：某个状态列有哪些码值、占比多少），再 run_sql 只读查数"
      : ddl
        ? "用 get_table_ddl 看表结构与列画像（这一轮没有 run_sql，取不到明细行，要如实说明）"
        : "用 run_sql 只读查数（这一轮没有 get_table_ddl，列名只能靠对象类型上映射的列，不要猜）";
    lines.push(`- 源表兜底（本体 SQL 表达不了、或需要排障时才走）：${path}。**表名一律写全「模式.表」**（例如 GISTOOLS.TB_DIC_AREA_CODE），不要省掉模式前缀。**一次调用只看一张表**；要对比多张表就在同一轮里并发调用。问「某某状态 / 某某类型」时先看列画像里有没有对应码值，不要用一轮轮 GROUP BY 去探。`);
  }
  if (!ddl && !sql) lines.push("- 这一轮没有可用的源表取数工具：问表结构、明细行或具体数字时，如实说明「当前不开放取数」，不要凭印象编。");
  return lines.join("\n");
}

/**
 * 给模型的"本体概览"：概念分组（含每组有哪些对象类型）+ 类型清单 + 绑定的表名。
 *
 * 概念分组**把成员直接写在这里**：用户问"某业务域里有什么"是最常见的一类问题，
 * 提前给到就不必再调一次 list_concept_groups，也不至于出现"分组明明建了、模型说没有"。
 * 表名同样要带上：用户常问"某个对象类型绑了哪张表"。
 * **不带对象数**：这一层不推理实例，给了数字模型就会拿它下实例层面的结论。
 */
export function schemaBrief(context: ToolContext, enabledTools?: readonly string[]): string {
  /** 不传 enabledTools = 不做裁剪（老调用方与单测）；传了就只提这一轮真开着的工具。 */
  const on = (name: string) => !enabledTools || enabledTools.includes(name);
  const groups = context.definition.groups ?? [];
  const groupIds = new Set(groups.map((item) => item.id));
  const membersByGroup = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const item of context.definition.entityTypes) {
    const groupId = item.groupId ?? "";
    if (!groupId || !groupIds.has(groupId)) { ungrouped.push(item.name); continue; }
    const bucket = membersByGroup.get(groupId);
    if (bucket) bucket.push(item.name);
    else membersByGroup.set(groupId, [item.name]);
  }
  const groupsLine = groups.map((group) => {
    const members = membersByGroup.get(group.id) ?? [];
    return `${group.name}（${members.length} 个：${members.join("、") || "还没有对象类型"}）`;
  }).join("；");
  // 接口名要带在对象类型后面：模型顺着接口理解"这个类型还能被当成什么用"，
  // 也是"谁实现了某接口"这类问题的直接依据。
  const interfaceNameById = new Map((context.definition.interfaces ?? []).map((item) => [item.id, item.name]));
  const objects = context.definition.entityTypes.map((item) => {
    const tables = entitySources(item).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    const implemented = implementsIdsOf(item).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const base = tables.length ? `${item.name}(绑定 ${tables.join(" + ")})` : item.name;
    return implemented.length ? `${base}〔实现 ${implemented.join(" + ")}〕` : base;
  });
  const interfacesLine = (context.definition.interfaces ?? []).map((item) => {
    const implementers = context.definition.entityTypes.filter((entity) => implementsIdsOf(entity).includes(item.id)).map((entity) => entity.name);
    const ancestors = interfaceAncestorsOf(context.definition.interfaces ?? [], item.id).map((id) => interfaceNameById.get(id) ?? "").filter(Boolean);
    const suffix = [ancestors.length ? `继承 ${ancestors.join("、")}` : "", implementers.length ? `${implementers.length} 个实现：${implementers.join("、")}` : "还没有对象类型实现"]
      .filter(Boolean).join("；");
    return `${item.name}（${suffix}）`;
  }).join("；");
  const relations = context.definition.relationshipTypes.map((item) => item.name);
  const actions = context.definition.actionTypes.map((item) => item.name);
  /*
   * 指标要在这里点名：模型看不到它就不会去用它，而"这个数怎么算"正是统计类问题的核心。
   * 一行一个 `名称（聚合(属性) · 作用对象类型）`，完整口径（过滤 / 维度 / 单位）用 list_metrics 取。
   */
  const metrics = (context.definition.metrics ?? []).map((item) => {
    const related = (item.entityTypeIds ?? [])
      .map((id) => context.definition.entityTypes.find((type) => type.id === id)?.name ?? "")
      .filter(Boolean);
    const calculation = item.calculation ?? null;
    // 「只描述、不算数」要写进概念清单：模型据此知道这条**不能出数**，别拿它去出数。
    const calc = calculation ? `${calculation.aggregation}${calculation.property ? `(${calculation.property})` : "（行数）"}` : "只描述、不算数";
    return `${item.name}（${calc}${related.length ? ` · 关联 ${related.join("、")}` : ""}）`;
  });
  // 数据资源名要带上：要读源表的工具（列画像 / 只读查数）都用这里的名字当 data_source，模型猜不出来。
  const sources = (context.dataSources ?? []).map((item) => `${item.name}（${item.kind}${item.schema_name ? ` · ${item.schema_name}` : ""}）`);
  // 这句只在这一轮真有读源表的工具时才写：工具关了就别再让模型去找它的 data_source。
  const dataSourceTools = [on("get_table_ddl") ? "get_table_ddl" : "", on("run_sql") ? "run_sql" : ""].filter(Boolean);
  return [
    `概念分组：${groupsLine || "无"}${ungrouped.length ? `；未归组：${ungrouped.join("、")}` : ""}`,
    interfacesLine ? `接口：${interfacesLine}` : "",
    `对象类型：${objects.join("、") || "无"}`,
    `关系类型：${relations.join("、") || "无"}`,
    `动作：${actions.join("、") || "无"}`,
    metrics.length ? `指标：${metrics.join("、")}${on("list_metrics") ? "（口径细节用 list_metrics）" : ""}` : "",
    `数据资源：${sources.join("、") || "无"}${dataSourceTools.length ? `（${dataSourceTools.join(" / ")} 的 data_source 用这里的名字）` : ""}`,
  ].join("\n");
}

/**
 * 最终交给模型的 instructions：提示词（自定义优先，空白回退默认）+ 概念清单 +（有的话）对话上文摘要。
 *
 * 顺序是有讲究的：**提示词最前、概念清单居中、上下文摘要最后** —— 摘要是"这次对话的临时背景"，
 * 越靠近本轮问题，模型越不会把它当成常驻设定；而概念清单永远来自本体，不能被对话内容顶掉。
 */
export function buildInstructions(
  systemPrompt: string | undefined,
  context: ToolContext,
  /**
   * `enabledTools`：这一轮**实际发给模型**的工具名（`enabledReasoningToolNames()` 算出来那份）。
   * 传了就在提示词后面接一节「本轮可用工具」，并由它决定要不要提源表取数那条路 —— 关掉的工具不会出现在提示词里。
   * 不传 = 不接这一节（老调用方与单测）。
   */
  extras: { historySummary?: string; enabledTools?: readonly string[] } = {},
): string {
  const prompt = systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  // 工具一节是**这一轮的真实情况**，由代码生成、紧跟提示词：用户改提示词也去不掉它。
  const tools = extras.enabledTools ? `\n\n${toolGuide(extras.enabledTools)}` : "";
  const brief = `${prompt}${tools}\n\n当前本体的概念清单（括号里是它绑定的表）：\n${schemaBrief(context, extras.enabledTools)}`;
  const history = summaryBlock(extras.historySummary ?? "");
  return history ? `${brief}\n\n${history}` : brief;
}

/** 这个提示词是不是"自己改过"的（空白或和默认一模一样都算没改）。 */
export function isCustomSystemPrompt(systemPrompt: string | undefined): boolean {
  const value = systemPrompt?.trim() ?? "";
  return value.length > 0 && value !== DEFAULT_SYSTEM_PROMPT.trim();
}
