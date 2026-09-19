import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { GraphTargetEntity, jsonValue, platformRepo } from "@/lib/db";
import { writeAuditEntry } from "@/lib/platform-db";
import { describeTargetConflict, findTargetConflict, listTargets, parseTargetOptions, publicTarget } from "@/lib/targets";
import { graphTargetKindInfo, type GraphTarget } from "@/lib/graph/types";

const targetInput = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["JENA", "EMBEDDED"]).default("JENA"),
  uri: z.string().trim().url().optional(),
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
    if (input.kind === "EMBEDDED") {
      return NextResponse.json({ error: "内置类型图由平台自动提供，请在新建本体时直接选择。" }, { status: 409 });
    }
    if (input.kind === "JENA" && !input.uri) throw new Error("请填写 Jena 服务地址。");
    const target: GraphTarget = {
      id: crypto.randomUUID(),
      name: input.name,
      kind: input.kind,
      uri: input.uri!,
      database_name: input.databaseName,
      username: input.username,
      credential_secret: encryptSecret(input.password), created_at: new Date(),
      options: parseTargetOptions(input.options),
    };
    // 同一个库上再登记一个，两边发布时会互相清空 —— 这里直接拦下来。
    const conflict = findTargetConflict(target, await listTargets());
    if (conflict) return NextResponse.json({ error: describeTargetConflict(conflict, target) }, { status: 409 });
    const repo = await platformRepo(GraphTargetEntity);
    await repo.insert({
      id: target.id,
      name: target.name,
      kind: target.kind,
      uri: target.uri,
      databaseName: target.database_name,
      username: target.username,
      credentialSecret: target.credential_secret,
      options: jsonValue(target.options),
    });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "TARGET_CREATED", details: { name: target.name, kind: target.kind, uri: target.uri } });
    return NextResponse.json(publicTarget(target), { status: 201 });
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建本体存储。") }, { status });
  }
}
