import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { normalizeTargetKind, parseTargetOptions, publicTarget } from "@/lib/targets";
import { graphTargetKindInfo, type GraphTarget } from "@/lib/graph/types";

const targetInput = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["NEO4J", "JENA"]).default("NEO4J"),
  uri: z.string().trim().url(),
  databaseName: z.string().trim().min(1).max(100).default("neo4j"),
  username: z.string().trim().max(100).default(""),
  password: z.string().max(500).default(""),
  options: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, context) => {
  if (value.kind !== "NEO4J") return;
  if (!value.username) context.addIssue({ code: z.ZodIssueCode.custom, path: ["username"], message: "Neo4j 目标必须填写用户名。" });
  if (!value.password) context.addIssue({ code: z.ZodIssueCode.custom, path: ["password"], message: "Neo4j 目标必须填写密码。" });
});

export async function GET() {
  try {
    await requireRole("VIEWER");
    const targets = await platformQuery<GraphTarget>("SELECT id, name, kind, uri, database_name, username, credential_secret, options, created_at FROM ontology_platform.graph_targets ORDER BY kind, name");
    return NextResponse.json(targets.rows.map(publicTarget));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "UNAUTHORIZED" ? "未授权。" : "无法读取连接目标。" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = targetInput.parse(await request.json());
    const target: GraphTarget = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: normalizeTargetKind(input.kind),
      uri: input.uri,
      database_name: input.databaseName,
      username: input.username,
      credential_secret: encryptSecret(input.password), created_at: new Date(),
      options: parseTargetOptions(input.options),
    };
    await platformQuery(
      `INSERT INTO ontology_platform.graph_targets (id, name, kind, uri, database_name, username, credential_secret, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [target.id, target.name, target.kind, target.uri, target.database_name, target.username, target.credential_secret, JSON.stringify(target.options)],
    );
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "TARGET_CREATED", details: { name: target.name, kind: target.kind, uri: target.uri } });
    return NextResponse.json(publicTarget(target), { status: 201 });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建目标。" }, { status });
  }
}
