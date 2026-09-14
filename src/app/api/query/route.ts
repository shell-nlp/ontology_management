import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, currentUser } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";
import { writeAuditEntry } from "@/lib/platform-db";

/**
 * 后端无关的只读查询入口。
 * Apache Jena 本体存储执行 SPARQL（只读）；
 * 写入一律走草稿快照 + 发布流程，这里不接受任何写语句。
 */
const requestInput = z.object({
  targetId: z.string().uuid(),
  query: z.string().trim().min(1).max(50000).optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  confirmWrite: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "未授权。" }, { status: 401 });
    const input = requestInput.parse(await request.json());
    const statement = input.query;
    if (!statement) return NextResponse.json({ error: "查询语句不能为空。" }, { status: 400 });
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const store = getGraphStore(target);
    if (store.containsWriteStatement(statement)) {
      return NextResponse.json({ error: `版本管理启用后禁止直接写 ${store.info.label}。请修改草稿快照并通过发布生效。` }, { status: 409 });
    }
    const result = await store.execute(statement, input.parameters, { readOnly: true });
    await writeAuditEntry({ actorId: user.id, targetId: target.id, action: "GRAPH_QUERY_READ", details: { language: store.info.queryLanguage, query: statement } });
    return NextResponse.json({ ...result, mode: "READ", queryLanguage: store.info.queryLanguage });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "查询执行失败。") }, { status: 400 });
  }
}
