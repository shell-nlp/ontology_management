import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { getObjectIndex } from "@/lib/object-index";
import { getTarget } from "@/lib/targets";

const filterSchema = z.object({
  property: z.string().trim().min(1).max(200),
  operator: z.enum(["EQ", "NE", "CONTAINS", "GT", "LT", "IN", "EXISTS"]),
  value: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(500)).max(200)]).optional(),
});

const searchSchema = z.object({
  targetId: z.string().uuid(),
  labels: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  text: z.string().max(200).optional(),
  filters: z.array(filterSchema).max(20).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  vector: z.array(z.number()).min(1).max(4096).optional(),
});

function fail(error: unknown, fallback: string) {
  const unauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
  const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? fallback) : error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: unauthorized ? "未授权。" : message }, { status: unauthorized ? 401 : 400 });
}

/**
 * 对象检索：全文 + 模糊 + 属性过滤，可选向量。
 * 这一层不碰图库，读的是 PostgreSQL 里的派生索引，因此对图后端是中立的。
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const input = searchSchema.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const result = await getObjectIndex().searchObjects(input);
    return NextResponse.json(result);
  } catch (error) {
    return fail(error, "检索对象失败。");
  }
}

/** 索引状态与能力：条目数、按类的分布、以及全文/模糊/向量是否可用。 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    const index = getObjectIndex();
    const [capabilities, stats] = await Promise.all([index.capabilities(), index.stats(targetId)]);
    return NextResponse.json({ capabilities, stats });
  } catch (error) {
    return fail(error, "读取检索索引状态失败。");
  }
}
