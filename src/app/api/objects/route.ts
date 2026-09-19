import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { parsePrimaryKeyInput } from "@/lib/object-identity";
import { getObject, queryObjects, resolveObjectContext } from "@/lib/object-service";

const filterSchema = z.object({
  property: z.string().trim().min(1).max(200),
  operator: z.enum(["EQ", "NE", "CONTAINS", "GT", "LT", "IN", "EXISTS"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(200)]).optional(),
});

/**
 * 对象服务接口（S2）。
 *
 * - `GET /api/objects?targetId=&entityType=&key=列=值&…` —— 按主键取一个对象；
 * - `GET /api/objects?targetId=&entityType=&text=&filter=…` —— 检索 / 过滤 / 分页；
 * - `origin=auto|index|source` 决定"看索引"还是"回业务库取"，默认 auto。
 *
 * 这一层不认识图库、索引表或业务表：全交给 `@/lib/object-service`，
 * 换中间件时这里一行都不用改。
 */
function parseFilters(values: string[]) {
  const filters: z.infer<typeof filterSchema>[] = [];
  for (const raw of values) {
    // 形如 `CUST_ID:EQ:1001`；值里可以带冒号（只按前两个冒号切）。
    const first = raw.indexOf(":");
    const second = raw.indexOf(":", first + 1);
    if (first <= 0 || second <= first) continue;
    const property = raw.slice(0, first).trim();
    const operator = raw.slice(first + 1, second).trim().toUpperCase();
    const value = raw.slice(second + 1);
    const parsed = filterSchema.safeParse({
      property,
      operator,
      value: operator === "IN" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
    });
    if (parsed.success) filters.push(parsed.data);
  }
  return filters;
}

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const params = request.nextUrl.searchParams;
    const targetId = params.get("targetId");
    const entityType = params.get("entityType");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    if (!entityType) return NextResponse.json({ error: "entityType 不能为空。" }, { status: 400 });
    const origin = (params.get("origin") ?? "auto") as "auto" | "index" | "source";
    const context = await resolveObjectContext(targetId, params.get("versionId"));

    const key = params.get("key");
    if (key) {
      const record = await getObject(context, entityType, parsePrimaryKeyInput(key), { origin });
      if (!record) return NextResponse.json({ error: "没有找到这个对象。", entityType, key }, { status: 404 });
      return NextResponse.json({ object: record, origin: record.origin });
    }

    const toNumber = (value: string | null) => (value === null ? undefined : Number(value));
    const result = await queryObjects(context, {
      entityType,
      text: params.get("text") ?? undefined,
      filters: parseFilters(params.getAll("filter")),
      limit: toNumber(params.get("limit")),
      offset: toNumber(params.get("offset")),
      origin,
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取对象。") }, { status });
  }
}
