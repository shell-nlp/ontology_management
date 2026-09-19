import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { getDataSource, openDataSource } from "@/lib/data-sources";
import { cachedStructure } from "@/lib/data-source/structure-cache";
import type { DataViewSummary } from "@/lib/data-source/types";

/** 清单里最多回这么多条；缓存里存的就是这一份，调用方再按 search / limit 自己收口。 */
const CATALOG_LIMIT_MAX = 5000;

/**
 * 结构清单：这个来源里有哪些表和视图。
 *
 * **默认从平台库取**（`data_sources.catalog` 里那一份）：只有 `refresh=1` 才回源库重读，
 * 读完顺手存回平台库。远端 Oracle 扫一次数据字典要几秒，不该每点一次都扫。
 */
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
    // 范围：登记的模式，或 "*"（界面上「全部模式」，看这个库里的所有模式）。
    const allScope = schema === "*";
    const scopeKey = allScope ? "*" : source.schema_name || "";
    const hit = await cachedStructure<{ objects: DataViewSummary[] }>({
      sourceId: source.id,
      bucket: "catalog",
      key: scopeKey,
      refresh,
      fetch: async () => {
        const connector = await openDataSource(source);
        return { objects: await connector.listViews({ schema: allScope ? "*" : scopeKey, limit: CATALOG_LIMIT_MAX, refresh: true }) };
      },
    });
    const needle = search?.trim().toLowerCase() ?? "";
    const views = hit.value.objects
      .filter((item) => !needle || item.name.toLowerCase().includes(needle))
      .slice(0, Math.max(1, Math.min(Number.isFinite(limit) ? limit : 500, CATALOG_LIMIT_MAX)));
    return NextResponse.json({
      views,
      container: source.schema_name || source.database_name,
      // 让界面能写出"这份结构是什么时候读回来的"，而不是让人猜。
      fetched_at: hit.fetchedAt,
      from_cache: hit.fromCache,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取结构清单。") }, { status: 400 });
  }
}
