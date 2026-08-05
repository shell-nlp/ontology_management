import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    const q = (request.nextUrl.searchParams.get("q") ?? "").trim();
    const labelParam = request.nextUrl.searchParams.get("labels");
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "12");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    if (!q) return NextResponse.json({ results: [] });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    let labels: string[] = [];
    if (labelParam) {
      try {
        const parsed = JSON.parse(labelParam);
        labels = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch {
        labels = [];
      }
    }
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 12), 30);
    const labelClause = labels.length > 0 ? "AND any(l IN $labels WHERE l IN labels(n))\n       " : "";
    const result = await executeCypher(
      target,
      `MATCH (n)
       WHERE any(k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS toLower($q))
       ${labelClause}WITH n, [k IN keys(n) WHERE toLower(toString(n[k])) CONTAINS toLower($q) | k] AS matched
       RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties, matched,
              CASE WHEN any(k IN matched WHERE toLower(toString(n[k])) = toLower($q)) THEN 0
                   WHEN any(k IN matched WHERE toLower(toString(n[k])) STARTS WITH toLower($q)) THEN 1
                   ELSE 2 END AS rank
       ORDER BY rank, size(matched) DESC, id
       LIMIT ${limit}`,
      { q, labels },
    );
    return NextResponse.json({ results: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法搜索实体。" }, { status: 400 });
  }
}
