import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { applyStrongRules, ontologyDefinitionSchema, supportsExistenceConstraints, validateOntology } from "@/lib/ontology";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import type { QueryResultRow } from "pg";

type VersionRow = QueryResultRow & { id: string; target_id: string; definition: unknown; status: string };

export async function POST(_: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { versionId } = await context.params;
    const version = await platformQuery<VersionRow>("SELECT id, target_id, definition, status FROM ontology_platform.ontology_versions WHERE id = $1", [versionId]);
    const row = version.rows[0];
    if (!row) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
    if (row.status !== "DRAFT") return NextResponse.json({ error: "只有草稿可以发布。" }, { status: 409 });
    const target = await getTarget(row.target_id);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const definition = ontologyDefinitionSchema.parse(row.definition);
    const violations = await validateOntology(target, definition);
    if (violations.length) return NextResponse.json({ error: "本体草稿未通过校验。", violations }, { status: 422 });
    const canEnforceRequired = await supportsExistenceConstraints(target);
    await applyStrongRules(target, definition);
    await platformQuery("UPDATE ontology_platform.ontology_versions SET status = 'ARCHIVED' WHERE target_id = $1 AND status = 'PUBLISHED'", [row.target_id]);
    await platformQuery("UPDATE ontology_platform.ontology_versions SET status = 'PUBLISHED', published_at = NOW() WHERE id = $1", [row.id]);
    await writeAuditEntry({ actorId: user.id, targetId: row.target_id, action: "ONTOLOGY_PUBLISHED", details: { versionId: row.id, communityEdition: !canEnforceRequired } });
    return NextResponse.json({ published: true, versionId: row.id, communityEdition: !canEnforceRequired });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "本体发布失败。" }, { status: 400 });
  }
}
