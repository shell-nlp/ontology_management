import neo4j, { type Driver } from "neo4j-driver";
import { decryptSecret } from "@/lib/crypto";
import type { Neo4jTarget } from "@/lib/platform-db";

export function createTargetDriver(target: Neo4jTarget): Driver {
  return neo4j.driver(target.uri, neo4j.auth.basic(target.username, decryptSecret(target.credential_secret)));
}

export function containsWriteCypher(cypher: string) {
  return /\b(create|merge|delete|detach|set|remove|drop|alter|rename|grant|revoke|load\s+csv|call\s+apoc\.[^\s]+(?:\.import|\.export|\.periodic))\b/i.test(cypher);
}

export async function executeCypher(target: Neo4jTarget, cypher: string, parameters: Record<string, unknown> = {}) {
  const driver = createTargetDriver(target);
  const session = driver.session({ database: target.database_name });
  try {
    const result = await session.run(cypher, parameters);
    return {
      keys: result.records[0]?.keys ?? [],
      records: result.records.map((record) => record.toObject()),
      summary: result.summary.query.text,
    };
  } finally {
    await session.close();
    await driver.close();
  }
}
