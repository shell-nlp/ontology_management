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
