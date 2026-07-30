import { platformQuery, type Neo4jTarget } from "@/lib/platform-db";

export async function getTarget(targetId: string) {
  const result = await platformQuery<Neo4jTarget>(
    `SELECT id, name, uri, database_name, username, credential_secret, created_at
     FROM ontology_platform.neo4j_targets WHERE id = $1`,
    [targetId],
  );
  return result.rows[0] ?? null;
}

export function publicTarget(target: Neo4jTarget) {
  return {
    id: target.id,
    name: target.name,
    uri: target.uri,
    databaseName: target.database_name,
    username: target.username,
    createdAt: target.created_at,
  };
}
