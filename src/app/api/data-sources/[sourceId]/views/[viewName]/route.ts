import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { getDataSource, openDataSource } from "@/lib/data-sources";
import { cachedStructure } from "@/lib/data-source/structure-cache";
import type { DataViewField, DataViewPreview } from "@/lib/data-source/types";

/**
 * 一个表/视图的字段清单与若干行预览；两条都只读，不改来源里的任何数据。
 *
 * 和结构清单一样**默认读平台库里的那一份**（`refresh=1` 才回源库重读）：
 * 字段清单一天也未必变一次，样本行也只是给人一个"长什么样"的印象，
 * 真的要看最新数据用「重新取数」或 run_sql。
 */
export async function GET(request: NextRequest, context: { params: Promise<{ sourceId: string; viewName: string }> }) {
  try {
    await requireRole("VIEWER");
    const { sourceId, viewName } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    if (!source.enabled) return NextResponse.json({ error: "这个数据资源已停用，先启用再读取字段。" }, { status: 400 });
    const schema = request.nextUrl.searchParams.get("schema") ?? undefined;
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
    const refresh = request.nextUrl.searchParams.get("refresh") === "1";
    const name = decodeURIComponent(viewName);
    // 样本行数进了缓存键：20 行和 100 行是两份不同的快照，别互相顶掉。
    const key = `${schema ?? source.schema_name ?? ""}.${name}@${limit}`;
    const hit = await cachedStructure<{ fields: DataViewField[]; preview: DataViewPreview }>({
      sourceId: source.id,
      bucket: "views",
      key,
      refresh,
      fetch: async () => {
        const connector = await openDataSource(source);
        const [fields, preview] = await Promise.all([
          connector.describeView({ schema, name }),
          connector.previewView({ schema, name }, limit),
        ]);
        return { fields, preview };
      },
    });
    return NextResponse.json({ ...hit.value, fetched_at: hit.fetchedAt, from_cache: hit.fromCache });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取表结构。") }, { status: 400 });
  }
}
