import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentUser } from "@/lib/auth";
import { containsWriteCypher, executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";
import { writeAuditEntry } from "@/lib/platform-db";

const requestInput = z.object({ targetId: z.string().uuid(), cypher: z.string().trim().min(1).max(50000), parameters: z.record(z.string(), z.unknown()).default({}), confirmWrite: z.boolean().default(false) });

export async function POST(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "未授权。" }, { status: 401 });
    const input = requestInput.parse(await request.json());
    const isWrite = containsWriteCypher(input.cypher);
    if (isWrite && user.role !== "ADMIN") return NextResponse.json({ error: "查看者不能执行写入 Cypher。" }, { status: 403 });
    if (isWrite && !input.confirmWrite) return NextResponse.json({ error: "写入 Cypher 必须单次确认。", confirmationRequired: true }, { status: 409 });
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const result = await executeCypher(target, input.cypher, input.parameters);
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: isWrite ? "CYPHER_WRITE" : "CYPHER_READ", details: { cypher: input.cypher } });
    return NextResponse.json({ ...result, mode: isWrite ? "WRITE" : "READ" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cypher 执行失败。" }, { status: 400 });
  }
}
