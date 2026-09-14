import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { describeTargetConflict, findTargetConflict, listTargets, parseTargetOptions, publicTarget } from "@/lib/targets";
import { graphTargetKindInfo, type GraphTarget } from "@/lib/graph/types";

const targetInput = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["JENA"]).default("JENA"),
  uri: z.string().trim().url(),
  databaseName: z.string().trim().min(1).max(100).default("ds"),
  username: z.string().trim().max(100).default(""),
  password: z.string().max(500).default(""),
  options: z.record(z.string(), z.unknown()).default({}),
});

export async function GET() {
  try {
    await requireRole("VIEWER");
    const targets = await listTargets();
    return NextResponse.json(targets.map(publicTarget));
  } catch (error) {
    return NextResponse.json({ error: isUnauthorized(error) ? "未授权。" : "无法读取本体存储。" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = targetInput.parse(await request.json());
    const target: GraphTarget = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      uri: input.uri,
      database_name: input.databaseName,
      username: input.username,
      credential_secret: encryptSecret(input.password), created_at: new Date(),
      options: parseTargetOptions(input.options),
    };
    // 同一个库上再登记一个，两边发布时会互相清空 —— 这里直接拦下来。
    const conflict = findTargetConflict(target, await listTargets());
    if (conflict) return NextResponse.json({ error: describeTargetConflict(conflict, target) }, { status: 409 });
    await platformQuery(
      `INSERT INTO ontology_platform.graph_targets (id, name, kind, uri, database_name, username, credential_secret, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [target.id, target.name, target.kind, target.uri, target.database_name, target.username, target.credential_secret, JSON.stringify(target.options)],
    );
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "TARGET_CREATED", details: { name: target.name, kind: target.kind, uri: target.uri } });
    return NextResponse.json(publicTarget(target), { status: 201 });
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建本体存储。") }, { status });
  }
}
