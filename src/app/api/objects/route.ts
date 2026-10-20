import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { parsePrimaryKeyInput } from "@/lib/ontology/object-identity";
import { getObject, queryAllObjects, queryObjects, resolveObjectContext } from "@/lib/instance/object-service";
import { withPermission } from "@/lib/platform/route-guard";

const filterSchema = z.object({
  property: z.string().trim().min(1).max(200),
  operator: z.enum(["EQ", "NE", "CONTAINS", "GT", "LT", "IN", "EXISTS"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(200)]).optional(),
});

/**
 * 对象服务接口（S2）。
 *
 * - `GET /api/objects?targetId=&entityType=&key=列=值&…` —— 按主键取一个对象；
 * - `GET /api/objects?targetId=&entityType=&text=&filter=…&sort=…` —— 检索 / 过滤 / 排序 / 分页；
 * - `GET /api/objects?targetId=&entityType=&batch=1&key=…&key=…` —— 批量按主键取对象（支持复合主键）；
 * - `GET /api/objects?targetId=&text=…`（不带 entityType）—— 「全部标签」：逐类型有界虚拟查询；
 * - 旧 `origin=auto|index|source` 兼容接受，普通读取统一查询当前来源。
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
    if (first <= 0 || second <= first) throw new Error("筛选必须使用 属性:算子:值 格式。");
    const property = raw.slice(0, first).trim();
    const operator = raw.slice(first + 1, second).trim().toUpperCase();
    const value = raw.slice(second + 1);
    const parsed = filterSchema.safeParse({
      property,
      operator,
      value: operator === "IN" ? value.split(",").map((item) => item.trim()).filter(Boolean) : value,
    });
    if (!parsed.success) throw new Error(`筛选「${property}」不合法，请检查属性、算子与取值。`);
    filters.push(parsed.data);
  }
  return filters;
}

/** 形如 `sort=信用分:DESC`；重复传多列，按出现顺序生成 ORDER BY。 */
function parseSort(values: string[]) {
  const sort: { property: string; direction: "ASC" | "DESC" }[] = [];
  for (const raw of values) {
    const index = raw.lastIndexOf(":");
    const property = (index < 0 ? raw : raw.slice(0, index)).trim();
    if (!property) continue;
    const requested = index < 0 ? "ASC" : raw.slice(index + 1).trim().toUpperCase();
    if (requested !== "ASC" && requested !== "DESC") throw new Error("排序方向只能为 ASC 或 DESC。");
    const direction = requested;
    sort.push({ property, direction });
  }
  return sort.slice(0, 10);
}

export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const params = request.nextUrl.searchParams;
    const targetId = params.get("targetId");
    const entityType = params.get("entityType");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const origin = z.enum(["auto", "index", "source"]).parse(params.get("origin") ?? "auto");
    const context = await resolveObjectContext(targetId, params.get("versionId"));

    const toNumber = (value: string | null) => (value === null ? undefined : Number(value));
    // 全部标签按定义顺序查询每个类型的当前页，不加载全部源行。
    if (!entityType) {
      const all = await queryAllObjects(context, {
        text: params.get("text") ?? undefined,
        limit: toNumber(params.get("limit")),
        offset: toNumber(params.get("offset")),
      });
      return NextResponse.json(all);
    }

    const keys = params.getAll("key");
    const key = keys[0];
    if (key && params.get("batch") !== "1") {
      const record = await getObject(context, entityType, parsePrimaryKeyInput(key), { origin });
      if (!record) return NextResponse.json({ error: "没有找到这个对象。", entityType, key }, { status: 404 });
      return NextResponse.json({ object: record, origin: record.origin });
    }
    const result = await queryObjects(context, {
      entityType,
      text: params.get("text") ?? undefined,
      filters: parseFilters(params.getAll("filter")),
      keys: params.get("batch") === "1" ? keys.map(parsePrimaryKeyInput) : undefined,
      sort: parseSort(params.getAll("sort")),
      limit: toNumber(params.get("limit")),
      offset: toNumber(params.get("offset")),
      origin,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取对象。") }, { status: apiErrorStatus(error) });
  }
});
