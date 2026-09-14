/**
 * 求证轨迹上「这一步拿到了什么」的一句话摘要。
 *
 * 之前这个位置显示的是证据条数，查不到证据就写"无命中"。可 `get_table_ddl` / `run_sql` 按设计
 * **不产出证据**（表结构、时序数据都不是可寻址的本体实体），于是 `run_sql` 明明返回了 6 行，
 * 界面上却写着"无命中"，看着像工具什么都没查到（2026-09-14 用户报的）。
 *
 * 所以摘要必须按工具如实描述**返回内容**，不能拿另一个口径（证据数）来顶替：
 * 查数据的说行数、看结构的说 DDL 从哪来、检索概念的说命中几个。
 */
export function toolResultSummary(tool: string, output: unknown): string {
  // 工具成功时 output 就是它返回给模型的 payload（tools.ts 的 execute 直接 return outcome.payload）；
  // 结果超过上限时换成一条 { truncated, note, preview } 的说明对象。
  const payload = asRecord(output);
  if (payload?.truncated === true && "preview" in payload) return "结果过长 · 已截断";
  switch (tool) {
    case "search_schema": {
      const count = sizeOf(payload?.matches);
      if (count === null) return "已返回";
      return count ? `命中 ${count} 个概念` : "没有概念命中";
    }
    case "get_object_type":
      return typeof payload?.name === "string" && payload.name ? "1 个对象类型" : "已返回";
    case "list_concept_groups": {
      const count = asNumber(payload?.group_count) ?? sizeOf(payload?.groups);
      return count === null ? "已返回" : `${count} 个概念分组`;
    }
    case "list_interfaces": {
      const count = asNumber(payload?.interface_count) ?? sizeOf(payload?.interfaces);
      return count === null ? "已返回" : ` 个接口`;
    }
    case "traverse_object_types": {
      const nodes = asNumber(payload?.node_count) ?? sizeOf(payload?.nodes);
      const edges = asNumber(payload?.edge_count) ?? sizeOf(payload?.edges);
      if (nodes === null && edges === null) return "已返回";
      return `${nodes ?? 0} 个对象类型 · ${edges ?? 0} 条关系类型`;
    }
    case "get_table_ddl": {
      if (!payload) return "已返回";
      // DDL 从哪来是要紧的信息：库里原始语句、还是按列元数据还原。
      return `表结构 · ${payload.ddl_source === "native" ? "原始 DDL" : "按列元数据还原"}`;
    }
    case "run_sql": {
      const rows = asNumber(payload?.returned);
      if (rows === null) return "已返回";
      return `${rows} 行${payload?.truncated ? " · 已截断" : ""}`;
    }
    case "list_actions": {
      const count = sizeOf(payload?.actions);
      return count === null ? "已返回" : `${count} 个动作`;
    }
    case "query_object_instance": {
      const count = asNumber(payload?.returned) ?? sizeOf(payload?.instances);
      return count === null ? "已返回" : `${count} 个对象`;
    }
    case "query_instance_subgraph": {
      const nodes = asNumber(payload?.node_count) ?? sizeOf(payload?.nodes);
      const links = asNumber(payload?.relationship_count) ?? sizeOf(payload?.relationships);
      if (nodes === null && links === null) return "已返回";
      return `${nodes ?? 0} 个对象 · ${links ?? 0} 条关系`;
    }
    default:
      return "已返回";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 数组看长度；有些工具直接给了计数字段，也认。 */
function sizeOf(value: unknown): number | null {
  return Array.isArray(value) ? value.length : asNumber(value);
}
