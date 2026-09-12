import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { getDataSource, openDataSource } from "@/lib/data-sources";

/** 试连：只做一次连接与版本探测，不读业务数据。 */
export async function POST(_request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    // 试连只读一次服务端版本，不改任何东西，看过结构的人都能测。
    await requireRole("VIEWER");
    const { sourceId } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    if (!source.enabled) return NextResponse.json({ error: "这个数据资源已停用，先启用再测试。" }, { status: 400 });
    const connector = await openDataSource(source);
    const health = await connector.test();
    return NextResponse.json({ ...health, kind: source.kind });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "连接失败。") }, { status: 400 });
  }
}
