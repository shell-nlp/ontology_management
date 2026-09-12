import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getGraphStore } from "@/lib/graph";
import { getTarget } from "@/lib/targets";
import { getPublishedOntology } from "@/lib/published-ontology";
import { ensureVersionSnapshot, listSnapshotEntities } from "@/lib/version-snapshot";

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
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    let labels: string[] = [];
    if (labelParam) {
      try {
        const parsed = JSON.parse(labelParam);
        labels = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
      } catch {
        labels = [];
      }
    }
    const displayProps: Record<string, string> = {};
    try {
      const ontology = await getPublishedOntology(target.id);
      for (const item of ontology.entityTypes) if (item.displayProperty) displayProps[item.name] = item.displayProperty;
    } catch {
      // 未发布本体时按任意属性搜索并仅按属性值排序
    }
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 12), 30);
    const versionId = request.nextUrl.searchParams.get("versionId");
    if (versionId) {
      const snapshot = await ensureVersionSnapshot(versionId, target);
      const results = listSnapshotEntities(snapshot, { search: q, limit: 200 })
        .filter((node) => !labels.length || node.labels.some((label) => labels.includes(label)))
        .slice(0, limit)
        .map((node) => ({ ...node, matched: Object.keys(node.properties), rank: 0 }));
      return NextResponse.json({ results });
    }
    const results = await getGraphStore(target).searchEntities({ search: q, labels, limit, displayProperties: displayProps });
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法搜索对象。" }, { status: 400 });
  }
}
