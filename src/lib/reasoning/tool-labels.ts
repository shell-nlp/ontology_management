/**
 * 工具在界面上的中文名称。
 *
 * **这是唯一映射**：MCP 调试页与智能问答的求证轨迹都从这里取名字，不再各自维护。
 * 原始英文名（例如 `list_metrics`）只是协议里的稳定 code，不能当成面向用户的主标签。
 *
 * 新增工具时必须同时补一条中文名；`tests/lib/reasoning/tools.test.ts` 会检查目录里
 * 每个工具都有中文标题，漏配直接失败。
 */
export const TOOL_TITLES: Readonly<Record<string, string>> = {
  list_ontologies: "本体清单",
  search_schema: "本体概念检索",
  get_object_type: "对象类型详情",
  list_concept_groups: "概念分组清单",
  list_interfaces: "接口清单",
  traverse_object_types: "对象类型关系遍历",
  list_actions: "动作清单",
  list_metrics: "指标清单",
  get_table_ddl: "表结构详情",
  run_sql: "只读 SQL 查询",
  run_query: "本体 SQL 查询",
  query_object_instance: "对象实例查询",
  query_instance_subgraph: "关系子图查询",
};

export function toolTitle(name: string): string {
  return TOOL_TITLES[name] ?? name;
}

export function hasToolTitle(name: string): boolean {
  return Boolean(TOOL_TITLES[name]?.trim());
}