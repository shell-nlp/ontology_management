import { objectKeyOf } from "@/lib/ontology/object-identity";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isUnauthorized } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { withPermission } from "@/lib/platform/route-guard";
import { queryAllObjects, queryObjects, resolveObjectContext } from "@/lib/instance/object-service";

const filterSchema = z.object({
  property: z.string().trim().min(1).max(200),
  operator: z.enum(["EQ", "NE", "CONTAINS", "GT", "LT", "IN", "EXISTS"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(200)]).optional(),
});
const sortSchema = z.object({
  property: z.string().trim().min(1).max(200),
  direction: z.enum(["ASC", "DESC"]).default("ASC"),
  dataType: z.enum(["TEXT", "INTEGER", "DECIMAL", "BOOLEAN", "DATE", "DATETIME", "TEXT_ARRAY", "JSON"]).optional(),
});

const searchSchema = z.object({
  targetId: z.string().uuid(),
  versionId: z.string().uuid().optional(),
  labels: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  text: z.string().max(200).optional(),
  filters: z.array(filterSchema).max(20).optional(),
  sort: z.array(sortSchema).max(10).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  vector: z.array(z.number()).min(1).max(4096).optional(),
});

function fail(error: unknown, fallback: string) {
  const unauthorized = isUnauthorized(error);
  const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? fallback) : error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
}

/**
 * 对象检索兼容入口，统一走当前版本的虚拟对象服务。
 */
export const POST = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const input = searchSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const context = await resolveObjectContext(input.targetId, input.versionId);
    if (input.vector) throw new Error("虚拟对象查询尚不支持向量检索，请使用文本或属性筛选。");
    if ((input.filters?.length || input.sort?.length) && input.labels?.length !== 1) throw new Error("跨类型属性筛选或排序需要先指定一个对象类型。");
    const result = input.labels?.length === 1
      ? await queryObjects(context, { entityType: input.labels[0], text: input.text, filters: input.filters, sort: input.sort, limit: input.limit, offset: input.offset })
      : await queryAllObjects(context, { labels: input.labels, text: input.text, limit: input.limit, offset: input.offset });
    return NextResponse.json({
      hits: result.rows.map((row) => ({ objectId: row.objectId, objectKey: objectKeyOf(row.entityType, row.primaryKey), entityType: row.entityType, labels: [row.entityType], title: row.title, properties: row.properties, primaryKey: row.primaryKey, score: 0 })),
      total: result.total, tookMs: result.tookMs, textMode: "source", vectorUsed: false, warnings: result.warnings,
    });

  } catch (error) {
    return fail(error, "检索对象失败。");
  }
});
