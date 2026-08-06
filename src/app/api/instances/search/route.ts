import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { executeCypher } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";
import { getPublishedOntology } from "@/lib/published-ontology";

function safeText(expr: string) {
  return `CASE WHEN ${expr} IS NULL THEN '' ELSE reduce(s = '', item IN ${expr} | s + CASE WHEN item IS NULL THEN '' ELSE toString(item) END + ' ') END`;
}

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
    let displayProps: Record<string, string> = {};
    try {
      const ontology = await getPublishedOntology(target.id);
      for (const item of ontology.entityTypes) if (item.displayProperty) displayProps[item.name] = item.displayProperty;
    } catch {
      // 未发布本体时按任意属性搜索并仅按属性值排序
    }
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 12), 30);
    const labelClause = labels.length > 0 ? "AND any(l IN $labels WHERE l IN labels(n))\n       " : "";
    const displayName = `reduce(d = '', label IN labels(n) | CASE WHEN d <> '' THEN d WHEN label IN keys($displayProps) AND n[$displayProps[label]] IS NOT NULL THEN ${safeText("n[$displayProps[label]]")} ELSE d END)`;
    const valueMatch = `any(k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($q))`;
    const result = await executeCypher(
      target,
      `MATCH (n)
       WHERE ${valueMatch}
       ${labelClause}WITH n, [k IN keys(n) WHERE toLower(${safeText("n[k]")}) CONTAINS toLower($q) | k] AS matched, ${displayName} AS displayName
       RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS properties, matched,
              CASE WHEN toLower(displayName) = toLower($q) THEN 0
                   WHEN toLower(displayName) STARTS WITH toLower($q) THEN 1
                   WHEN any(k IN matched WHERE toLower(${safeText("n[k]")}) = toLower($q)) THEN 2
                   WHEN toLower(displayName) CONTAINS toLower($q) THEN 3
                   WHEN any(k IN matched WHERE toLower(${safeText("n[k]")}) STARTS WITH toLower($q)) THEN 4
                   ELSE 5 END AS rank
       ORDER BY rank, size(matched) DESC, id
       LIMIT ${limit}`,
      { q, labels, displayProps },
    );
    return NextResponse.json({ results: result.records });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法搜索实体。" }, { status: 400 });
  }
}
