import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { parsePrimaryKeyInput } from "@/lib/object-identity";
import { ensureObjectInDraft, resolveObjectContext } from "@/lib/object-service";
import { getTarget } from "@/lib/targets";
import { getVersionRecord } from "@/lib/version-snapshot";

const materializeInput = z.object({
  targetId: z.string().uuid(),
  /** 写进哪个草稿版本；不传就用当前草稿（没有草稿时报错，界面会先建草稿）。 */
  versionId: z.string().uuid().optional(),
  entityType: z.string().trim().min(1).max(200),
  /** 主键串：`列=值&列=值`。 */
  key: z.string().trim().min(1).max(500),
});

/**
 * 把数据资源里的一个对象**取进草稿快照**。
 *
 * 用途：对象页与动作页都要"编辑 / 执行动作"，而这两件事作用在草稿快照上；
 * 数据源里的对象本体里没有副本，所以先按主键取进来（身份是确定性的，重复取不会造出第二份）。
 * 这是**平台自己的草稿写入**，不写业务库 —— 回写是另一件事（动作写回，尚未实现）。
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const input = materializeInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const draft = input.versionId ? await getVersionRecord(input.versionId) : null;
    if (input.versionId && (!draft || draft.target_id !== input.targetId)) {
      return NextResponse.json({ error: "草稿不存在或不属于当前本体存储。" }, { status: 404 });
    }
    if (input.versionId && draft?.status !== "DRAFT") {
      return NextResponse.json({ error: "只有草稿版本可以写入，请先创建草稿。" }, { status: 409 });
    }
    const context = await resolveObjectContext(input.targetId, input.versionId);
    const result = await ensureObjectInDraft(context, input.versionId ?? context.versionId ?? "", input.entityType, parsePrimaryKeyInput(input.key));
    return NextResponse.json({ record: result.record, created: result.created, warnings: result.warnings });
  } catch (error) {
    const unauthorized = isUnauthorized(error);
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "取进草稿失败。");
    return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
  }
}
