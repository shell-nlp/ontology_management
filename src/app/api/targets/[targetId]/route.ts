import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { getTarget, publicTarget } from "@/lib/targets";
import { removeTargetSnapshotDirectory } from "@/lib/version-snapshot";

const targetUpdate = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  uri: z.string().trim().url().optional(),
  databaseName: z.string().trim().min(1).max(100).optional(),
  username: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(1).optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const input = targetUpdate.parse(await request.json());
    if (Object.keys(input).length === 0) return NextResponse.json({ error: "没有需要更新的字段。" }, { status: 400 });

    const updates: string[] = [];
    const values: unknown[] = [];
    if (input.name !== undefined) { updates.push(`name = $${updates.length + 1}`); values.push(input.name); }
    if (input.uri !== undefined) { updates.push(`uri = $${updates.length + 1}`); values.push(input.uri); }
    if (input.databaseName !== undefined) { updates.push(`database_name = $${updates.length + 1}`); values.push(input.databaseName); }
    if (input.username !== undefined) { updates.push(`username = $${updates.length + 1}`); values.push(input.username); }
    if (input.password !== undefined && input.password.length > 0) { updates.push(`credential_secret = $${updates.length + 1}`); values.push(encryptSecret(input.password)); }
    values.push(targetId);

    const result = await platformQuery<{ id: string }>(
      `UPDATE ontology_platform.neo4j_targets SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING id`,
      values,
    );
    if (result.rows.length === 0) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_UPDATED", details: { ...input, password: undefined } });
    const updated = await getTarget(targetId);
    return NextResponse.json(publicTarget(updated!));
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法更新目标。" }, { status });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    await platformQuery("DELETE FROM ontology_platform.neo4j_targets WHERE id = $1", [targetId]);
    await removeTargetSnapshotDirectory(targetId);
    await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_DELETED", details: { name: target.name } });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法删除目标。" }, { status });
  }
}
