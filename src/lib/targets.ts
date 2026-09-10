import { platformQuery } from "@/lib/platform-db";
import { graphTargetKindInfo, isGraphTargetKind, type GraphTarget, type GraphTargetKind } from "@/lib/graph/types";

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
