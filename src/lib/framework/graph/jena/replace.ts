import { BKN } from "./vocabulary";
import { chunk } from "./protocol";
import { randomUUID } from "node:crypto";
import { type GraphTarget } from "@/lib/framework/graph/types";

export function pushProperty(properties: Record<string, unknown>, key: string, value: unknown) {
  const existing = properties[key];
  if (existing === undefined) properties[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else properties[key] = [existing, value];
}

/** 单个 SPARQL Update 请求里能安全提交的三元组条数；超过就走影子图切换。 */
export const DEFAULT_SINGLE_REPLACE_LIMIT = 5000;

export function replaceSingleRequestLimit(target: GraphTarget) {
  const configured = target.options?.singleReplaceLimit;
  const numeric = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : DEFAULT_SINGLE_REPLACE_LIMIT;
}

export type ReplacePlan = { requests: string[]; cleanup: string | null };

/**
 * 把整图替换计划成若干 SPARQL Update 请求。
 *
 * 关键约束：**可见状态的切换只能由一个请求完成**。已实测（Fuseki 5.1 / TDB2）：
 * 单个 update 请求是事务性的——请求体里有语法错误时，前面的 `CLEAR` 不会生效。
 * 所以小图用「清空 + 插入」的单请求；大图先把三元组写进影子图（这批写入不可见），
 * 再用一个请求「清空目标 + ADD 影子图 + 删影子图」原子切换，避免超大请求体。
 */
/** 清空目标图的 SPARQL Update：配了命名图就清那张图，否则清默认图。 */
export function clearGraphUpdate(namedGraph: string | null) {
  return namedGraph ? `CLEAR SILENT GRAPH <${namedGraph}>` : "CLEAR SILENT DEFAULT";
}

export function planReplaceRequests(statements: string[], options: { namedGraph: string | null; singleRequestLimit?: number }): ReplacePlan {
  const { namedGraph } = options;
  const limit = Math.max(1, options.singleRequestLimit ?? DEFAULT_SINGLE_REPLACE_LIMIT);
  const clear = clearGraphUpdate(namedGraph);
  const targetRef = namedGraph ? `<${namedGraph}>` : "DEFAULT";
  const wrap = (body: string, graph: string | null) => (graph ? `GRAPH <${graph}> { ${body} }` : body);
  if (!statements.length) return { requests: [clear], cleanup: null };
  if (statements.length <= limit) {
    return { requests: [`${clear} ;\nINSERT DATA { ${wrap(statements.join("\n"), namedGraph)} }`], cleanup: null };
  }
  const stagingGraph = `${BKN}staging:${randomUUID()}`;
  return {
    requests: [
      ...chunk(statements, 500).map((group) => `INSERT DATA { ${wrap(group.join("\n"), stagingGraph)} }`),
      `${clear} ;\nADD <${stagingGraph}> TO ${targetRef} ;\nDROP SILENT GRAPH <${stagingGraph}>`,
    ],
    cleanup: `DROP SILENT GRAPH <${stagingGraph}>`,
  };
}
