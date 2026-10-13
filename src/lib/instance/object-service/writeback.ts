import { connectorFor } from "@/lib/instance/object-service/data-source";
import type { DataSourceWriteResult } from "@/lib/datasource/types";
import type { WritebackPlan } from "@/lib/ontology/action-writeback";

/**
 * 动作写回的**执行**（服务端那一半）：把计划交给数据源连接器，真的改业务库那一行。
 *
 * 计划（`@/lib/ontology/action-writeback`）是纯函数、浏览器也算得出来，界面因此能在点「执行」之前
 * 就把"这次会写哪张表的哪几列"摊开给用户看；这里只负责把计划送下去，一句 SQL 都不拼 ——
 * 语句、绑定参数、方言差异全在连接器（`updateRows`）里。
 */

export type WritebackExecution = {
  entityType: string;
  dataSourceId: string;
  dataSourceName: string;
  table: string;
  /** 实际执行的语句，排障与审计留痕用。 */
  statement: string;
  /** 每条赋值的「旧值 → 新值」：旧值来自写之前的回读，改没改一目了然。 */
  written: { property: string; column: string; from: unknown; to: unknown }[];
};

export async function applyWritebackPlan(plan: WritebackPlan): Promise<WritebackExecution> {
  const { connector, label } = await connectorFor(plan.dataSourceId);
  if (!connector.updateRows) {
    throw new Error(`数据资源「${label}」不支持按行写回（只有取数能力），这个对象类型暂时写不回去。`);
  }
  const result: DataSourceWriteResult = await connector.updateRows({
    view: { schema: plan.schema || undefined, name: plan.view },
    keys: plan.keys.map((key) => ({ column: key.column, value: key.value })),
    assignments: plan.assignments.map((item) => ({ column: item.column, value: item.value })),
  });
  return {
    entityType: plan.entityType,
    dataSourceId: plan.dataSourceId,
    dataSourceName: plan.dataSourceName || label,
    table: plan.table,
    statement: result.statement,
    written: plan.assignments.map((item) => ({
      property: item.property,
      column: item.column,
      from: result.before[item.column],
      to: item.value,
    })),
  };
}
