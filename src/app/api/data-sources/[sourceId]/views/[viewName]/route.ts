import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getDataSource, openDataSource } from "@/lib/data-sources";

/** 一个表/视图的字段清单与若干行预览；两条都只读，不改来源里的任何数据。 */
export async function GET(request: NextRequest, context: { params: Promise<{ sourceId: string; viewName: string }> }) {
  try {
    await requireRole("VIEWER");
    const { sourceId, viewName } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    if (!source.enabled) return NextResponse.json({ error: "这个数据资源已停用，先启用再读取字段。" }, { status: 400 });
    const schema = request.nextUrl.searchParams.get("schema") ?? undefined;
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
    const name = decodeURIComponent(viewName);
    const connector = await openDataSource(source);
    const [fields, preview] = await Promise.all([
      connector.describeView({ schema, name }),
      connector.previewView({ schema, name }, limit),
    ]);
    return NextResponse.json({ fields, preview });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取表结构。" }, { status: 400 });
  }
}
