import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getTarget } from "@/lib/platform/targets";
import { ensureVersionSnapshot, getVersionRecord, listSnapshotEntities } from "@/lib/versioning/snapshot";
import { withPermission } from "@/lib/platform/route-guard";
import { queryAllObjects, resolveObjectContext } from "@/lib/instance/object-service";

export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
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
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 12), 30);
    const versionId = request.nextUrl.searchParams.get("versionId");
    if (versionId) {
      const version = await getVersionRecord(versionId);
      if (!version) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
      if (version.status === "DRAFT") {
        const snapshot = await ensureVersionSnapshot(versionId, target);
        const results = listSnapshotEntities(snapshot, { search: q, limit: 200 })
          .filter((node) => !labels.length || node.labels.some((label) => labels.includes(label)))
          .slice(0, limit)
          .map((node) => ({ ...node, matched: Object.keys(node.properties), rank: 0 }));
        return NextResponse.json({ results });
      }
    }
    const context = await resolveObjectContext(target.id, versionId ?? undefined);
    const page = await queryAllObjects(context, { labels, text: q, limit, count: false, signal: request.signal });
    return NextResponse.json({
      results: page.rows.map((row, rank) => ({
        id: row.objectId,
        labels: [row.entityType],
        properties: row.properties,
        matched: Object.entries(row.properties).filter(([, value]) => String(value ?? "").toLowerCase().includes(q.toLowerCase())).map(([key]) => key),
        rank,
      })),
      warnings: page.warnings,
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法搜索对象。") }, { status: apiErrorStatus(error) });
  }
});
