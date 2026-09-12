import { platformQuery } from "@/lib/platform-db";
import { graphTargetKindInfo, isGraphTargetKind, type GraphTarget, type GraphTargetKind } from "@/lib/graph/types";

/**
 * 试连失败的常见原因翻成人话。
 * 驱动抛的是英文原文，直接显示在弹窗里看不出该改哪一项。
 */
export function describeTargetError(kind: GraphTargetKind, error: unknown) {
  const label = graphTargetKindInfo(kind).label;
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot find module|MODULE_NOT_FOUND/i.test(message)) return `缺少 ${label} 驱动，请先安装依赖。`;
  if (/unauthorized|authentication failure|authentication error|Neo\.ClientError\.Security/i.test(message)) return `${label} 认证失败：用户名或密码不对。`;
  if (/ECONNREFUSED|ServiceUnavailable|Could not connect|connection refused|NJS-503/i.test(message)) return `连不上 ${label}：${message}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return `域名解析不了，检查地址里的主机名：${message}`;
  if (/ETIMEDOUT|timeout|timed out/i.test(message)) return `连接超时，检查地址与端口是否可达：${message}`;
  if (/ssl|TLS/i.test(message)) return `TLS/SSL 握手失败，检查是否需要用加密连接：${message}`;
  return `连接 ${label} 失败：${message}`;
}

export async function getTarget(targetId: string): Promise<GraphTarget | null> {
  const result = await platformQuery<GraphTarget>(
    `SELECT id, name, kind, uri, database_name, username, credential_secret, options, created_at
     FROM ontology_platform.graph_targets WHERE id = $1`,
    [targetId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, kind: isGraphTargetKind(row.kind) ? row.kind : "NEO4J", options: (row.options ?? {}) as Record<string, unknown> };
}

export function normalizeTargetKind(value: unknown): GraphTargetKind {
  return isGraphTargetKind(value) ? value : "NEO4J";
}

export function parseTargetOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item)));
}

/** 已登记的本体存储列表；冲突检查与 GET 接口共用一份读取。 */
export async function listTargets(): Promise<GraphTarget[]> {
  const result = await platformQuery<GraphTarget>(
    `SELECT id, name, kind, uri, database_name, username, credential_secret, options, created_at
     FROM ontology_platform.graph_targets ORDER BY kind, name`,
  );
  return result.rows.map((row) => ({
    ...row,
    kind: isGraphTargetKind(row.kind) ? row.kind : "NEO4J",
    options: (row.options ?? {}) as Record<string, unknown>,
  }));
}

/** 端点归一成 host:port：bolt:// 与 neo4j:// 指向同一台机器时算同一个。 */
function endpointKey(kind: GraphTargetKind, uri: string) {
  try {
    const url = new URL(uri);
    return `${url.hostname.toLowerCase()}:${url.port || (kind === "JENA" ? "3030" : "7687")}`;
  } catch {
    return uri.trim().toLowerCase();
  }
}

/**
 * 找出会互相覆盖的已登记本体存储。
 *
 * 发布走的是「整图替换」：Neo4j 是 `MATCH (n) DETACH DELETE n`，Jena 是清掉目标图或默认图。
 * 所以同一个库（Neo4j 的 实例+库名、Jena 的 数据集+命名图）上登记两个本体存储，
 * 发布时会把对方清空 —— 这里提前拦下来，并把「怎么办」写进提示。
 * Neo4j 社区版一个实例只有一个库，多本体要靠多实例（不同端口）。
 */
export function findTargetConflict(
  candidate: Pick<GraphTarget, "kind" | "uri" | "database_name" | "options">,
  existing: GraphTarget[],
  ignoreId?: string,
) {
  const key = (target: Pick<GraphTarget, "kind" | "uri" | "database_name" | "options">) => [
    target.kind,
    endpointKey(target.kind, target.uri),
    (target.database_name ?? "").toLowerCase(),
    target.kind === "JENA" ? String(target.options?.namedGraph ?? "") : "",
  ].join("|");
  const wanted = key(candidate);
  return existing.find((item) => item.id !== ignoreId && key(item) === wanted) ?? null;
}

/** 冲突时给用户看的说明：说清为什么不能这么登记、以及怎么改。 */
export function describeTargetConflict(conflict: GraphTarget, candidate: Pick<GraphTarget, "kind">) {
  const label = graphTargetKindInfo(candidate.kind).label;
  const scope = candidate.kind === "JENA" ? "同一个数据集 / 命名图" : "同一个库";
  const advice = candidate.kind === "NEO4J"
    ? "Neo4j 社区版一个实例只有一个库，发布时是整库替换，两个本体存储会互相清空 —— 请再起一个实例（换一组端口，例如 7475/7688）后登记。"
    : "发布时会清掉这一份图数据，两个本体存储会互相清空 —— 请换一个数据集，或给它们配不同的命名图。";
  return `${scope}上已经登记了「${conflict.name}」（${label}）。${advice}`;
}

export function publicTarget(target: GraphTarget) {
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    kindLabel: graphTargetKindInfo(target.kind).label,
    queryLanguage: graphTargetKindInfo(target.kind).queryLanguage,
    uri: target.uri,
    databaseName: target.database_name,
    username: target.username,
    options: target.options ?? {},
    createdAt: target.created_at,
  };
}
