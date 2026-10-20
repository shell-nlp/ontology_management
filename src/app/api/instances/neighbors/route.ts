import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { getObject, resolveObjectContext } from "@/lib/instance/object-service";
import { readEditSnapshot } from "@/lib/instance/object-service/edit-overlay";
import { primaryKeyFromProperties } from "@/lib/ontology/object-identity";
import { withPermission } from "@/lib/platform/route-guard";

/** 版本本地关系的一度邻居；业务关系通过 /api/links 按完整主键展开。 */
export const GET = withPermission("instance.read", async (request: NextRequest) => {
  try {
    const targetId = request.nextUrl.searchParams.get("targetId");
    const nodeId = request.nextUrl.searchParams.get("nodeId");
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "200");
    if (!targetId || !nodeId) return NextResponse.json({ error: "targetId 与 nodeId 不能为空。" }, { status: 400 });
    const context = await resolveObjectContext(targetId, request.nextUrl.searchParams.get("versionId"));
    const snapshot = await readEditSnapshot(context);
    const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 200;
    const links = (snapshot?.relationships ?? []).filter((link) => link.sourceId === nodeId || link.targetId === nodeId).slice(0, limit);
    const ids = new Set([nodeId, ...links.flatMap((link) => [link.sourceId, link.targetId])]);
    const nodes = [];
    for (const node of snapshot?.nodes ?? []) {
      if (!ids.has(node.id)) continue;
      const type = context.definition.entityTypes.find((item) => node.labels.includes(item.name));
      if (!type) continue;
      const key = primaryKeyFromProperties(type, node.properties);
      const record = key.missing.length || !Object.keys(key.primaryKey).length ? null : await getObject(context, type.name, key.primaryKey);
      if (record) nodes.push({ id: record.objectId, labels: [record.entityType], properties: record.properties });
    }
    const visible = new Set(nodes.map((node) => node.id));
    return NextResponse.json({ nodes, relationships: links.filter((link) => visible.has(link.sourceId) && visible.has(link.targetId)).map((link) => ({ id: link.id, type: link.type, source: link.sourceId, target: link.targetId, properties: link.properties })) });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法扩展邻居。") }, { status: apiErrorStatus(error) });
  }
});
