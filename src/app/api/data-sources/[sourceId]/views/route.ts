import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { getDataSource, openDataSource } from "@/lib/data-sources";

/** 结构清单：这个来源里有哪些表和视图。 */
export async function GET(request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { sourceId } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    if (!source.enabled) return NextResponse.json({ error: "这个数据资源已停用，先启用再读取结构。" }, { status: 400 });
    const search = request.nextUrl.searchParams.get("search") ?? undefined;
    const schema = request.nextUrl.searchParams.get("schema") ?? undefined;
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "500");
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const connector = await openDataSource(source);
    const views = await connector.listViews({ search, schema, limit, refresh });
    return NextResponse.json({ views, container: source.schema_name || source.database_name });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取结构清单。") }, { status: 400 });
  }
}
