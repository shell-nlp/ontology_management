import { entitySources } from "@/lib/ontology-sources";
import type { ToolContext } from "@/lib/reasoning/tools";

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
1. 先理解问题涉及哪些业务概念，用 search_schema 确认本体里真实存在的对象类型与关系类型名字。
2. 需要字段、父类、一跳的关系类型、可用动作、数据来源绑定（这个对象类型绑了哪张表）时调 get_object_type 或 list_actions。
3. 问"某对象类型一圈都和什么有关""隔两跳能到哪些类型""A 和 B 之间怎么连"时用 traverse_object_types（默认 3 跳、最多 5 跳，可用 object_types / relationship_types 限定范围，不填就是不限定）。一跳的细节就在 get_object_type 里，不必重复调。
4. **概念分组（业务域）和每组包含的对象类型已经写在下面的概念清单里**，直接据此回答；要看"哪些类型还没归组"这类完整清单才需要 list_concept_groups。
5. 要具体数据时走"对象类型 → 它绑定的表"：先 get_table_ddl 看表结构，再 run_sql 只读查数。
6. 复杂问题拆成多步：先定位涉及哪几个对象类型，再逐个读它们的定义与关系，最后再下结论。

硬性要求：
- 只能依据工具返回的真实数据回答。不要编造对象类型、属性、关系类型、动作或数据来源。
- **本体这一层只到定义**：不查图库里的对象与关系（本体实例）。要真实数据就走源表 —— get_table_ddl 看结构、run_sql 只读查数，两者都用对象类型绑定的那张表。
- 被问到"本体里有哪些对象""某个具体对象是什么"这类实例问题时，说明这一版不提供实例推理，并给出可行的替代：查它绑定的表，或到平台的「对象」「图谱」页看。**不要凭空编一个对象。**
- 写操作一律不做：run_sql 只能读，动作只描述不执行。
- 如果本体里确实没有这个概念，直接说明"当前本体没有这个对象类型 / 关系类型 / 动作"，并指出缺的是哪一项，不要用常识猜测。
- 结果被截断（返回里出现 truncated 提示）时，不要当成完整数据；用更精确的条件再查一次。

输出要求：用中文回答，先给结论，再列依据（引用了哪些对象类型 / 关系类型 / 动作）。结论要能追溯到上面的工具结果。`;

/**
 * 给模型的"本体概览"：概念分组（含每组有哪些对象类型）+ 类型清单 + 绑定的表名。
 *
 * 概念分组**把成员直接写在这里**：用户问"某业务域里有什么"是最常见的一类问题，
 * 提前给到就不必再调一次 list_concept_groups，也不至于出现"分组明明建了、模型说没有"。
 * 表名同样要带上：用户常问"某个对象类型绑了哪张表"。
 * **不带对象数**：这一层不推理实例，给了数字模型就会拿它下实例层面的结论。
 */
export function schemaBrief(context: ToolContext): string {
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
  const objects = context.definition.entityTypes.map((item) => {
    const tables = entitySources(item).map((source) => [source.schema, source.view].filter(Boolean).join(".")).filter(Boolean);
    return tables.length ? `${item.name}(绑定 ${tables.join(" + ")})` : item.name;
  });
  const relations = context.definition.relationshipTypes.map((item) => item.name);
  const actions = context.definition.actionTypes.map((item) => item.name);
  // 数据资源名要带上：run_sql / get_table_ddl 的 data_source 就用这里的名字，模型猜不出来。
  const sources = (context.dataSources ?? []).map((item) => `${item.name}（${item.kind}${item.schema_name ? ` · ${item.schema_name}` : ""}）`);
  return [
    `概念分组：${groupsLine || "无"}${ungrouped.length ? `；未归组：${ungrouped.join("、")}` : ""}`,
    `对象类型：${objects.join("、") || "无"}`,
    `关系类型：${relations.join("、") || "无"}`,
    `动作：${actions.join("、") || "无"}`,
    `数据资源：${sources.join("、") || "无"}（run_sql / get_table_ddl 的 data_source 用这里的名字）`,
  ].join("\n");
}

/**
 * 最终交给模型的 instructions：提示词（自定义优先，空白回退默认）+ 概念清单。
 * 概念清单永远在后面，用户改提示词不用管它。
 */
export function buildInstructions(systemPrompt: string | undefined, context: ToolContext): string {
  const prompt = systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  return `${prompt}\n\n当前本体的概念清单（括号里是它绑定的表）：\n${schemaBrief(context)}`;
}

/** 这个提示词是不是"自己改过"的（空白或和默认一模一样都算没改）。 */
export function isCustomSystemPrompt(systemPrompt: string | undefined): boolean {
  const value = systemPrompt?.trim() ?? "";
  return value.length > 0 && value !== DEFAULT_SYSTEM_PROMPT.trim();
}