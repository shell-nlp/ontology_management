import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { parsePrimaryKeyInput } from "@/lib/object-identity";
import { resolveObjectContext } from "@/lib/object-service";
import { queryLinks } from "@/lib/object-service/links";

/**
 * 关系实例接口（D2）。
 *
 * - `GET /api/links?targetId=&relationshipType=客户拥有账户&limit=200` —— 取某条关系类型的边；
 * - 不加 `relationshipType` 就取**所有配好了数据来源**的关系类型的边；
 * - `entityType=` + `key=列=值&…` 是"以这个对象为起点"：过滤会下推到业务库，用来做一跳展开。
 *
 * 和 `/api/objects` 一样，这一层不认识图库与业务表：定义怎么落成取数由 `@/lib/link-source` 决定。
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const params = request.nextUrl.searchParams;
    const targetId = params.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const context = await resolveObjectContext(targetId, params.get("versionId"));
    const entityType = params.get("entityType")?.trim() ?? "";
    // `key` 可以重复传（`key=列=值&key=列=值`）—— 图谱取一批节点时一次问完，不必每个节点问一遍。
    const keys = params.getAll("key").map((item) => parsePrimaryKeyInput(item.trim())).filter((key) => Object.keys(key).length);
    if (keys.length && !entityType) return NextResponse.json({ error: "按对象取边时 entityType 不能为空。" }, { status: 400 });
    const seed = keys.length ? { entityType, keys } : undefined;
    const limitParam = params.get("limit");
    const result = await queryLinks(context, {
      relationshipType: params.get("relationshipType") ?? undefined,
      seed,
      limit: limitParam === null ? undefined : Number(limitParam),
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取关系实例。") }, { status });
  }
}
