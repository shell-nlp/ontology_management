import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { platformQuery, writeAuditEntry, type Neo4jTarget } from "@/lib/platform-db";
import { publicTarget } from "@/lib/targets";

const targetInput = z.object({ name: z.string().trim().min(2).max(100), uri: z.string().trim().url(), databaseName: z.string().trim().min(1).max(100).default("neo4j"), username: z.string().trim().min(1).max(100), password: z.string().min(1) });

export async function GET() {
  try {
    await requireRole("VIEWER");
    const targets = await platformQuery<Neo4jTarget>("SELECT id, name, uri, database_name, username, credential_secret, created_at FROM ontology_platform.neo4j_targets ORDER BY name");
    return NextResponse.json(targets.rows.map(publicTarget));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "UNAUTHORIZED" ? "未授权。" : "无法读取 Neo4j 目标。" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = targetInput.parse(await request.json());
    const target: Neo4jTarget = {
      id: crypto.randomUUID(), name: input.name, uri: input.uri, database_name: input.databaseName, username: input.username,
      credential_secret: encryptSecret(input.password), created_at: new Date(),
    };
    await platformQuery(
      `INSERT INTO ontology_platform.neo4j_targets (id, name, uri, database_name, username, credential_secret)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [target.id, target.name, target.uri, target.database_name, target.username, target.credential_secret],
    );
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "TARGET_CREATED", details: { name: target.name, uri: target.uri } });
    return NextResponse.json(publicTarget(target), { status: 201 });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建目标。" }, { status });
  }
}
