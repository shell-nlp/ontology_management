/**
 * MCP 工具参数表的小工具，**服务端与调试页共用一份**。
 *
 * 单独放这个文件（不塞进 `reasoning/mcp.ts` 或 `mcp-endpoint.ts`），是因为调试页是客户端组件：
 * 那两个模块会拉起图库 / 数据源 / 鉴权等一堆服务端依赖，不能 import；而两边的参数口径
 * 必须一模一样 —— 否则"调试页看到什么，外部客户端接进来就是什么"这条原则就破了。
 */

/**
 * 抹掉 `ontology_id`（`properties` 与 `required` 都去），**返回新对象、不改原 schema**。
 *
 * 本体级端点（`/api/mcp/<本体 id>`）上它恒被 URL 钉死，`tools/call` 时也会被覆盖，
 * 再在参数表里标成必填只会误导客户端，所以端点与调试页都要把它藏起来。
 * 平台级端点不动：那里每次调用靠它决定查谁。
 */
export function stripOntologyId(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("ontology_id" in properties)) {
    return schema;
  }
  const nextProperties = { ...(properties as Record<string, unknown>) };
  delete nextProperties.ontology_id;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name: unknown) => name !== "ontology_id")
    : schema.required;
  return { ...schema, properties: nextProperties, required };
}
