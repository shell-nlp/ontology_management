import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto";
import { getObjectIndex } from "@/lib/object-index";
import { GraphTargetEntity, platformRepo } from "@/lib/db";
import { writeAuditEntry } from "@/lib/platform-db";
import { describeTargetConflict, findTargetConflict, getTarget, listTargets, parseTargetOptions, publicTarget } from "@/lib/targets";
import { removeTargetSnapshotDirectory } from "@/lib/version-snapshot";

const targetUpdate = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  kind: z.enum(["JENA", "EMBEDDED"]).optional(),
  uri: z.string().trim().url().optional(),
  databaseName: z.string().trim().min(1).max(100).optional(),
  username: z.string().trim().max(100).optional(),
  password: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

export async function PATCH(request: NextRequest, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    if (target.kind === "EMBEDDED") return NextResponse.json({ error: "内置类型图是平台自带资源，无需编辑。" }, { status: 409 });
    const input = targetUpdate.parse(await request.json());
    if (input.kind && input.kind !== target.kind) return NextResponse.json({ error: "不能直接修改存储后端；请新建目标存储并迁移本体。" }, { status: 409 });
    if (Object.keys(input).length === 0) return NextResponse.json({ error: "没有需要更新的字段。" }, { status: 400 });

    // 改连接信息也可能撞到别的本体存储的库上，先按改完之后的样子检查一次。
    const candidate = {
      kind: input.kind ?? target.kind,
      uri: input.uri ?? target.uri,
      database_name: input.databaseName ?? target.database_name,
      options: input.options ? parseTargetOptions(input.options) : target.options,
    };
    const conflict = findTargetConflict(candidate, await listTargets(), targetId);
    if (conflict) return NextResponse.json({ error: describeTargetConflict(conflict, candidate) }, { status: 409 });
    const changes: Partial<GraphTargetEntity> = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.kind !== undefined) changes.kind = input.kind;
    if (input.uri !== undefined) changes.uri = input.uri;
    if (input.databaseName !== undefined) changes.databaseName = input.databaseName;
    if (input.username !== undefined) changes.username = input.username;
    if (input.password !== undefined && input.password.length > 0) changes.credentialSecret = encryptSecret(input.password);
    if (input.options !== undefined) changes.options = parseTargetOptions(input.options);

    const repo = await platformRepo(GraphTargetEntity);
    const result = await repo.update({ id: targetId }, changes);
    if (!result.affected) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_UPDATED", details: { ...input, password: undefined } });
    const updated = await getTarget(targetId);
    return NextResponse.json(publicTarget(updated!));
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法更新本体存储。") }, { status });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    if (target.kind === "EMBEDDED") return NextResponse.json({ error: "内置类型图是平台自带资源，不能删除；如需删除本体，请到本体列表操作。" }, { status: 409 });
    // 审计记录必须先写：graph_targets 删除后审计表的外键就找不到本体存储了。
    await writeAuditEntry({ actorId: user.id, targetId, action: "TARGET_DELETED", details: { name: target.name } });
    const repo = await platformRepo(GraphTargetEntity);
    await repo.delete({ id: targetId });
    await removeTargetSnapshotDirectory(targetId);
    // 检索索引是派生数据，但它的行以 target_id 为键，不跟着本体存储一起删就会留下孤儿。
    // 删本体存储是用户的最终意图，这里失败不挡请求，只留一条审计说明该清没清干净。
    try {
      await getObjectIndex().deleteTargetObjects(targetId);
    } catch (error) {
      await writeAuditEntry({
        actorId: user.id,
        // 本体存储这一行已经删了，审计只能挂空 targetId，把 id 放进 details 里。
        targetId: undefined,
        action: "TARGET_INDEX_CLEANUP_FAILED",
        details: { targetId, name: target.name, error: apiErrorMessage(error, "未知错误") },
      });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法删除本体存储。") }, { status });
  }
}
